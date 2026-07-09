// @vitest-environment jsdom
/**
 * Remote-detach repaint: when one co-editing peer DETACHES a live zone, the other
 * peer's VIEW must repaint — the zone chrome (rail + glyph, the NodeView's own
 * DOM) has to be torn down, not left stale. A user reported a live zone that
 * "didn't unlink for Gabe"; the convergence studies show the DATA converges, so
 * the remaining suspect is a stale render on the receiving peer. These render the
 * real transclusion NodeView on Loro-bound peers and assert the chrome is gone
 * from the remote peer's DOM after the detach syncs.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { createLoroPeers, syncAll, settle, docOf, para, cardNode, type LoroPeer } from './_loro-helpers.js';
import { createTransclusionNode, isTransclusionNode } from '../../src/editor/transclusion.js';
import { detachZoneAtPos } from '../../src/editor/transclusion-actions.js';
import { transclusionNodeViews } from '../../src/editor/transclusion-nodeview.js';

function zoneDoc(): PMNode {
  const zone = createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H' },
    Fragment.fromArray([cardNode('Z1', ['zone body one']), cardNode('Z2', ['zone body two'])]),
  );
  return docOf(para('Intro paragraph before the zone here.'), zone, para('Outro paragraph after the zone.'));
}
function zonePos(doc: PMNode): number {
  let p = -1;
  doc.forEach((n, off) => {
    if (p < 0 && isTransclusionNode(n)) p = off;
  });
  return p;
}
function hasZoneNode(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (isTransclusionNode(n)) found = true;
    return true;
  });
  return found;
}
const chromeCount = (p: LoroPeer): number => p.view.dom.querySelectorAll('.pmd-transclusion').length;
const bodyText = (p: LoroPeer): string =>
  p.view.state.doc.textBetween(0, p.view.state.doc.content.size, ' ');

describe('remote detach repaints the receiving peer', () => {
  it('the zone chrome is torn down on the peer that receives a detach', async () => {
    const peers = await createLoroPeers(zoneDoc(), 2, undefined, transclusionNodeViews);
    await settle();
    const [A, B] = peers;
    // Both peers render the zone chrome to start with.
    expect(chromeCount(A!), 'A renders the zone').toBe(1);
    expect(chromeCount(B!), 'B renders the zone').toBe(1);

    // A detaches; sync to B.
    expect(detachZoneAtPos(A!.view, zonePos(A!.doc()))).toBe(true);
    await syncAll(peers);

    // Data converged and the zone node is gone on both.
    expect(A!.doc().eq(B!.doc()), 'peers converge').toBe(true);
    expect(hasZoneNode(B!.doc()), 'zone node removed on B').toBe(false);
    // The zone's cards survive as loose content on B.
    expect(bodyText(B!)).toContain('zone body one');
    expect(bodyText(B!)).toContain('zone body two');
    // The chrome (rail + glyph NodeView DOM) must be gone on BOTH — no stale zone.
    expect(chromeCount(A!), 'A repainted').toBe(0);
    expect(chromeCount(B!), 'B repainted (no stale live zone)').toBe(0);
    peers.forEach((p) => p.destroy());
  });

  it('a detach that races a concurrent in-zone edit still repaints both peers', async () => {
    const peers = await createLoroPeers(zoneDoc(), 2, undefined, transclusionNodeViews);
    await settle();
    const [A, B] = peers;

    // B edits inside the zone while (concurrently, offline) A detaches it.
    const zp = zonePos(B!.doc());
    const zn = B!.doc().nodeAt(zp)!;
    // Find a card_body inside the zone and type into it.
    let bodyAt = -1;
    B!.doc().nodesBetween(zp, zp + zn.nodeSize, (n, p) => {
      if (bodyAt < 0 && n.type.name === 'card_body') bodyAt = p + 1;
      return true;
    });
    B!.view.dispatch(B!.view.state.tr.insertText(' EDITED', bodyAt));
    detachZoneAtPos(A!.view, zonePos(A!.doc()));

    await syncAll(peers);

    expect(A!.doc().eq(B!.doc()), 'peers converge after the race').toBe(true);
    expect(chromeCount(A!), 'A repainted after race').toBe(0);
    expect(chromeCount(B!), 'B repainted after race').toBe(0);
    expect(hasZoneNode(A!.doc()), 'no zone node survives the race').toBe(false);
    peers.forEach((p) => p.destroy());
  });
});
