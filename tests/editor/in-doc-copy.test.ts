// @vitest-environment jsdom
/**
 * In-document LINKED COPY (`transclusion_ref` with an in-doc source): an editable
 * snapshot of another section of the same doc, refreshable, that resolves from
 * the LIVE doc (no file read) — for create, refresh, and divergence.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  isTransclusionNode,
  isInDocCopy,
  SELF_SOURCE_REF,
} from '../../src/editor/transclusion.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { buildInDocCopyAttrs, refreshZoneAtPos } from '../../src/editor/transclusion-actions.js';
import { insertInDocCopy } from '../../src/editor/self-transclusion-commands.js';
import { checkAllZoneDivergence, inDocDivergence } from '../../src/editor/transclusion-divergence.js';

const block = (t: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(t));
function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function inDocCopyNode(doc: PMNode, headingId: string): PMNode {
  const o = buildInDocCopyAttrs(doc, headingId);
  if (!o.ok || !o.attrs) throw new Error('build failed: ' + o.reason);
  return createTransclusionNode(schema, o.attrs, o.content);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc }) });
}
function copyPos(view: EditorView): number {
  let p = -1;
  view.state.doc.forEach((n, off) => {
    if (p < 0 && isTransclusionNode(n)) p = off;
  });
  return p;
}
function copyBodies(view: EditorView): string[] {
  const node = view.state.doc.nodeAt(copyPos(view))!;
  const out: string[] = [];
  node.descendants((n) => {
    if (n.type.name === 'card_body') out.push(n.textContent);
    return true;
  });
  return out;
}
function endOfFirstCardBody(view: EditorView): number {
  let end = -1;
  view.state.doc.descendants((n, pos) => {
    if (end < 0 && n.type.name === 'card_body') end = pos + 1 + n.content.size;
    return end < 0;
  });
  return end;
}

describe('buildInDocCopyAttrs', () => {
  it('builds a by-value copy marked as an in-doc source', () => {
    const d = schema.nodes['doc']!.create(null, [block('Src', 'src'), card('A', 'alpha')]);
    const o = buildInDocCopyAttrs(d, 'src');
    expect(o.ok).toBe(true);
    expect(o.attrs!.source_ref).toBe(SELF_SOURCE_REF);
    const node = createTransclusionNode(schema, o.attrs!, o.content);
    expect(isInDocCopy(node)).toBe(true);
    // Content is baked in (by value), unlike a live view.
    expect(node.content.size).toBeGreaterThan(0);
  });

  it('flattens a nested live view inside the copy (a copy is a flat snapshot — no stacked rails)', () => {
    const d = schema.nodes['doc']!.create(null, [
      block('Other', 'other'),
      card('O', 'other-ev'),
      block('Src', 'src'),
      card('A', 'alpha'),
      createSelfRefNode(schema, 'other', '↳ Other'),
      block('End', 'end'),
    ]);
    const o = buildInDocCopyAttrs(d, 'src');
    expect(o.ok).toBe(true);
    let selfRefs = 0;
    o.content!.descendants((n) => {
      if (isSelfRef(n)) selfRefs++;
      return true;
    });
    // The live view is materialized to plain cards (resolved against the doc), not
    // kept — so the copy never carries a second transclusion rail.
    expect(selfRefs).toBe(0);
    expect(o.content!.textBetween(0, o.content!.size, ' ')).toContain('other-ev');
  });

  it('refuses an empty or missing section', () => {
    const d = schema.nodes['doc']!.create(null, [block('Empty', 'e')]);
    expect(buildInDocCopyAttrs(d, 'e').ok).toBe(false); // empty
    expect(buildInDocCopyAttrs(d, 'gone').ok).toBe(false); // missing
  });
});

describe('in-doc copy — refresh resolves from the live doc', () => {
  it('re-pulls the current source content on refresh (no file read)', async () => {
    const src = [block('Src', 'src'), card('A', 'alpha'), block('Elsewhere', 'oth')];
    const copy = inDocCopyNode(schema.nodes['doc']!.create(null, src), 'src');
    const view = makeView([...src, copy]);
    expect(copyBodies(view)).toEqual(['alpha']);

    // Edit the SOURCE card, then refresh the copy.
    const at = endOfFirstCardBody(view);
    view.dispatch(view.state.tr.insertText(' EDIT', at));
    expect(copyBodies(view)).toEqual(['alpha']); // copy unchanged until refresh
    const outcome = await refreshZoneAtPos(view, copyPos(view), { confirmEdits: false });
    expect(outcome.ok).toBe(true);
    expect(copyBodies(view)).toEqual(['alpha EDIT']); // now re-pulled
    expect(isInDocCopy(view.state.doc.nodeAt(copyPos(view))!)).toBe(true); // still in-doc
    view.destroy();
  });
});

describe('in-doc copy — divergence against the live source', () => {
  it('flags the copy when the in-doc source changes', async () => {
    const src = [block('Src', 'src'), card('A', 'alpha'), block('Elsewhere', 'oth')];
    const view = makeView([...src, inDocCopyNode(schema.nodes['doc']!.create(null, src), 'src')]);
    // Unchanged → not diverged.
    let r = await checkAllZoneDivergence(view);
    expect(r.diverged.size).toBe(0);
    // Edit the source → diverged (resolved live from the doc, no file).
    view.dispatch(view.state.tr.insertText(' NEW', endOfFirstCardBody(view)));
    r = await checkAllZoneDivergence(view);
    expect(r.checked).toBe(1);
    expect(r.diverged.size).toBe(1);
    view.destroy();
  });
});

describe('insertInDocCopy', () => {
  it('drops an editable linked copy at the cursor', () => {
    const view = makeView([block('Src', 'src'), card('A', 'alpha'), block('Here', 'here')]);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(insertInDocCopy(view, 'src')).toBe(true);
    const node = view.state.doc.nodeAt(copyPos(view))!;
    expect(isInDocCopy(node)).toBe(true);
    expect(copyBodies(view)).toEqual(['alpha']);
    view.destroy();
  });
});

describe('inDocDivergence (sync, backs the instant badge)', () => {
  it('reports the in-doc copy identity and whether it diverged', () => {
    const srcNodes = [block('Src', 'src'), card('A', 'alpha'), block('Elsewhere', 'oth')];
    const copy = inDocCopyNode(schema.nodes['doc']!.create(null, srcNodes), 'src');

    // Unchanged source → tracked but not diverged.
    const same = inDocDivergence(schema.nodes['doc']!.create(null, [...srcNodes, copy]));
    expect(same.all.size).toBe(1);
    expect(same.diverged.size).toBe(0);

    // Source card edited → diverged (same copy node, changed source section).
    const moved = inDocDivergence(
      schema.nodes['doc']!.create(null, [
        block('Src', 'src'),
        card('A', 'alpha CHANGED'),
        block('Elsewhere', 'oth'),
        copy,
      ]),
    );
    expect(moved.diverged.size).toBe(1);
  });
});
