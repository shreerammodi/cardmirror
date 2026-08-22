// @vitest-environment jsdom
/**
 * Copy/paste keeps a live view / linked copy LINKED within the same document, but
 * materializes it to plain cards in a new one (matching drag). The clipboard
 * always carries flattened content (cross-doc / external safe); a same-doc paste
 * restores the stashed link-bearing original.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMSerializer, DOMParser as PMDOMParser, Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { dedupeHeadingIds } from '../../src/editor/drag-controller.js';
import { createSelfRefNode, isSelfRef, flattenSelfRefsInSlice } from '../../src/editor/self-transclusion.js';
import { createTransclusionNode, isTransclusionNode, SELF_SOURCE_REF } from '../../src/editor/transclusion.js';
import {
  rememberLinkedCopy,
  recallLinkedCopy,
  clearLinkedCopy,
  sliceSignature,
} from '../../src/editor/clipboard-link-cache.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function inDocCopy(): PMNode {
  return createTransclusionNode(
    schema,
    { source_ref: SELF_SOURCE_REF, source_ref_base: 'doc', source_heading_id: 'src' },
    Fragment.fromArray([card('Copied', 'copied body')]),
  );
}
function makeView(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc }) });
}
/** Simulate the clipboard's toDOM → parseDOM round-trip. */
function clipboardRoundTrip(slice: import('prosemirror-model').Slice) {
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(slice.content));
  return PMDOMParser.fromSchema(schema).parseSlice(div);
}
function hasSelfRef(frag: Fragment): boolean {
  let f = false;
  frag.descendants((n) => {
    if (isSelfRef(n)) f = true;
    return true;
  });
  return f;
}
function hasZoneWithSource(frag: Fragment, sourceRef: string): boolean {
  let f = false;
  frag.descendants((n) => {
    if (isTransclusionNode(n) && n.attrs['source_ref'] === sourceRef) f = true;
    return true;
  });
  return f;
}

// A doc: block 'src' + its card, a live view of 'src', and a linked copy of 'src'.
function seed(): PMNode {
  return schema.nodes['doc']!.create(null, [
    block('Source', 'src'),
    card('SrcCard', 'source body'),
    block('Home', 'home'),
    createSelfRefNode(schema, 'src', '↳ Source'),
    inDocCopy(),
    block('End', 'end'),
  ]);
}
/** Slice covering the live view + the linked copy (the two link-bearing nodes). */
function linkSlice(doc: PMNode) {
  let from = -1;
  let to = -1;
  doc.forEach((n, off) => {
    if (isSelfRef(n) && from < 0) from = off;
    if (isTransclusionNode(n)) to = off + n.nodeSize;
  });
  return doc.slice(from, to);
}

beforeEach(() => clearLinkedCopy());

describe('clipboard link cache', () => {
  it('recalls the original for the same view + matching signature; not otherwise', () => {
    const docA = seed();
    const viewA = makeView(docA);
    const viewB = makeView(seed());
    const original = linkSlice(docA);
    const clipboard = flattenSelfRefsInSlice(original, docA, newHeadingId);

    rememberLinkedCopy(original, viewA, clipboard);
    // Same view + the clipboard content → restore the link-bearing original.
    expect(recallLinkedCopy(viewA, clipboard)).toBe(original);
    // A different view (different doc) → no restore (flatten).
    expect(recallLinkedCopy(viewB, clipboard)).toBeNull();
    // Different content pasted into the same view → no restore.
    expect(recallLinkedCopy(viewA, docA.slice(0, 6))).toBeNull();
    // Cleared → no restore.
    clearLinkedCopy();
    expect(recallLinkedCopy(viewA, clipboard)).toBeNull();
    viewA.destroy();
    viewB.destroy();
  });

  it('the signature survives a real clipboard DOM round-trip', () => {
    const docA = seed();
    const viewA = makeView(docA);
    const original = linkSlice(docA);
    const clipboard = flattenSelfRefsInSlice(original, docA, newHeadingId);
    rememberLinkedCopy(original, viewA, clipboard);

    // What actually lands on paste is the clipboard slice after toDOM/parseDOM.
    const pasted = clipboardRoundTrip(clipboard);
    expect(sliceSignature(pasted)).toBe(sliceSignature(clipboard));
    expect(recallLinkedCopy(viewA, pasted)).toBe(original);
    viewA.destroy();
  });
});

describe('same-doc paste keeps the link; cross-doc flattens', () => {
  it('restores links with FRESH card ids (no collision), source-refs preserved', () => {
    const docA = seed();
    const viewA = makeView(docA);
    const original = linkSlice(docA);
    const clipboard = flattenSelfRefsInSlice(original, docA, newHeadingId);
    rememberLinkedCopy(original, viewA, clipboard);

    // Same-doc paste path: recall then settle ids (what transformPasted does).
    const restored = recallLinkedCopy(viewA, clipboardRoundTrip(clipboard))!;
    expect(restored).toBe(original);
    const pastedContent = dedupeHeadingIds(restored, docA);
    // The live view and the linked copy both survive with their links intact.
    expect(hasSelfRef(pastedContent.content), 'live view kept').toBe(true);
    expect(hasZoneWithSource(pastedContent.content, SELF_SOURCE_REF), 'copy link kept').toBe(true);
    // The self_ref still points at the original source (not re-stamped).
    let srcId = '';
    pastedContent.content.descendants((n) => {
      if (isSelfRef(n)) srcId = String(n.attrs['source_heading_id']);
      return true;
    });
    expect(srcId).toBe('src');
    viewA.destroy();
  });

  it('cross-doc paste gets the flattened clipboard content (no live view)', () => {
    const docA = seed();
    const viewA = makeView(docA);
    const viewB = makeView(seed());
    const original = linkSlice(docA);
    const clipboard = flattenSelfRefsInSlice(original, docA, newHeadingId);
    rememberLinkedCopy(original, viewA, clipboard);

    // Cross-doc: recall returns null → the flattened clipboard content is used.
    expect(recallLinkedCopy(viewB, clipboardRoundTrip(clipboard))).toBeNull();
    // And that clipboard content has no live view (materialized to cards).
    expect(hasSelfRef(clipboard.content)).toBe(false);
    viewA.destroy();
    viewB.destroy();
  });
});
