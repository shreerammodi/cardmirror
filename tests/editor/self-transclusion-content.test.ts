// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { selfRefNodeViews } from '../../src/editor/self-transclusion-nodeview.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import { collectHeadings } from '../../src/editor/headings.js';

const block = (t: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(t));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function mount(children: PMNode[]): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({ doc: schema.nodes['doc']!.create(null, children), plugins: [makeSelfRefPlugin()] }),
    nodeViews: selfRefNodeViews,
  });
}
function selfRefNode(view: EditorView): { node: PMNode; pos: number } {
  let r: { node: PMNode; pos: number } | null = null;
  view.state.doc.descendants((n, pos) => {
    if (!r && isSelfRef(n)) r = { node: n, pos };
    return !r;
  });
  return r!;
}
const bodyText = (view: EditorView): string =>
  (view.dom.querySelector('.pmd-self-ref-body') as HTMLElement | null)?.textContent ?? '';

describe('content-node live view — core', () => {
  it('populates the view from the source on mount', () => {
    const view = mount([block('Src', 'src'), card('Alpha', 'alpha'), block('Home', 'home'), createSelfRefNode(schema, 'src', '↳ Src')]);
    const { node } = selfRefNode(view);
    // The self_ref now has REAL children mirroring the source card.
    expect(node.content.childCount).toBeGreaterThan(0);
    expect(bodyText(view)).toContain('alpha');
    view.destroy();
  });

  it('re-derives when the source is edited', () => {
    const view = mount([block('Src', 'src'), card('Alpha', 'alpha'), block('Home', 'home'), createSelfRefNode(schema, 'src', '↳ Src')]);
    // Edit the source card body.
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'card_body') at = pos + 1 + n.content.size;
      return at < 0;
    });
    view.dispatch(view.state.tr.insertText(' EDIT', at));
    expect(bodyText(view)).toContain('alpha EDIT');
    view.destroy();
  });

  it('BLOCKS an edit inside the view (read-only)', () => {
    const view = mount([block('Src', 'src'), card('Alpha', 'alpha'), block('Home', 'home'), createSelfRefNode(schema, 'src', '↳ Src')]);
    const before = view.state.doc.toString();
    // Find a text position INSIDE the view's mirrored card body and try to type.
    const { pos, node } = selfRefNode(view);
    let insidePos = -1;
    node.descendants((n, off) => {
      if (insidePos < 0 && n.type.name === 'card_body') insidePos = pos + 1 + off + 1;
      return insidePos < 0;
    });
    expect(insidePos).toBeGreaterThan(0);
    view.dispatch(view.state.tr.insertText('X', insidePos)); // should be filtered out
    expect(view.state.doc.toString()).toBe(before); // unchanged — edit rejected
    view.destroy();
  });

  it('the populated view stays OPAQUE to collectHeadings (no derived children as outline/drag entries)', () => {
    // The plugin re-derives the view's children (id-less mirror). collectHeadings
    // (which feeds the outline AND drag drop-slots) must treat the view as one
    // opaque unit — its derived children must NOT become entries, or the nav
    // would double-show them and a drag could drop INSIDE the read-only view.
    const view = mount([block('Src', 'src'), card('Alpha', 'alpha'), block('Home', 'home'), createSelfRefNode(schema, 'src', '↳ Src')]);
    expect(view.state.doc.nodeAt(selfRefNode(view).pos)!.childCount).toBeGreaterThan(0); // populated
    const tags = collectHeadings(view.state.doc).filter((e) => e.type === 'tag');
    // Only the REAL source card 'Alpha' (real id) — never the view's blank-id copy.
    expect(tags.length).toBe(1);
    expect(tags[0]!.id).toBeTruthy();
    view.destroy();
  });

  it('a TextSelection can SPAN the view (no atom boundary)', () => {
    const view = mount([
      block('Src', 'src'),
      card('Alpha', 'alpha'),
      block('Home', 'home'),
      card('Above', 'above'),
      createSelfRefNode(schema, 'src', '↳ Src'),
      card('Below', 'below'),
    ]);
    const { pos, node } = selfRefNode(view);
    // From inside "Above" to inside "Below", crossing the view.
    const sel = TextSelection.between(view.state.doc.resolve(pos - 4), view.state.doc.resolve(pos + node.nodeSize + 4));
    view.dispatch(view.state.tr.setSelection(sel));
    expect(view.state.selection.from).toBeLessThanOrEqual(pos);
    expect(view.state.selection.to).toBeGreaterThanOrEqual(pos + node.nodeSize);
    view.destroy();
  });
});
