/**
 * Images carry only functional marks (issue #18: emphasis on an image
 * drew a text-height box through it — a mark span's height comes from
 * font metrics, not its image child). Visual marks are stripped by the
 * named-style normalizer on live transactions and by
 * stripImageVisualMarks at load; comment_range and link survive both.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { stripImageVisualMarks, IMAGE_ALLOWED_MARKS } from '../../src/schema/migrate.js';
import { namedStyleNormalizerPlugin } from '../../src/editor/named-style-normalizer-plugin.js';

const emphasis = schema.marks['emphasis_mark']!;
const highlight = schema.marks['highlight']!;
const commentRange = schema.marks['comment_range']!;
const link = schema.marks['link']!;

function image(marks: import('prosemirror-model').Mark[] = []) {
  return schema.nodes['image']!.createChecked({}, null, marks);
}

function docWith(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.create(null, [
    schema.nodes['paragraph']!.create(null, children),
  ]);
}

function imageMarksOf(doc: import('prosemirror-model').Node): string[] {
  let found: string[] | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'image') found = n.marks.map((m) => m.type.name);
  });
  if (!found) throw new Error('no image in doc');
  return found;
}

describe('normalizer: visual marks come off images on the same dispatch', () => {
  function stateWith(doc: import('prosemirror-model').Node): EditorState {
    return EditorState.create({ doc, plugins: [namedStyleNormalizerPlugin] });
  }

  it('emphasis applied across text + image marks the text, not the image', () => {
    const doc = docWith([schema.text('before '), image(), schema.text(' after')]);
    const state = stateWith(doc);
    const tr = state.tr;
    tr.setSelection(TextSelection.create(tr.doc, 1, tr.doc.content.size - 1));
    tr.addMark(tr.selection.from, tr.selection.to, emphasis.create());
    const next = state.apply(tr);

    expect(imageMarksOf(next.doc)).toEqual([]);
    // The neighboring text keeps its emphasis — the strip is per-node,
    // not per-span.
    next.doc.descendants((n) => {
      if (n.isText) {
        expect(n.marks.some((m) => m.type === emphasis)).toBe(true);
      }
    });
  });

  it('keeps a pre-existing comment_range while stripping a newly applied visual mark', () => {
    const doc = docWith([image([commentRange.create({ threadId: 't1' })])]);
    const state = stateWith(doc);
    // Highlight a selection that is just the image — the addMark range
    // is the changed range, so the scan lands exactly on the image.
    const tr = state.tr.addMark(1, 2, highlight.create());
    const next = state.apply(tr);
    expect(imageMarksOf(next.doc)).toEqual(['comment_range']);
  });
});

describe('stripImageVisualMarks (load-time)', () => {
  it('heals a stored doc whose image carries visual marks', () => {
    const doc = docWith([
      schema.text('t'),
      image([emphasis.create(), highlight.create(), link.create({ href: 'https://x.test' })]),
    ]);
    const out = stripImageVisualMarks(doc);
    expect(imageMarksOf(out)).toEqual(['link']);
    // Text is untouched.
    out.descendants((n) => {
      if (n.isText) expect(n.text).toBe('t');
    });
  });

  it('returns the same node when nothing needs stripping', () => {
    const doc = docWith([schema.text('t'), image([commentRange.create({ threadId: 't1' })])]);
    expect(stripImageVisualMarks(doc)).toBe(doc);
  });

  it('the allowed set is exactly comment_range and link', () => {
    // The exporter's comment-range reconciliation reads marks on image
    // nodes; if this set changes, revisit emitImageRun's assumptions.
    expect([...IMAGE_ALLOWED_MARKS].sort()).toEqual(['comment_range', 'link']);
  });
});
