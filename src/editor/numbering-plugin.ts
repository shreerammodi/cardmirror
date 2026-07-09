/**
 * Auto-numbering render pass (NUMBERING_PLAN.md §6).
 *
 * Draws the computed numbers as read-only widget decorations at the start of each
 * numbered card's tag, plus subtle restart/continue indicators on the non-default
 * units. Numbers are never stored (see `numbering.ts`): the whole set is recomputed
 * from the skeleton whenever the doc changes. Display is gated on the
 * `showCardNumbering` setting — the skeleton stays in the doc either way.
 *
 * The plugin also owns the per-window numbering (§7): the resolved numbering is
 * kept in plugin state so a live view's NodeView can render numbers on its
 * projected cards, and each `self_ref` is stamped with a `data-num-hash` node
 * decoration so the NodeView re-renders when its host-positional numbers change.
 *
 * Prototype scope: format is fixed (`1.` / `a)`). Full recompute on every
 * docChanged is fine at this size (numbering is inherently non-local).
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { computeNumbering, type NumberLabel } from './numbering.js';
import { settings } from './settings.js';

interface NumberingState {
  decorations: DecorationSet;
  /** self_ref position → per-projected-card labels (for the NodeView). */
  windows: Map<number, (NumberLabel | null)[]>;
}

export const numberingPluginKey = new PluginKey<NumberingState>('cardNumbering');

/** Transaction meta that forces the numbering set to rebuild even without a doc
 *  change — the settings subscriber fires it when the format/indent options
 *  change (they bake into the decorations, unlike the on/off gate). */
export const NUMBERING_REFRESH = 'pmd-numbering-refresh';

/** Per-user glyph separator (display-only; the .docx carries a canonical form). */
const FORMAT_SEP: Record<string, string> = { period: '.', paren: ')', dash: ' -' };
function glyphText(label: NumberLabel): string {
  return `${label.text}${FORMAT_SEP[settings.get('cardNumberingFormat')] ?? '.'}`;
}

/** The read-only number glyph element. Shared by the widget decorations (host
 *  cards) and the live-view NodeView (projected cards). */
export function createNumberGlyph(label: NumberLabel): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pmd-card-number';
  if (label.kind === 'sub') span.classList.add('pmd-card-number-sub');
  span.textContent = glyphText(label);
  // Chrome, not content: never editable, never a selection/caret target.
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/** Order-stable digest of a window's labels, so the NodeView re-renders exactly
 *  when its projected numbers change (not on every unrelated edit). */
function windowHash(labels: (NumberLabel | null)[]): string {
  return labels.map((l) => (l ? l.text : '·')).join(',');
}

function build(doc: PMNode): NumberingState {
  const { cards, windows } = computeNumbering(doc);
  const decos: Decoration[] = [];

  // Computed number / letter glyphs on host cards, plus optional per-level indent.
  const indentMode = settings.get('cardNumberingIndent');
  for (const [cardPos, label] of cards) {
    // card at cardPos → its `tag`/`analytic` heading at +1 → the heading's inline
    // content starts at +2. Sit the number at the very start of that line.
    const at = cardPos + 2;
    if (at > doc.content.size) continue;
    decos.push(
      Decoration.widget(at, () => createNumberGlyph(label), {
        side: -1,
        key: `cnum:${cardPos}:${label.kind}:${label.text}`,
        ignoreSelection: true,
      }),
    );
    // Indent by level (display-only): number = 1 step, sub = 2. Applied to the
    // tag line or the whole card per the setting.
    if (indentMode !== 'off') {
      const cardNode = doc.nodeAt(cardPos);
      if (cardNode) {
        const step = (label.kind === 'sub' ? 2 : 1) * 1.6;
        const style = `margin-left: ${step}em`;
        if (indentMode === 'card') {
          decos.push(Decoration.node(cardPos, cardPos + cardNode.nodeSize, { style }));
        } else if (cardNode.firstChild) {
          const tagSize = cardNode.firstChild.nodeSize;
          decos.push(Decoration.node(cardPos + 1, cardPos + 1 + tagSize, { style }));
        }
      }
    }
  }

  // Restart / continue indicators (§6) — shown only for the NON-default states,
  // which only exist when the author toggled them.
  doc.descendants((node, pos) => {
    const t = node.type.name;
    if (t === 'block') {
      if (node.attrs['numRestart'] === false) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'pmd-num-flow-in' }));
      }
      return false;
    }
    if (t === 'card' || t === 'analytic_unit') {
      if (node.attrs['numRestart'] === true) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'pmd-num-restart' }));
      }
      return false;
    }
    if (t === 'pocket' || t === 'hat' || t === 'self_ref') return false;
    return true; // doc root + transclusion_ref: descend to reach inner cards
  });

  // Stamp each live view with its numbers' hash so its NodeView re-renders when
  // the host-positional numbers change (its projection content may be unchanged).
  for (const [pos, labels] of windows) {
    decos.push(Decoration.node(pos, pos + 1, { 'data-num-hash': windowHash(labels) }));
  }

  return {
    decorations: decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty,
    windows,
  };
}

export const cardNumberingPlugin: Plugin<NumberingState> = new Plugin<NumberingState>({
  key: numberingPluginKey,
  state: {
    // Always compute (even when display is off) so a live view's NodeView can
    // read window labels and a toggle-on reveals them without a doc edit.
    init: (_config, { doc }) => build(doc),
    apply: (tr, prev) => (tr.docChanged || tr.getMeta(NUMBERING_REFRESH) ? build(tr.doc) : prev),
  },
  props: {
    decorations(state) {
      // Display-only: the skeleton stays in the doc, but the setting hides the
      // glyphs. Gated live here (not in the state) so a toggle takes effect on the
      // next view update — the settings subscriber nudges the view immediately.
      if (!settings.get('showCardNumbering')) return DecorationSet.empty;
      return numberingPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
    },
  },
});

/** The projected-card labels for the live view at `selfRefPos`, for the NodeView
 *  to render (host-positional). Empty when display is off or none resolved. */
export function windowNumbering(
  state: import('prosemirror-state').EditorState,
  selfRefPos: number,
): (NumberLabel | null)[] | null {
  if (!settings.get('showCardNumbering')) return null;
  return numberingPluginKey.getState(state)?.windows.get(selfRefPos) ?? null;
}
