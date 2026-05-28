/**
 * Flashcard highlight plugin (SPEC-learn-system §4.2).
 *
 * Renders the in-document highlight for each *resolved* flashcard anchor
 * as a view-only inline **decoration** — never a mark. This is the load-
 * bearing choice: decorations are never part of `doc.toJSON()` or the
 * export pipeline, so a flashcard's grounding can never leak into a
 * shared `.cmir` / `.docx` (unlike a `comment_range` mark, which would
 * need stripping at every serialize site). The local annotation layer
 * stays strictly local by construction.
 *
 * The plugin holds the resolved ranges and maps them through edits:
 * a range that collapses (its whole span deleted) is dropped, so the
 * comments column can move that card to its Unanchored list. Resolution
 * itself (descriptor → positions) happens in the comments column when it
 * opens; this plugin just tracks + paints what it's handed.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export interface FlashcardRange {
  cardId: string;
  from: number;
  to: number;
}

interface HighlightState {
  ranges: FlashcardRange[];
  decos: DecorationSet;
}

export const learnHighlightKey = new PluginKey<HighlightState>('learn-highlight');

interface SetMeta {
  type: 'set';
  ranges: FlashcardRange[];
}

function buildDecos(doc: EditorState['doc'], ranges: FlashcardRange[]): DecorationSet {
  const decos = ranges
    .filter((r) => r.to > r.from)
    .map((r) =>
      Decoration.inline(r.from, r.to, {
        class: 'pmd-flashcard-range',
        'data-card-id': r.cardId,
      }),
    );
  return DecorationSet.create(doc, decos);
}

export const learnHighlightPlugin = new Plugin<HighlightState>({
  key: learnHighlightKey,
  state: {
    init() {
      return { ranges: [], decos: DecorationSet.empty };
    },
    apply(tr, prev, _old, newState) {
      const meta = tr.getMeta(learnHighlightKey) as SetMeta | undefined;
      if (meta) {
        const ranges = meta.ranges.filter((r) => r.to > r.from).map((r) => ({ ...r }));
        return { ranges, decos: buildDecos(newState.doc, ranges) };
      }
      if (!tr.docChanged) return prev;
      // Track edits: bias from→right, to→left so edits at the exact
      // boundary stay outside the span (matches comment_range's
      // inclusive:false), and a fully-deleted span collapses (to<=from)
      // and is dropped.
      const mapped: FlashcardRange[] = [];
      for (const r of prev.ranges) {
        const from = tr.mapping.map(r.from, 1);
        const to = tr.mapping.map(r.to, -1);
        if (to > from) mapped.push({ cardId: r.cardId, from, to });
      }
      return { ranges: mapped, decos: buildDecos(newState.doc, mapped) };
    },
  },
  props: {
    decorations(state) {
      return learnHighlightKey.getState(state)?.decos ?? null;
    },
  },
});

/** Currently-resolved flashcard ranges (after live edit tracking). */
export function flashcardRanges(state: EditorState): FlashcardRange[] {
  return learnHighlightKey.getState(state)?.ranges ?? [];
}

/** Map of cardId → live range, for the column's positioning. */
export function flashcardRangeMap(state: EditorState): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>();
  for (const r of flashcardRanges(state)) out.set(r.cardId, { from: r.from, to: r.to });
  return out;
}

/** Replace the resolved-anchor set (called after re-resolution). The
 *  transaction is doc-neutral + out of undo history. */
export function setFlashcardRangesTr(
  state: EditorState,
  ranges: FlashcardRange[],
): Transaction {
  return state.tr.setMeta(learnHighlightKey, { type: 'set', ranges }).setMeta('addToHistory', false);
}
