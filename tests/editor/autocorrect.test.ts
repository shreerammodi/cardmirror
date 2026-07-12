/**
 * Shared autocorrect engine (autocorrect.ts) — equivalence with the two
 * pre-refactor implementations, plus the review fixes (2026-07-13):
 *
 *  1. old-vs-new TABLE EQUIVALENCE: for an exhaustive set of preceding
 *     contexts and typed characters, the refactored plugins produce exactly
 *     what reference implementations of the OLD decision logic produce —
 *     except the two deliberate deltas, asserted explicitly:
 *  2. the `---` trigger no longer fires inside a longer hyphen run;
 *  3. a preceding inline atom (footnote) is CLOSING quote context;
 *  4. the Backspace-revert window survives meta-only transactions (collab
 *     leases, spellcheck results) but still ends on doc/selection changes;
 *  5. the revert restores the trigger captured at conversion time, immune
 *     to a mid-window settings change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { smartQuotesPlugin, smartQuotesKey, curlFor } from '../../src/editor/smart-quotes-plugin.js';
import { customDashPlugin, customDashKey, dashOutput } from '../../src/editor/custom-dash-plugin.js';
import { settings } from '../../src/editor/settings.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBodyOf = (...k: PMNode[]) => schema.nodes['card_body']!.create(null, k);
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

function bodyEnd(d: PMNode): number {
  let end = 0;
  d.descendants((node, pos) => {
    if (node.type.name === 'card_body') end = pos + 1 + node.content.size;
  });
  return end;
}
function bodyText(d: PMNode): string {
  let out = '';
  d.descendants((node) => {
    if (node.type.name === 'card_body') out = node.textContent;
  });
  return out;
}
function propsOf(plugin: Plugin) {
  return plugin.props as unknown as {
    handleTextInput: (v: unknown, from: number, to: number, text: string) => boolean;
    handleKeyDown: (v: unknown, e: unknown) => boolean;
  };
}
interface Harness {
  view: { state: EditorState; dispatch: (tr: unknown) => void };
  plugin: Plugin;
  fired: boolean;
}
function typeAtEnd(bodyChildren: PMNode[], char: string, makePlugin: () => Plugin): Harness {
  const d = doc(card(tag('T'), cardBodyOf(...bodyChildren)));
  const plugin = makePlugin();
  let state = EditorState.create({ doc: d, plugins: [plugin] });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  };
  const end = bodyEnd(d);
  const fired = propsOf(plugin).handleTextInput(view, end, end, char);
  // handleTextInput returning false means the editor would insert the char
  // itself — simulate that so `bodyText` reflects what the user would see.
  if (!fired) view.dispatch(view.state.tr.insertText(char, end, end));
  return { view, plugin, fired };
}
const BS = { key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

// ─── Reference implementations of the OLD (pre-refactor) decision logic ───
function oldQuoteResult(context: string, typed: string): string {
  const prev = context === '' ? '' : context[context.length - 1]!;
  return context + curlFor(typed, prev); // old code used last char via textBetween
}
function oldDashResult(context: string, trigger: '--' | '---', output: string): string {
  const need = trigger.length - 1;
  if (context.length < need) return context + '-';
  if (context.slice(-need) !== '-'.repeat(need)) return context + '-';
  // OLD guard existed for `--` only:
  if (trigger === '--' && context.length > need && context[context.length - need - 1] === '-') {
    return context + '-';
  }
  return context.slice(0, context.length - need) + output;
}

beforeEach(() => {
  settings.set('smartQuotes', true);
  settings.set('customDashEnabled', true);
  settings.set('customDashTrigger', '---');
  settings.set('customDashStyle', 'em');
});

describe('old-vs-new equivalence table', () => {
  const CONTEXTS = ['', 'a', 'a ', 'word', 'don', 'a-', 'a—', 'a–', 'a(', 'a<', 'a"', "a'", 'a“', 'a’', 'a9', 'a.', 'a,', 'a--', 'a---', 'a----', '-', '--', '---'];

  it('quotes: identical outcome for every string context', () => {
    for (const ctx of CONTEXTS) {
      for (const typed of ["'", '"']) {
        const children = ctx ? [schema.text(ctx)] : [];
        const { view } = typeAtEnd(children, typed, smartQuotesPlugin);
        expect(bodyText(view.state.doc), `ctx=${JSON.stringify(ctx)} typed=${typed}`).toBe(
          oldQuoteResult(ctx, typed),
        );
      }
    }
  });

  it('dashes: identical outcome for every context and both triggers — except the documented `---` run-guard delta', () => {
    for (const trigger of ['--', '---'] as const) {
      settings.set('customDashTrigger', trigger);
      for (const ctx of CONTEXTS) {
        const children = ctx ? [schema.text(ctx)] : [];
        const { view } = typeAtEnd(children, '-', customDashPlugin);
        const got = bodyText(view.state.doc);
        const old = oldDashResult(ctx, trigger, '—');
        // THE delta (review fix): `---` at the end of a longer hyphen run no
        // longer converts. Everything else must match the old logic exactly.
        const isRunGuardDelta =
          trigger === '---' && ctx.length > 2 && ctx.endsWith('---');
        if (isRunGuardDelta) {
          expect(got, `DELTA ctx=${JSON.stringify(ctx)}`).toBe(ctx + '-');
          expect(old).not.toBe(ctx + '-'); // proves old behavior differed
        } else {
          expect(got, `ctx=${JSON.stringify(ctx)} trigger=${trigger}`).toBe(old);
        }
      }
    }
  });
});

describe('review fixes', () => {
  it('a preceding footnote (inline atom) is CLOSING context for quotes', () => {
    const fn = schema.nodes['footnote']!.create();
    const { view } = typeAtEnd([schema.text('quote text'), fn], '"', smartQuotesPlugin);
    expect(bodyText(view.state.doc).endsWith('”')).toBe(true);
  });

  it('the revert window survives meta-only transactions (collab leases, spellcheck)', () => {
    const { view, plugin } = typeAtEnd([schema.text('a ')], '"', smartQuotesPlugin);
    expect(smartQuotesKey.getState(view.state)!.undo).not.toBeNull();
    view.dispatch(view.state.tr.setMeta('unrelated-background-tick', true));
    expect(smartQuotesKey.getState(view.state)!.undo, 'survives meta-only tr').not.toBeNull();
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(true);
    expect(bodyText(view.state.doc)).toBe('a "');
  });

  it('the revert window still ends on a selection change', () => {
    const { view, plugin } = typeAtEnd([schema.text('a ')], '"', smartQuotesPlugin);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(smartQuotesKey.getState(view.state)!.undo).toBeNull();
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(false);
  });

  it('the revert window still ends on a doc change', () => {
    const { view, plugin } = typeAtEnd([schema.text('a ')], '"', smartQuotesPlugin);
    view.dispatch(view.state.tr.insertText('x'));
    expect(smartQuotesKey.getState(view.state)!.undo).toBeNull();
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(false);
  });

  it('dash revert restores the trigger captured at CONVERSION time', () => {
    const { view, plugin, fired } = typeAtEnd([schema.text('a--')], '-', customDashPlugin);
    expect(fired).toBe(true);
    expect(bodyText(view.state.doc)).toBe('a—');
    // A settings change inside the window (no transaction) must not confuse
    // the revert: it restores what the user actually typed.
    settings.set('customDashTrigger', '--');
    expect(customDashKey.getState(view.state)!.undo).not.toBeNull();
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(true);
    expect(bodyText(view.state.doc)).toBe('a---');
  });

  it('dash revert still refuses when the document content drifted', () => {
    const { view, plugin } = typeAtEnd([schema.text('a--')], '-', customDashPlugin);
    // Simulate a same-position content change that somehow kept the caret:
    // content check must refuse (defensive path).
    const st = customDashKey.getState(view.state)!.undo!;
    const tr = view.state.tr.insertText('Z', st.from, st.to);
    tr.setSelection(TextSelection.create(tr.doc, st.from + 1));
    view.dispatch(tr);
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(false);
  });

  it('spaced dash styles round-trip through convert + revert', () => {
    settings.set('customDashStyle', 'en-spaced');
    const { view, plugin } = typeAtEnd([schema.text('a--')], '-', customDashPlugin);
    expect(bodyText(view.state.doc)).toBe('a – ');
    expect(dashOutput()).toBe(' – ');
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(true);
    expect(bodyText(view.state.doc)).toBe('a---');
  });
});
