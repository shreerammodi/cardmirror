// @vitest-environment jsdom
/**
 * Sending a node-selected LIVE VIEW (`self_ref`). Clicking a live view selects
 * it as a whole node (the green box); the send-to-* commands (tilde, dropzone)
 * should then send that window — flattened to plain cards, since the live
 * reference can't travel out of the doc. A `self_ref` isn't a structural unit,
 * so `normalizeSelectionForSend` would drop it; `resolveSendRange` handles the
 * node-selection case directly.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode, type Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { resolveSendRange, resolveSendSlice, takeSendSlice } from '../../src/editor/speech-doc-send.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc }) });
}
function selfPos(view: EditorView): number {
  let p = -1;
  view.state.doc.forEach((n, off) => {
    if (p < 0 && isSelfRef(n)) p = off;
  });
  return p;
}
function selectSelfRef(view: EditorView): void {
  const pos = selfPos(view);
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
}
function sliceBodies(slice: Slice): string[] {
  const out: string[] = [];
  slice.content.descendants((n) => {
    if (n.type.name === 'card_body') out.push(n.textContent);
    return true;
  });
  return out;
}
function sliceHasSelfRef(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((n) => {
    if (isSelfRef(n)) found = true;
    return true;
  });
  return found;
}

describe('resolveSendRange — a node-selected live view', () => {
  it('returns exactly the self_ref node range', () => {
    const view = makeView([
      block('Source', 'src'),
      card('Alpha', 'alpha'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    selectSelfRef(view);
    const pos = selfPos(view);
    const node = view.state.doc.nodeAt(pos)!;
    const range = resolveSendRange(view)!;
    expect(range).toEqual({ from: pos, to: pos + node.nodeSize });
    view.destroy();
  });

  it('takeSendSlice flattens the window to plain cards (no live link travels)', () => {
    const view = makeView([
      block('Source', 'src'),
      card('Alpha', 'alpha'),
      card('Bravo', 'bravo'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    selectSelfRef(view);
    const slice = takeSendSlice(view)!;
    expect(slice).not.toBeNull();
    // The projected cards come out as real cards…
    expect(sliceBodies(slice)).toEqual(['alpha', 'bravo']);
    // …and the self_ref itself never travels.
    expect(sliceHasSelfRef(slice)).toBe(false);
    view.destroy();
  });

  it('resolveSendSlice (non-taking) also sends the flattened window', () => {
    const view = makeView([
      block('Source', 'src'),
      card('Alpha', 'alpha'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    selectSelfRef(view);
    const slice = resolveSendSlice(view)!;
    expect(sliceBodies(slice)).toEqual(['alpha']);
    expect(sliceHasSelfRef(slice)).toBe(false);
    view.destroy();
  });
});

describe('a text selection SPANNING a live view (click-above → shift-click-below)', () => {
  // The live view must stay part of a text selection so select→send-to-speech
  // carries it — the CSS keeps `.pmd-self-ref` selectable; the send path then
  // flattens the spanned view to plain cards.
  it('includes the view in the send range and sends its flattened content', () => {
    const view = makeView([
      block('Source', 'src'),
      card('Alpha', 'alpha'), // src's section — what the view projects
      block('Body', 'body'),
      card('Above', 'above-body'),
      createSelfRefNode(schema, 'src', '↳ Source'), // the view, between two cards
      card('Below', 'below-body'),
    ]);
    let abovePos = -1;
    let belowEnd = -1;
    let selfRefPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.type.name === 'card' && n.firstChild?.textContent === 'Above') abovePos = off;
      if (n.type.name === 'card' && n.firstChild?.textContent === 'Below') belowEnd = off + n.nodeSize;
      if (isSelfRef(n)) selfRefPos = off;
    });
    // Span from inside Above, across the live view, to inside Below.
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.between(view.state.doc.resolve(abovePos + 2), view.state.doc.resolve(belowEnd - 2)),
      ),
    );

    // The resolved send range spans the whole live view.
    const range = resolveSendRange(view)!;
    const selfNode = view.state.doc.nodeAt(selfRefPos)!;
    expect(range.from).toBeLessThanOrEqual(selfRefPos);
    expect(range.to).toBeGreaterThanOrEqual(selfRefPos + selfNode.nodeSize);

    // The sent content carries the view (flattened to cards) between the two cards.
    const slice = takeSendSlice(view)!;
    expect(sliceHasSelfRef(slice)).toBe(false);
    const bodies = sliceBodies(slice);
    expect(bodies).toContain('above-body');
    expect(bodies).toContain('alpha'); // the view's projected content came along
    expect(bodies).toContain('below-body');
    view.destroy();
  });

  it('a section ENDING in a live view (TextSelection.create range) still sends the view', () => {
    // Section H ends with the view — `TextSelection.between` would clamp before it,
    // but the "select heading and content" command uses `.create` for the exact
    // range, so the trailing view is in the selection and gets sent.
    const view = makeView([
      block('Source', 'src'),
      card('Alpha', 'alpha'), // src's section
      block('H', 'H'),
      card('A', 'a-body'),
      createSelfRefNode(schema, 'src', '↳ Source'), // last node of section H
    ]);
    let hPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.attrs?.['id'] === 'H') hPos = off;
    });
    const to = view.state.doc.content.size; // after the trailing view
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hPos, to)));

    const slice = takeSendSlice(view)!;
    expect(sliceHasSelfRef(slice)).toBe(false);
    const bodies = sliceBodies(slice);
    expect(bodies).toContain('a-body'); // the section's own card
    expect(bodies).toContain('alpha'); // the trailing view's projected content
    view.destroy();
  });
});
