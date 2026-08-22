// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  DOMSerializer,
  DOMParser as PMDOMParser,
  type Node as PMNode,
  type Slice,
} from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { dedupeHeadingIds, rewriteHeadingIds } from '../../src/editor/drag-controller.js';

/** A throwaway editor view over `nodes` — `transformPasted` reads
 *  `view.state` for the selection (live-zone check) and for the doc whose
 *  ids a pasted id has to be unique against. */
function makeView(...nodes: PMNode[]): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const doc = schema.nodes['doc']!.createChecked(
    null,
    nodes.length > 0
      ? nodes
      : [schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Home'))],
  );
  return new EditorView(el, { state: EditorState.create({ doc }) });
}

function pocket(t: string, id = newHeadingId()) {
  return schema.nodes['pocket']!.create({ id }, schema.text(t));
}
function block(t: string, id = newHeadingId()) {
  return schema.nodes['block']!.create({ id }, schema.text(t));
}
function cardWith(t: string, id = newHeadingId()) {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(t)),
  ]);
}

/** Round-trip a fragment through copy (toDOM -> HTML) and paste-parse
 *  (HTML -> schema), the way PM's clipboard does. */
function copyPasteParse(...nodes: PMNode[]) {
  const doc = schema.nodes['doc']!.createChecked(null, nodes);
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return PMDOMParser.fromSchema(schema).parseSlice(div);
}

function idsByType(node: PMNode) {
  const out: Array<{ type: string; id: unknown }> = [];
  node.descendants((n) => {
    if (['pocket', 'hat', 'block', 'tag', 'analytic'].includes(n.type.name)) {
      out.push({ type: n.type.name, id: n.attrs['id'] });
    }
    return true;
  });
  return out;
}

/** Collect heading ids across a whole slice (wrap in a doc so the
 *  top-level heading nodes themselves are visited, not just descendants). */
function sliceIds(content: PMNode['content']) {
  return idsByType(schema.nodes['doc']!.createChecked(null, content));
}

const ctx = {
  condenseOnPaste: () => false,
  paragraphIntegrity: () => false,
  usePilcrows: () => false,
  smartPasteConversion: () => false,
  headingMode: () => 'strict' as const,
};

function pasted(slice: Slice, view: EditorView) {
  const plugin = buildPastePlugin(ctx);
  return plugin.props.transformPasted!.call(plugin, slice, view, false);
}

describe('paste heading ids', () => {
  it('carries the id through the clipboard round trip', () => {
    const kept = newHeadingId();
    const slice = copyPasteParse(pocket('P', kept));
    // `toDOM` writes data-id and the parser now reads it, which is what
    // lets a move be told from a copy at all.
    expect(sliceIds(slice.content)).toEqual([{ type: 'pocket', id: kept }]);
  });

  it('keeps the ids of content the document no longer holds: a move', () => {
    const moved = [newHeadingId(), newHeadingId(), newHeadingId()];
    const slice = pasted(
      copyPasteParse(pocket('P', moved[0]), block('B', moved[1]), cardWith('C', moved[2])),
      // A cut left the doc without any of them.
      makeView(),
    );

    expect(sliceIds(slice.content)).toEqual([
      { type: 'pocket', id: moved[0] },
      { type: 'block', id: moved[1] },
      { type: 'tag', id: moved[2] },
    ]);
  });

  it('mints fresh ids for content the document still holds: a copy', () => {
    const live = newHeadingId();
    const slice = pasted(copyPasteParse(pocket('P', live)), makeView(pocket('P', live)));

    const [entry] = sliceIds(slice.content);
    expect(typeof entry!.id).toBe('string');
    expect(entry!.id).not.toBe(live);
  });

  it('mints for a heading that arrives without an id, which would be inert', () => {
    // Foreign HTML in our shape: the nav pane, jump and the level filter
    // all key off the id.
    const div = document.createElement('div');
    div.innerHTML = '<h1 class="pmd-pocket">Untracked</h1>';
    const slice = pasted(PMDOMParser.fromSchema(schema).parseSlice(div), makeView());

    expect(typeof sliceIds(slice.content)[0]!.id).toBe('string');
  });

  it('keeps a pasted slice unique against itself, not only against the doc', () => {
    const twice = newHeadingId();
    const slice = pasted(copyPasteParse(pocket('First', twice), block('Second', twice)), makeView());

    const ids = sliceIds(slice.content).map((e) => e.id);
    expect(ids[0]).toBe(twice);
    expect(ids[1]).not.toBe(twice);
  });

  it('rewriteHeadingIds still replaces every id it finds', () => {
    const original = newHeadingId();
    const slice = copyPasteParse(pocket('P', original));
    // The copy paths duplicate live content, so every id has to move.
    expect(rewriteHeadingIds(slice).content.firstChild!.attrs['id']).not.toBe(original);
  });

  it('dedupeHeadingIds preserves slice open depths and content', () => {
    const slice = copyPasteParse(pocket('Title'), cardWith('Card'));
    const out = dedupeHeadingIds(slice, makeView().state.doc);
    expect(out.openStart).toBe(slice.openStart);
    expect(out.openEnd).toBe(slice.openEnd);
    expect(out.content.firstChild!.textContent).toBe('Title');
  });
});
