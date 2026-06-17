/**
 * Keep the caret in the leading block after a cross-boundary delete.
 *
 * A selection's end (`to`) can sit at `parentOffset === 0` of a later
 * textblock — the Ctrl/Alt-Shift-Down shape (and native Shift-Down past a
 * block's end) — so the paragraph break is inside the selection (see
 * `pilcrow-selection-plugin.ts`). Deleting such a selection leaves the caret
 * at the mapped selection END. When the two blocks merge (plain body
 * paragraphs) that's fine — the end maps into the merged block. But when the
 * merge is BLOCKED (an isolating tag/card boundary: the delete empties the
 * leading block yet leaves both blocks standing), the mapped end lands at the
 * START of the untouched trailing block — e.g. select a card's tag including
 * the break and delete, and the caret jumps to the next card. The break was
 * NOT consumed, so per our invariant the caret must stay in the leading block.
 *
 * `deleteSelectionKeepingLeadingCursor` decides what happened with a probe:
 * it runs `deleteSelection` and compares the textblock count. If the count is
 * UNCHANGED, the leading block survived (emptied) but didn't merge — so it
 * instead deletes only the leading block's selected content `[from,
 * leadingEnd]`, leaving the break and trailing block untouched, and the caret
 * maps cleanly into the (now empty) leading block. If the count DROPPED, the
 * blocks really merged (plain paragraphs) or the whole leading container was
 * removed (a tag-only card) — in both the leading block is gone, so the plain
 * `deleteSelection` caret is correct and we use it. (Position-mapping the
 * survivor directly is unreliable: `deleteSelection` collapses content AND the
 * boundary into one ambiguous cut point, so no original position resolves back
 * inside the emptied block — hence the clean re-delete.)
 *
 * Used by the Backspace/Delete keymap fallback below and the voice deletes.
 *
 * Detection mirrors `type-over-boundary.ts` / `pilcrow-selection-plugin.ts`:
 * the selection end resolves to `parentOffset === 0` of a textblock and the
 * selection starts before that block, so a real break is captured.
 */

import { Selection, TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

/** True when the selection's end grabs a trailing paragraph break: it sits
 *  at offset 0 of a textblock that the selection started before. */
function grabsTrailingBreak(state: EditorState): boolean {
  const sel = state.selection;
  if (sel.empty) return false;
  const $to = state.doc.resolve(sel.to);
  if (!$to.parent.isTextblock || $to.parentOffset !== 0) return false;
  const tailBlockStart = $to.before($to.depth);
  return sel.from < tailBlockStart;
}

function countTextblocks(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.isTextblock) n++;
    return true;
  });
  return n;
}

/**
 * Delete the current selection; if it grabbed a trailing break that didn't
 * actually merge, keep the caret in the leading block. Returns the
 * transaction with `scrollIntoView()` applied. Identical to a plain
 * `deleteSelection().scrollIntoView()` for every other selection shape.
 */
export function deleteSelectionKeepingLeadingCursor(
  state: EditorState,
): Transaction {
  const sel = state.selection;
  if (grabsTrailingBreak(state)) {
    const $to = state.doc.resolve(sel.to);
    const tailBlockStart = $to.before($to.depth);
    try {
      const leadingEnd = Selection.near(state.doc.resolve(tailBlockStart), -1).to;
      if (leadingEnd > sel.from) {
        const probe = state.tr.deleteSelection();
        if (countTextblocks(state.doc) === countTextblocks(probe.doc)) {
          // Blocked merge: the leading block survives, emptied. Delete only
          // its selected content so the break and trailing block stay put and
          // the caret lands inside the leading block.
          const tr = state.tr.delete(sel.from, leadingEnd);
          tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(sel.from)));
          return tr.scrollIntoView();
        }
      }
    } catch {
      /* fall through to the plain delete */
    }
  }
  return state.tr.deleteSelection().scrollIntoView();
}

/** Backspace/Delete fallback: handle the trailing-break-grab shape so the
 *  caret stays in the leading block; defer otherwise. */
export const keepCursorInLeadingBlockOnBlockedMerge: Command = (
  state,
  dispatch,
) => {
  if (!grabsTrailingBreak(state)) return false;
  if (!dispatch) return true;
  dispatch(deleteSelectionKeepingLeadingCursor(state));
  return true;
};
