/**
 * Custom dash autoformat, gated on the `customDash*` settings (default off).
 *
 * As you type the third hyphen of `---`, it's replaced with the configured dash
 * output (en/em dash, with or without surrounding spaces). Converting on the
 * third hyphen — rather than waiting for the next character — is why only `---`
 * is offered: a `--` rule would have to fire on the second hyphen and could
 * never tell a forthcoming `---` apart.
 *
 * Word-parity revert: pressing Backspace immediately after the substitution
 * restores the literal `---` (rather than deleting a character). The pending
 * revert is tracked in plugin state and invalidated by the very next
 * transaction, so it only applies to the keystroke right after the substitution.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { settings } from './settings.js';
import type { Settings } from './settings.js';

/** The literal string each dash style produces. Spaced variants use a regular
 *  space on each side. */
const DASH_OUTPUT: Record<Settings['customDashStyle'], string> = {
  en: '–',
  'en-spaced': ' – ',
  em: '—',
  'em-spaced': ' — ',
};

/** The output string for the current `customDashStyle`. Exported for tests. */
export function dashOutput(): string {
  return DASH_OUTPUT[settings.get('customDashStyle')];
}

/** A pending Backspace-revert: the dash output sits at [from, to); Backspace
 *  there restores the literal `---`. */
interface CustomDashState {
  undo: { from: number; to: number } | null;
}

type Meta = { type: 'converted'; from: number; to: number };

export const customDashKey = new PluginKey<CustomDashState>('pmd-custom-dash');

export function customDashPlugin(): Plugin<CustomDashState> {
  return new Plugin<CustomDashState>({
    key: customDashKey,
    state: {
      init: () => ({ undo: null }),
      apply(tr, prev): CustomDashState {
        const meta = tr.getMeta(customDashKey) as Meta | undefined;
        if (meta?.type === 'converted') {
          return { undo: { from: meta.from, to: meta.to } };
        }
        // Any other transaction ends the window in which Backspace reverts.
        return prev.undo === null ? prev : { undo: null };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '-') return false;
        if (!settings.get('customDashEnabled')) return false;
        const { state } = view;
        const $from = state.doc.resolve(from);
        // Need two hyphens immediately before this one (within the textblock) so
        // this keystroke completes `---`.
        if ($from.parentOffset < 2) return false;
        if (state.doc.textBetween(from - 2, from) !== '--') return false;
        const output = dashOutput();
        const start = from - 2;
        // Replace the two existing hyphens + the one being typed with the output.
        const tr = state.tr.insertText(output, start, to);
        const end = start + output.length;
        tr.setSelection(TextSelection.create(tr.doc, end));
        tr.setMeta(customDashKey, { type: 'converted', from: start, to: end } satisfies Meta);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace') return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        const st = customDashKey.getState(view.state);
        if (!st?.undo) return false;
        const { from, to } = st.undo;
        const sel = view.state.selection;
        // Only when the cursor sits exactly after the just-inserted output…
        if (!sel.empty || sel.from !== to) return false;
        // …and that text is still the configured output (defensive).
        if (view.state.doc.textBetween(from, to) !== dashOutput()) return false;
        const tr = view.state.tr.insertText('---', from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + 3));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
