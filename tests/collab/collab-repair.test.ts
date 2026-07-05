// @vitest-environment jsdom
/**
 * §4.4 production wiring: the repair pass runs AUTOMATICALLY inside a
 * session — leader-gated, normalizer-tagged, after remote batches —
 * with no manual repairView() call. T1 proved the repair itself; this
 * proves the session plumbing: the ragged row-vs-column merge squares
 * on its own, only the leader emits the fix, and the follower's copy
 * converges through sync.
 */

import { describe, it, expect } from 'vitest';
import { addRowAfter, addColumnAfter } from 'prosemirror-tables';
import { TextSelection } from 'prosemirror-state';
import { collabRepairPlugin, lowestPeerIsLeader } from '../../src/editor/collab/collab-repair.js';
import { buildDocRepairTr } from '../../src/doc-repair.js';
import { EditorState } from 'prosemirror-state';
import {
  createLoroPeers,
  syncAll,
  settle,
  docOf,
  tableNode,
  tableShapes,
  docText,
  findText,
  type LoroPeer,
} from './_loro-helpers.js';

function selectIn(peer: LoroPeer, text: string): void {
  const r = findText(peer.doc(), text);
  peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.create(peer.view.state.doc, r.from)));
}

describe('session-wired repair pass (leader-gated)', () => {
  it('T4: the ragged row-vs-column merge squares automatically, leader-only', async () => {
    // Leadership fixed deterministically for the test: peer A repairs,
    // peer B suppresses (in production the gate compares peer ids from
    // presence; lowestPeerIsLeader is unit-tested below).
    const peers = await createLoroPeers(docOf(tableNode(3, 3)), 2, () => []);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    // Rebuild views with the repair plugin included (createLoroPeers'
    // extraPlugins can't distinguish peers, so reconfigure directly).
    a.view.updateState(
      a.view.state.reconfigure({
        plugins: [...a.view.state.plugins, collabRepairPlugin(() => true)],
      }),
    );
    b.view.updateState(
      b.view.state.reconfigure({
        plugins: [...b.view.state.plugins, collabRepairPlugin(() => false)],
      }),
    );

    selectIn(a, 'c11');
    addRowAfter(a.view.state, a.view.dispatch);
    selectIn(b, 'c11');
    addColumnAfter(b.view.state, b.view.dispatch);
    await settle();
    await syncAll([a, b]);
    // The merge lands as a binding transaction → A's plugin repairs it
    // in the same dispatch cycle; the fix syncs to B.
    await syncAll([a, b]);

    expect(b.doc().eq(a.doc())).toBe(true);
    expect(() => a.doc().check()).not.toThrow();
    const rows = tableShapes(a.doc())[0]!;
    expect(new Set(rows).size).toBe(1); // rectangular, automatically
    for (const cellText of ['c00', 'c11', 'c22']) {
      expect(docText(a.doc())).toContain(cellText);
    }
    // Idempotent: nothing left to repair anywhere.
    expect(buildDocRepairTr(EditorState.create({ doc: a.doc() }))).toBeNull();
    expect(buildDocRepairTr(EditorState.create({ doc: b.doc() }))).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('leader election: lowest peer id wins, numerically', () => {
    expect(lowestPeerIsLeader('5', ['10', '7'])).toBe(true);
    expect(lowestPeerIsLeader('10', ['5'])).toBe(false);
    // decimal u64 strings must compare numerically, not lexically
    // (lexically '9' > '10' — numerically 9 < 10, so '9' leads)
    expect(lowestPeerIsLeader('9', ['10'])).toBe(true);
    expect(lowestPeerIsLeader('10', ['9'])).toBe(false);
    // alone in the room → leader
    expect(lowestPeerIsLeader('12345678901234567890', [])).toBe(true);
  });
});
