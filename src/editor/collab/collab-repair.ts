/**
 * The tables/cards repair pass, wired into sessions (§4.4).
 *
 * `buildDocRepairTr` (doc-repair.ts, M0) is the deterministic, pure,
 * idempotent repair: prosemirror-tables' `fixTables` for ragged rows
 * and colspan overflow (the row-insert-vs-column-insert merge), the
 * mutually-exclusive-marks sweep, and the container first-child
 * invariant (a `card` opens with a `tag`, an `analytic_unit` with an
 * `analytic`). This plugin runs it after every remote batch and every
 * undo/redo, leader-gated per §4.3:
 *
 *   - LEADER (lowest peer id among self + presence-visible peers)
 *     dispatches the repair; followers suppress theirs and receive the
 *     leader's synced fix within a round-trip. Structural repairs are
 *     insertions — two peers repairing the same merged state emit
 *     concurrent ops with distinct identities, and CRDTs do not dedupe
 *     semantically identical content (double-padded tables).
 *   - The gate is BEST-EFFORT: presence can be empty (cursors setting
 *     off, frames lost), making everyone leader. That degrades to
 *     churn, not corruption — the repair is idempotent on its own
 *     output and the normalizer round cap stops any dispatch loop.
 *
 * Repair transactions carry the normalizer origin (read mode admits
 * them; the round cap applies) and sync like ordinary edits.
 */

import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { loroSyncPluginKey, loroUndoPluginKey } from 'loro-prosemirror';
import { buildDocRepairTr, buildMarkRepairTr } from '../../doc-repair.js';
import { guardNormalizerTr } from '../normalizer-guard.js';

function isBindingTransaction(tr: Transaction): boolean {
  return tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined;
}

export function collabRepairPlugin(isLeader: () => boolean): Plugin {
  return new Plugin({
    appendTransaction(trs, _oldState, newState) {
      if (!trs.some((tr) => tr.docChanged && isBindingTransaction(tr))) return null;
      // The exclusive-marks resolution runs on EVERY peer: it's
      // mark-level and deterministic (every peer picks the same winner
      // via the schema-derived total order), so double-application
      // converges under LWW — and a follower must not hold a
      // schema-invalid underline+emphasis run waiting on the leader's
      // fix to arrive. The STRUCTURAL half (tables + container
      // first-child) stays leader-gated: those are insertions, and two
      // peers repairing the same merged state emit concurrent ops with
      // distinct identities that would duplicate content.
      const tr = isLeader() ? buildDocRepairTr(newState) : buildMarkRepairTr(newState);
      if (!tr) return null;
      return guardNormalizerTr(trs, tr);
    },
  });
}

/** §4.3 leader rule: lowest peer id wins, comparing self against the
 *  presence-visible peers. Peer ids are decimal u64 strings — compare
 *  numerically via BigInt, not lexically. */
export function lowestPeerIsLeader(selfPeerId: string, visible: string[]): boolean {
  try {
    const self = BigInt(selfPeerId);
    for (const p of visible) {
      if (BigInt(p) < self) return false;
    }
    return true;
  } catch {
    return true; // malformed peer id in presence — repair locally (safe)
  }
}
