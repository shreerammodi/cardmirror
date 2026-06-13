/**
 * Verbatim-adjacent "Create Reference" — given a card_body-only
 * selection inside a single card, copy a richly-formatted "for-
 * reference" excerpt to the system clipboard:
 *
 *   1. A heading paragraph: `<<{cite} FOR REFERENCE>>`, normal 11pt
 *      black body text (regardless of the Gray-50% setting).
 *   2. The selected card_body paragraphs, with:
 *      - every text run's effective font-size reduced by 3pt
 *        (emitted as an explicit `font_size` mark);
 *      - every text run colored black (or Gray-50% `#808080`
 *        if `forReferenceUseGray50` is on);
 *      - any `highlight` mark converted to a `shading` mark with
 *        the light gray (`C0C0C0`) "protected-highlight" color so
 *        the highlight isn't lost on paste into Word but reads as
 *        a quiet background. Existing shading marks are untouched.
 *
 * No-op (returns false) if the selection is empty, touches any
 * non-card_body content, or spans more than one card.
 *
 * Writes both `text/html` (for rich pastes back into this editor or
 * into Word) and `text/plain` (fallback) to the clipboard.
 */

import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { schema } from '../schema/index.js';
import { collectCiteText } from './headings.js';

/** Light gray for highlight → shading conversion in references. */
const REFERENCE_SHADING_HEX = 'C0C0C0';
const FONT_SIZE_DECREMENT_PT = 3;

interface CardBodySelection {
  paragraphs: { node: PMNode; pos: number }[];
  parentCard: PMNode;
}

/** Collect the card_body paragraphs a selection touches, requiring every
 *  touched textblock to be a card_body living inside ONE shared card.
 *  Returns null if the selection touches anything else or spans more than
 *  one card. (Create Reference's strict single-card validation.) */
function collectCardBodySelection(
  state: EditorState,
  from: number,
  to: number,
): CardBodySelection | null {
  let parentCardPos: number | null = null;
  let parentCard: PMNode | null = null;
  const paragraphs: { node: PMNode; pos: number }[] = [];
  let invalid = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (invalid) return false;
    if (!node.isTextblock) return true;
    if (node.type.name !== 'card_body') {
      invalid = true;
      return false;
    }
    // Card_body must live inside a card. depth 2: doc → card → card_body.
    const $start = state.doc.resolve(pos + 1);
    if ($start.depth < 2) {
      invalid = true;
      return false;
    }
    const cardDepth = $start.depth - 1;
    const card = $start.node(cardDepth);
    const cardPos = $start.before(cardDepth);
    if (card.type.name !== 'card') {
      invalid = true;
      return false;
    }
    if (parentCardPos === null) {
      parentCardPos = cardPos;
      parentCard = card;
    } else if (cardPos !== parentCardPos) {
      invalid = true;
      return false;
    }
    paragraphs.push({ node, pos });
    return false;
  });

  if (invalid || paragraphs.length === 0 || parentCard === null) return null;
  return { paragraphs, parentCard };
}

export type EffectivePtForNode = (
  node: PMNode | null,
  parent: PMNode,
) => number;

export async function createReference(
  state: EditorState,
  effectivePtForNode: EffectivePtForNode,
  useGray50: boolean,
): Promise<boolean> {
  const sel = state.selection;
  if (sel.empty) return false;

  // 1. Validate: every touched textblock must be a card_body in one card.
  const found = collectCardBodySelection(state, sel.from, sel.to);
  if (!found) return false;
  const { paragraphs, parentCard } = found;

  // 2. Compute the cite for the heading via the same logic the nav
  // pane uses (handles cite_mark bridging, the ampersand fix-up).
  // Force the cite portion to all-caps for the FOR REFERENCE label.
  const cite = collectCiteText(parentCard).trim();
  const headingText = `<<${cite ? `${cite.toUpperCase()} ` : ''}FOR REFERENCE>>`;

  // 3. Build the output fragment.
  const fontSizeType = schema.marks['font_size']!;
  const fontColorType = schema.marks['font_color']!;
  const highlightType = schema.marks['highlight']!;
  const shadingType = schema.marks['shading']!;
  const bodyColor = useGray50 ? '808080' : '000000';

  const outNodes: PMNode[] = [];

  // Heading paragraph — plain 11pt body text, always black, no
  // marks. Generic `paragraph` so it pastes cleanly into any
  // context (PM normalization will reshape it to card_body if the
  // paste lands inside a card).
  outNodes.push(
    schema.nodes['paragraph']!.create(null, schema.text(headingText)),
  );

  for (const { node: para } of paragraphs) {
    const transformed: PMNode[] = [];
    para.forEach((child) => {
      if (!child.isText) {
        transformed.push(child);
        return;
      }
      const existingFs = child.marks.find((m) => m.type === fontSizeType);
      const currentPt = existingFs
        ? Number(existingFs.attrs['halfPoints'] ?? 22) / 2
        : effectivePtForNode(child, para);
      const newPt = Math.max(1, currentPt - FONT_SIZE_DECREMENT_PT);

      // Strip the marks we're about to override (font_size,
      // font_color) plus highlight (we'll convert to shading).
      const filtered = child.marks.filter(
        (m) =>
          m.type !== fontSizeType &&
          m.type !== fontColorType &&
          m.type !== highlightType,
      );

      // Re-build the mark set in rank order (Mark.addToSet handles
      // that for us).
      let newMarks = filtered as readonly import('prosemirror-model').Mark[];
      if (child.marks.some((m) => m.type === highlightType)) {
        newMarks = shadingType
          .create({ color: REFERENCE_SHADING_HEX })
          .addToSet(newMarks);
      }
      newMarks = fontSizeType
        .create({ halfPoints: Math.round(newPt * 2) })
        .addToSet(newMarks);
      newMarks = fontColorType.create({ color: bodyColor }).addToSet(newMarks);

      transformed.push(child.mark(newMarks));
    });
    // Use `card_body` for the body paragraphs (rather than the
    // generic `paragraph`). When pasted back into a card, this
    // matches the surrounding paragraph type exactly, so PM doesn't
    // have to lift the slice to a higher depth — which is what was
    // scrolling the viewport to a far-off paste landing position.
    outNodes.push(
      schema.nodes['card_body']!.create(null, Fragment.fromArray(transformed)),
    );
  }

  const outputFragment = Fragment.fromArray(outNodes);

  // 4. Serialize to HTML via PM's DOMSerializer so the marks
  // round-trip via the same data-* attribute spans we parse on
  // import.
  const serializer = DOMSerializer.fromSchema(schema);
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(outputFragment));
  const html = container.innerHTML;

  // Plain-text fallback: paragraphs joined by blank lines.
  const plain = outNodes.map((n) => n.textContent).join('\n\n');

  // 5. Write to the clipboard.
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return true;
  } catch (err) {
    console.error('Create Reference: clipboard write failed', err);
    return false;
  }
}

/** The [before, after] range of the nearest enclosing card / analytic_unit
 *  container for `$pos`, or null if the cursor isn't inside one. */
function enclosingCardRange(
  $pos: import('prosemirror-model').ResolvedPos,
): { from: number; to: number } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'card' || name === 'analytic_unit') {
      return { from: $pos.before(d), to: $pos.after(d) };
    }
  }
  return null;
}

/**
 * "Lock Highlighting" — the in-place sibling of Create Reference. Converts
 * every `highlight` mark in scope to the light-gray "protected" `shading`
 * color, freeing the highlight layer so the user can re-highlight in one
 * pass. Scope follows the selection: with a selection it locks just the
 * selected range; with no selection it locks the whole card (or
 * analytic_unit) the cursor is in.
 *
 * Unlike Create Reference it edits in place, writes no `<<… FOR REFERENCE>>`
 * heading, leaves font size alone, and NEVER colors the underlying text gray
 * — its whole point is to keep the card editable. An existing `shading` mark
 * is left untouched (matching Create Reference), so re-running won't re-tint
 * already-locked runs.
 *
 * No-op (returns false) when there's no selection and the cursor isn't in a
 * card, or when the scope contains no highlights to lock.
 */
export function lockHighlighting(): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    let from: number;
    let to: number;
    if (sel.empty) {
      const range = enclosingCardRange(sel.$from);
      if (!range) return false; // card-scoped, but not in a card
      ({ from, to } = range);
    } else {
      from = sel.from;
      to = sel.to;
    }

    const highlightType = schema.marks['highlight']!;
    const shadingType = schema.marks['shading']!;
    const tr = state.tr;
    let changed = false;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      if (!node.marks.some((m) => m.type === highlightType)) return true;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, highlightType);
      // Convert to the protected gray background — but never overwrite an
      // existing shading (matches Create Reference).
      if (!node.marks.some((m) => m.type === shadingType)) {
        tr.addMark(start, end, shadingType.create({ color: REFERENCE_SHADING_HEX }));
      }
      changed = true;
      return true;
    });

    if (!changed) return false; // nothing highlighted in scope
    if (!dispatch) return true;
    dispatch(tr);
    return true;
  };
}
