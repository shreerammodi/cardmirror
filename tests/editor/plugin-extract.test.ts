// tests/editor/plugin-extract.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { extractSelection } from '../../src/editor/plugin-extract.js';
import { parseSourceToken } from '../../src/editor/plugin-source-token.js';

const IDENT = { docId: 'doc-1', docTitle: 'Test.docx' };

function heading(type: string, text: string, id = newHeadingId()): PMNode {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function undertag(text: string): PMNode {
  return schema.nodes['undertag']!.create(null, schema.text(text));
}
function citePara(citeText: string, rest = ''): PMNode {
  const content = [schema.text(citeText, [schema.marks['cite_mark']!.create()])];
  if (rest) content.push(schema.text(rest));
  return schema.nodes['cite_paragraph']!.create(null, content);
}
function cardBody(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function paragraph(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function card(...children: PMNode[]): PMNode {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Minimal view stand-in: extraction reads state only. */
function fakeView(doc: PMNode, from: number, to = from): EditorView {
  const state = EditorState.create({ doc });
  const sel =
    to === from
      ? TextSelection.create(state.doc, from)
      : TextSelection.create(state.doc, from, to);
  // Extraction only touches view.state; a full EditorView needs a DOM mount.
  return { state: state.apply(state.tr.setSelection(sel)) } as unknown as EditorView;
}

const tagId = newHeadingId();
const blockId = newHeadingId();
function sampleDoc(): PMNode {
  return makeDoc([
    heading('block', 'AT: Framework', blockId),
    card(
      heading('tag', 'Perm solves', tagId),
      undertag('extend: do both'),
      citePara('Smith 24', ' - Prof at X, Journal.'),
      cardBody('Long card body prose that must never leave.'),
    ),
    paragraph('a loose paragraph'),
  ]);
}

describe('extractSelection', () => {
  it('collapsed cursor in the card extracts the card as typed items, no body', () => {
    const doc = sampleDoc();
    // position inside the tag text: block node = pos 0..block.nodeSize
    const inTag = doc.nodeSize - doc.child(1).nodeSize - doc.child(2).nodeSize - 2 + 3;
    const res = extractSelection(fakeView(doc, inTag), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['tag', 'undertag', 'cite']);
    expect(res.items[2]!.text).toBe('Smith 24');
    expect(res.items.some((i) => i.text.includes('never leave'))).toBe(false);
  });
  it('attributes undertag and cite to the parent tag heading id', () => {
    const doc = sampleDoc();
    const res = extractSelection(fakeView(doc, 3, doc.content.size - 2), IDENT);
    if (!res.ok) throw new Error(res.error);
    const byKind = Object.fromEntries(res.items.map((i) => [i.kind, i]));
    expect(parseSourceToken(byKind['block']!.source)!.headingId).toBe(blockId);
    expect(parseSourceToken(byKind['tag']!.source)!.headingId).toBe(tagId);
    expect(parseSourceToken(byKind['undertag']!.source)!.headingId).toBe(tagId);
    expect(parseSourceToken(byKind['cite']!.source)!.headingId).toBe(tagId);
    expect(parseSourceToken(byKind['tag']!.source)!.docTitle).toBe('Test.docx');
  });
  it('explicit selection wins and skips loose paragraphs', () => {
    const doc = sampleDoc();
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['block', 'tag', 'undertag', 'cite']);
  });
  it('cursor above all headings errors instead of guessing', () => {
    const doc = makeDoc([paragraph('intro'), heading('block', 'B')]);
    const res = extractSelection(fakeView(doc, 2), IDENT);
    expect(res).toEqual({ ok: false, error: 'no-heading-at-cursor' });
  });
  it('selection with only body content yields empty-selection', () => {
    const doc = sampleDoc();
    // select inside the loose trailing paragraph only
    const paraStart = doc.content.size - doc.child(2).nodeSize;
    const res = extractSelection(fakeView(doc, paraStart + 1, paraStart + 6), IDENT);
    expect(res).toEqual({ ok: false, error: 'empty-selection' });
  });
});
