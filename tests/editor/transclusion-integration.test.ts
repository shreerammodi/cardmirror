// @vitest-environment jsdom
/**
 * Live zones in a real EditorView: NodeView registration + rendering, and the
 * detach / insert transactions. Exercises the PM integration, not just the pure
 * helpers.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { editorNodeViews } from '../../src/editor/image-resize-nodeview.js';
import {
  createTransclusionNode,
  isTransclusionNode,
  TRANSCLUSION_NODE,
} from '../../src/editor/transclusion.js';
import {
  detachZoneAtPos,
  insertZoneAtSelection,
} from '../../src/editor/transclusion-actions.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc }),
    nodeViews: editorNodeViews,
  });
}
function countTypes(view: EditorView): { cards: number; zones: number } {
  let cards = 0;
  let zones = 0;
  view.state.doc.descendants((n) => {
    if (n.type.name === 'card') cards++;
    if (isTransclusionNode(n)) zones++;
    return true;
  });
  return { cards, zones };
}

describe('live zone in a real EditorView', () => {
  it('renders through the NodeView — rail glyph + cached cards', () => {
    const zone = createTransclusionNode(schema, {
      source_ref: 'a.cmir',
      source_heading_id: 'h1',
      cached_content: [card('Tag A', 'evidence A').toJSON(), card('Tag B', 'evidence B').toJSON()],
      source_label: 'Src to Block',
    });
    const view = makeView([schema.nodes['paragraph']!.create(), zone]);
    const el = view.dom.querySelector('.pmd-transclusion');
    expect(el).toBeTruthy();
    expect(el!.querySelector('.pmd-transclusion-glyph')).toBeTruthy();
    expect(el!.querySelector('.pmd-transclusion-body')).toBeTruthy();
    expect(el!.textContent).toContain('evidence A');
    expect(el!.querySelectorAll('.pmd-card').length).toBe(2);
    // The zone is contenteditable=false (read-only).
    expect(el!.getAttribute('contenteditable')).toBe('false');
    view.destroy();
  });

  it('detach replaces the zone with editable cards, fresh ids, no zone left', () => {
    const zone = createTransclusionNode(schema, {
      source_ref: 'a.cmir',
      source_heading_id: 'h1',
      cached_content: [card('T1', 'e1').toJSON(), card('T2', 'e2').toJSON()],
    });
    const view = makeView([zone]);
    expect(countTypes(view)).toEqual({ cards: 0, zones: 1 });

    const ok = detachZoneAtPos(view, 0);
    expect(ok).toBe(true);
    const after = countTypes(view);
    expect(after.zones).toBe(0);
    expect(after.cards).toBe(2);
    // Content survives as real, editable nodes.
    expect(view.state.doc.textContent).toContain('e1');
    expect(view.state.doc.textContent).toContain('e2');
    view.destroy();
  });

  it('detach of an empty zone just removes it', () => {
    const zone = createTransclusionNode(schema, { cached_content: null });
    const view = makeView([zone, schema.nodes['paragraph']!.create(null, schema.text('after'))]);
    detachZoneAtPos(view, 0);
    expect(countTypes(view).zones).toBe(0);
    expect(view.state.doc.textContent).toContain('after');
    view.destroy();
  });

  it('insertZoneAtSelection inserts one zone at the top level', () => {
    const view = makeView([schema.nodes['paragraph']!.create(null, schema.text('hello'))]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const ok = insertZoneAtSelection(view, {
      source_ref: 'a.cmir',
      source_heading_id: 'h1',
      cached_content: [card('X', 'y').toJSON()],
      source_label: 'Src to X',
    });
    expect(ok).toBe(true);
    expect(countTypes(view).zones).toBe(1);
    // The inserted zone is selected as a NodeSelection.
    expect(view.state.selection instanceof NodeSelection).toBe(true);
    // And it renders.
    expect(view.dom.querySelector('.pmd-transclusion')).toBeTruthy();
    view.destroy();
  });

  it('a refreshed cache updates the rendered body (simulating a refresh dispatch)', () => {
    const zone = createTransclusionNode(schema, {
      source_ref: 'a.cmir',
      source_heading_id: 'h1',
      cached_content: [card('Old Tag', 'old evidence').toJSON()],
      last_refreshed: 1,
    });
    const view = makeView([zone]);
    expect(view.dom.querySelector('.pmd-transclusion')!.textContent).toContain('old evidence');
    // Simulate what refreshZoneAtPos does on success: setNodeMarkup with a new cache.
    const tr = view.state.tr.setNodeMarkup(0, undefined, {
      ...view.state.doc.nodeAt(0)!.attrs,
      cached_content: [card('New Tag', 'new evidence').toJSON()],
      content_hash: 'different',
      last_refreshed: 2,
    });
    view.dispatch(tr);
    const el = view.dom.querySelector('.pmd-transclusion')!;
    expect(el.textContent).toContain('new evidence');
    expect(el.textContent).not.toContain('old evidence');
    view.destroy();
  });
});
