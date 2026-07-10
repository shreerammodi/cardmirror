// @vitest-environment jsdom
/**
 * Live view (content-node `self_ref`) under co-editing. Its mirrored children are
 * DERIVED and LOCAL: a loro-prosemirror patch (`normalizeNodeContent` returns []
 * for `self_ref`) holds them out of sync, and the content plugin re-derives them
 * from the SHARED source on every peer. So concurrent source edits merge the
 * source normally and each peer re-derives the same projection — no derived
 * content in the CRDT, no concurrent-re-projection garble.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { isSelfRef } from '../../src/editor/self-transclusion.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import { createLoroPeers, syncAll, docOf, type LoroPeer } from './_loro-helpers.js';

const block = (t: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(t));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function selfRef(headingId: string, children: PMNode[] = []): PMNode {
  return schema.nodes['self_ref']!.create({ source_heading_id: headingId, source_label: '↳ Src' }, Fragment.fromArray(children));
}
function viewOf(doc: PMNode): PMNode {
  let v: PMNode | null = null;
  doc.descendants((n) => {
    if (!v && isSelfRef(n)) v = n;
    return !v;
  });
  return v!;
}
function sourceBodyPos(doc: PMNode): number {
  // The source card's body end (inside block 'src').
  let p = -1;
  doc.descendants((n, pos) => {
    if (p < 0 && n.type.name === 'card_body') p = pos + 1 + n.content.size;
    return p < 0;
  });
  return p;
}
const viewText = (doc: PMNode): string => viewOf(doc).textContent;

describe('collab: content-node live view (local-only children)', () => {
  it('the view children are EXCLUDED from sync (a bare peer receives it childless)', async () => {
    // Seed a view that ALREADY has children; a peer with no re-derive plugin
    // should still receive it childless (the patch kept the children out of Loro).
    const seed = docOf(block('Src', 'src'), card('S', 'zero'), block('Home', 'home'), selfRef('src', [card('S', 'zero')]));
    const [bare] = await createLoroPeers(seed, 1); // no makeSelfRefPlugin
    expect(viewOf(bare!.doc()).childCount).toBe(0); // children never synced
    bare!.destroy();
  });

  it('populates on mount, and concurrent source edits converge with no garble', async () => {
    const seed = docOf(block('Src', 'src'), card('S', '0'), block('Home', 'home'), selfRef('src'));
    const peers = await createLoroPeers(seed, 2, () => [makeSelfRefPlugin()]);
    const [a, b] = peers as [LoroPeer, LoroPeer];

    // Each peer re-derived the view locally on mount.
    expect(viewText(a.doc())).toContain('0');
    expect(viewText(b.doc())).toContain('0');

    // Concurrent SOURCE edits (real, synced content); each peer's re-derive fires.
    a.view.dispatch(a.view.state.tr.insertText('A', sourceBodyPos(a.doc())));
    b.view.dispatch(b.view.state.tr.insertText('B', sourceBodyPos(b.doc())));
    await syncAll(peers);

    // Full convergence: identical docs.
    expect(a.doc().toJSON()).toEqual(b.doc().toJSON());
    // The source merged (both edits present), and the view mirrors it exactly —
    // ONE card, not duplicated/garbled.
    const view = viewOf(a.doc());
    expect(view.childCount).toBe(1);
    // Source body text == view body text (the view is project(source)).
    const srcBody = a.doc().child(1).textContent; // card 'S'
    expect(view.textContent).toBe(srcBody);
    expect(srcBody).toContain('A');
    expect(srcBody).toContain('B');
    peers.forEach((p) => p.destroy());
  });
});
