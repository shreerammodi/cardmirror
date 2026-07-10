// @vitest-environment jsdom
/**
 * The intra-doc window end-to-end in a real EditorView: it projects the source
 * section read-only, RE-RENDERS live when the source is edited (via the plugin's
 * decoration → NodeView.update), and Unlink/Delete behave.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { selfRefNodeViews } from '../../src/editor/self-transclusion-nodeview.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import {
  unlinkSelfRef,
  deleteSelfRef,
  insertSelfRef,
  jumpToSelfRefSource,
} from '../../src/editor/self-transclusion-commands.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

const SRC = 'src';
function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    block('Source', SRC),
    card('A', 'alpha'),
    block('Elsewhere', 'oth'),
    createSelfRefNode(schema, SRC, '↳ Source'),
  ]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({ doc, plugins: [makeSelfRefPlugin()] }),
    nodeViews: selfRefNodeViews,
  });
}

function windowText(view: EditorView): string {
  return (view.dom.querySelector('.pmd-self-ref-body') as HTMLElement | null)?.textContent ?? '';
}
function selfRefPos(view: EditorView): number {
  let pos = -1;
  view.state.doc.forEach((n, off) => {
    if (pos < 0 && isSelfRef(n)) pos = off;
  });
  return pos;
}
/** End of the first card_body's text (a spot inside the source section). */
function endOfSourceCard(view: EditorView): number {
  let end = -1;
  view.state.doc.descendants((n, pos) => {
    if (end < 0 && n.type.name === 'card_body') end = pos + 1 + n.content.size;
    return end < 0;
  });
  return end;
}

describe('self_ref window — live projection', () => {
  it('projects the source section as real (read-only) content', () => {
    const view = makeView();
    expect(windowText(view)).toContain('alpha');
    // The view holds a real mirrored card as child content, not a leaf atom.
    expect(view.state.doc.nodeAt(selfRefPos(view))!.childCount).toBeGreaterThan(0);
    view.destroy();
  });

  it('re-renders when the source is edited', () => {
    const view = makeView();
    expect(windowText(view)).toContain('alpha');
    // Append " EDIT" to the end of the source card's body.
    const at = endOfSourceCard(view);
    view.dispatch(view.state.tr.insertText(' EDIT', at));
    expect(windowText(view)).toContain('alpha EDIT');
    view.destroy();
  });

  it('reflects a card added to the source section', () => {
    const view = makeView();
    // Insert a new card right before the "Elsewhere" block (end of Source section).
    let othPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.attrs?.['id'] === 'oth') othPos = off;
    });
    view.dispatch(view.state.tr.insert(othPos, card('B', 'bravo')));
    expect(windowText(view)).toContain('alpha');
    expect(windowText(view)).toContain('bravo');
    view.destroy();
  });

  it('shows a notice when the source heading is gone', () => {
    const view = makeView();
    // Delete the Source block heading (and only it).
    view.dispatch(view.state.tr.delete(0, block('Source', SRC).nodeSize));
    const note = view.dom.querySelector('.pmd-self-ref-note') as HTMLElement;
    expect(note.style.display).not.toBe('none'); // shown
    expect(note.textContent!.toLowerCase()).toContain('not found');
    view.destroy();
  });

  it('the projection carries only BLANK ids (no collision with the real source)', () => {
    const view = makeView();
    const body = view.dom.querySelector('.pmd-self-ref-body') as HTMLElement;
    const ids = [...body.querySelectorAll('[data-id]')].map((el) => el.getAttribute('data-id'));
    // Every mirrored heading id is blank — never a real source id — so
    // [data-id="<real id>"] scroll lookups target the true source, not this copy.
    expect(ids.every((id) => id === '')).toBe(true);
    // The real source card keeps its non-empty id.
    expect([...view.dom.querySelectorAll('[data-id]')].some((el) => el.getAttribute('data-id'))).toBe(true);
    view.destroy();
  });

  it('Go to source jumps to the real source heading, not the window', () => {
    const view = makeView();
    // Park the cursor away from the source first.
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    jumpToSelfRefSource(view, SRC);
    // Selection landed inside the real "Source" block (at its start), which sits
    // before the window in the doc.
    const srcPos = 0; // "Source" block is the first node
    expect(view.state.selection.from).toBeLessThan(selfRefPos(view));
    expect(view.state.selection.from).toBeGreaterThanOrEqual(srcPos);
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe('Source');
    view.destroy();
  });
});

describe('self_ref window — actions', () => {
  it('Unlink freezes the current projection into real editable cards', () => {
    const view = makeView();
    unlinkSelfRef(view, selfRefPos(view));
    // No more self_ref; the source content now exists as a real card after Elsewhere.
    expect(selfRefPos(view)).toBe(-1);
    const bodies: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === 'card_body') bodies.push(n.textContent);
      return true;
    });
    // Source's own 'alpha' + the unlinked copy 'alpha'.
    expect(bodies.filter((b) => b === 'alpha')).toHaveLength(2);
    view.destroy();
  });

  it('Delete removes the window', () => {
    const view = makeView();
    deleteSelfRef(view, selfRefPos(view));
    expect(selfRefPos(view)).toBe(-1);
    // The source section is untouched.
    let alpha = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'card_body' && n.textContent === 'alpha') alpha++;
      return true;
    });
    expect(alpha).toBe(1);
    view.destroy();
  });

  it('insertSelfRef drops a live window at the cursor', () => {
    // A doc with a source section but no window yet.
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', SRC),
      card('A', 'alpha'),
      block('Here', 'here'),
    ]);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView(el, {
      state: EditorState.create({ doc, plugins: [makeSelfRefPlugin()] }),
      nodeViews: selfRefNodeViews,
    });
    // Cursor at the end (inside/after "Here"), then insert a window onto Source.
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(insertSelfRef(view, SRC)).toBe(true);
    expect(selfRefPos(view)).toBeGreaterThanOrEqual(0);
    expect(windowText(view)).toContain('alpha');
    view.destroy();
  });
});
