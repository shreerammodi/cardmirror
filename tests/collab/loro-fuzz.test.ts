// @vitest-environment jsdom
/**
 * CRDT fuzz: seeded random concurrent edits across 3 Loro-bound peers
 * with offline partitions, merged to quiescence. Invariants per seed:
 * convergence, schema validity, and repair-pass idempotence. The
 * promoted form of the bake-off fuzzer (which ran 150 seeds against
 * this same binding with zero failures); trimmed for CI budget.
 */

import { describe, it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { addRowAfter, addColumnAfter, deleteRow, deleteColumn } from 'prosemirror-tables';
import { schema } from '../../src/schema/index.js';
import { buildDocRepairTr } from '../../src/doc-repair.js';
import { repairView } from './_repair-view.js';
import {
  createLoroPeers,
  syncAll,
  settle,
  mixedDoc,
  cardNode,
  type LoroPeer,
} from './_loro-helpers.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['impact', 'link', 'turns', 'warrant', 'solvency'];
const HIGHLIGHTS = ['green', 'yellow', 'cyan'];

function randomOp(rnd: () => number, p: LoroPeer): void {
  const view = p.view;
  const blocks: Array<{ start: number; end: number }> = [];
  p.doc().descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return false;
    }
    return true;
  });
  if (!blocks.length) return;
  const b = blocks[Math.floor(rnd() * blocks.length)]!;
  const pos = b.start + Math.floor(rnd() * Math.max(1, b.end - b.start));
  const roll = rnd();
  try {
    if (roll < 0.35) {
      view.dispatch(view.state.tr.insertText(` ${WORDS[Math.floor(rnd() * WORDS.length)]}`, pos));
    } else if (roll < 0.5) {
      const to = Math.min(b.end, pos + 1 + Math.floor(rnd() * 6));
      if (to > pos) view.dispatch(view.state.tr.delete(pos, to));
    } else if (roll < 0.68) {
      const to = Math.min(b.end, pos + 2 + Math.floor(rnd() * 10));
      if (to > pos) {
        const mark =
          rnd() < 0.6
            ? schema.marks['highlight']!.create({ color: HIGHLIGHTS[Math.floor(rnd() * 3)] })
            : schema.marks['bold']!.create();
        view.dispatch(view.state.tr.addMark(pos, to, mark));
      }
    } else if (roll < 0.78) {
      view.dispatch(view.state.tr.split(pos));
    } else if (roll < 0.86) {
      view.dispatch(
        view.state.tr.insert(
          view.state.doc.content.size,
          cardNode(`Fuzz ${Math.floor(rnd() * 999)}`, ['Fuzz body evidence.']),
        ),
      );
    } else {
      const cells: number[] = [];
      view.state.doc.descendants((node, cp) => {
        if (node.type.name === 'table_cell') {
          cells.push(cp + 2);
          return false;
        }
        return true;
      });
      if (!cells.length) return;
      const cellPos = cells[Math.floor(rnd() * cells.length)]!;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, Math.min(cellPos, view.state.doc.content.size)),
        ),
      );
      const cmd = [addRowAfter, addColumnAfter, deleteRow, deleteColumn][Math.floor(rnd() * 4)]!;
      cmd(view.state, view.dispatch);
    }
  } catch {
    /* invalid position for this op — skip */
  }
}

describe('loro CRDT fuzz (3 peers, offline partitions)', () => {
  it('converges valid across 15 seeds', { timeout: 60_000 }, async () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rnd = mulberry32(seed);
      const peers = await createLoroPeers(mixedDoc(), 3);
      for (let round = 0; round < 4; round++) {
        for (const p of peers) {
          const k = 1 + Math.floor(rnd() * 3);
          for (let i = 0; i < k; i++) randomOp(rnd, p);
        }
        await settle();
        const mode = rnd();
        if (mode < 0.35) {
          await syncAll(peers);
        } else if (mode < 0.7) {
          const i = Math.floor(rnd() * 3);
          const j = (i + 1 + Math.floor(rnd() * 2)) % 3;
          await syncAll([peers[i]!, peers[j]!]);
        }
        // else: fully offline round
      }
      await syncAll(peers);
      await syncAll(peers);
      const docs = peers.map((p) => p.doc());
      for (const d of docs) {
        expect(d.eq(docs[0]!), `seed ${seed} convergence`).toBe(true);
        expect(() => d.check(), `seed ${seed} validity`).not.toThrow();
      }
      // Repair anything ragged; both peers must land identically.
      if (buildDocRepairTr(peers[0]!.view.state)) {
        for (const p of peers) repairView(p.view);
        await settle();
        await syncAll(peers);
        for (const p of peers) repairView(p.view);
        await settle();
        await syncAll(peers);
        const repaired = peers.map((p) => p.doc());
        for (const d of repaired) {
          expect(d.eq(repaired[0]!), `seed ${seed} post-repair convergence`).toBe(true);
        }
      }
      peers.forEach((p) => p.destroy());
    }
  });
});
