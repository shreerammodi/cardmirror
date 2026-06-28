/**
 * Move-container commands: grab the cursor's smallest enclosing outline node
 * (a card / analytic unit, or a heading section) and move it one "spot" up or
 * down in the nav-pane outline.
 *
 * A "spot" is one step in the flat, in-order list of top-level outline items,
 * where each item carries an outline level (card / analytic unit = 4, block =
 * 3, hat = 2, pocket = 1; loose content is treated as deeper than any heading).
 * The move scans past items *deeper* than the grabbed item's level — those are
 * a sibling's contents, travelling as a unit — and lands next to the first item
 * at the grabbed level or shallower. One rule, two behaviors:
 *
 *   - A card hopping a block heading is one step (the heading is shallower, so a
 *     single stop) — the card lands right beside the heading, entering/leaving
 *     that section.
 *   - A block hopping a sibling block is one step over that sibling's *entire*
 *     section (its cards are deeper, skipped as a unit) — blocks reorder among
 *     blocks.
 *
 * Boundaries flow: a card that's first/last in its block moves into the adjacent
 * section. No same-level-or-shallower neighbor in the move direction → no-op.
 */

import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import {
  collectHeadings,
  computeHeadingRange,
  TYPE_TO_LEVEL,
  type HeadingEntry,
} from './headings.js';

/** Loose paragraphs / cite / table at doc level are section *content*, deeper
 *  than any heading — so they're skipped (as part of a sibling's subtree). */
const CONTENT_LEVEL = Number.POSITIVE_INFINITY;

/** Outline level of a top-level doc child: a card / analytic unit takes its
 *  head's level (4); pocket / hat / block their own; everything else is
 *  content (deepest). */
function docChildLevel(node: PMNode): number {
  const t = node.type.name;
  if (t === 'card') return TYPE_TO_LEVEL['tag'] ?? 4;
  if (t === 'analytic_unit') return TYPE_TO_LEVEL['analytic'] ?? 4;
  return t in TYPE_TO_LEVEL ? TYPE_TO_LEVEL[t]! : CONTENT_LEVEL;
}

/** The cursor's deepest enclosing outline node (the card / analytic unit, or
 *  the nearest heading whose section contains the cursor), or null. */
function grabbedHeading(doc: PMNode, pos: number): HeadingEntry | null {
  let best: HeadingEntry | null = null;
  let bestFrom = -1;
  for (const entry of collectHeadings(doc, { skipCite: true })) {
    const r = computeHeadingRange(doc, entry);
    if (r && r.from <= pos && pos < r.to && r.from > bestFrom) {
      best = entry;
      bestFrom = r.from;
    }
  }
  return best;
}

function moveContainer(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: 'up' | 'down',
): boolean {
  const { doc, selection } = state;
  const cursor = selection.head;
  const grabbed = grabbedHeading(doc, cursor);
  if (!grabbed) return false;
  const range = computeHeadingRange(doc, grabbed);
  if (!range) return false;
  const level = grabbed.level;

  // Top-level children as {start, end, level}.
  const kids: { start: number; end: number; level: number }[] = [];
  let off = 0;
  doc.forEach((child) => {
    kids.push({ start: off, end: off + child.nodeSize, level: docChildLevel(child) });
    off += child.nodeSize;
  });
  const ri0 = kids.findIndex((k) => k.start === range.from);
  const riLast = kids.findIndex((k) => k.end === range.to);
  if (ri0 < 0 || riLast < 0) return false;
  const ri1 = riLast + 1; // exclusive end index of the grabbed span

  let insertPos: number;
  if (dir === 'up') {
    // Skip back over deeper items (a sibling's contents); land before the first
    // item at the grabbed level or shallower.
    let i = ri0 - 1;
    while (i >= 0 && kids[i]!.level > level) i--;
    if (i < 0) return false; // nothing above → no-op
    insertPos = kids[i]!.start;
  } else {
    if (ri1 >= kids.length) return false; // nothing below → no-op
    // The next item is the sibling-or-shallower to hop; skip its deeper subtree.
    let j = ri1 + 1;
    while (j < kids.length && kids[j]!.level > level) j++;
    insertPos = j < kids.length ? kids[j]!.start : doc.content.size;
  }
  if (!dispatch) return true;

  const slice = doc.slice(range.from, range.to);
  const cursorOffset = cursor - range.from;
  const tr = state.tr;
  tr.delete(range.from, range.to);
  const mapped = tr.mapping.map(insertPos);
  tr.insert(mapped, slice.content);
  // Keep the cursor in the moved container so the command can be repeated.
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(mapped + cursorOffset)));
  } catch {
    /* fall back to the default mapped selection */
  }
  tr.scrollIntoView();
  dispatch(tr);
  return true;
}

/** Move the cursor's enclosing container one spot up among same-level outline
 *  items (see module doc). */
export function moveContainerUp(): Command {
  return (state, dispatch) => moveContainer(state, dispatch, 'up');
}

/** Move the cursor's enclosing container one spot down. */
export function moveContainerDown(): Command {
  return (state, dispatch) => moveContainer(state, dispatch, 'down');
}
