// @vitest-environment jsdom
/**
 * Peritext intent-preservation criteria + structural merge scenarios
 * against the pinned Loro binding and the real schema — the regression
 * form of the library bake-off's scenario suites. Expectations encode
 * the bake-off's measured outcomes; a Loro upgrade that changes any of
 * these is a semantics change and needs review, not a snapshot update.
 */

import { describe, it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { addRowAfter, addColumnAfter, deleteRow } from 'prosemirror-tables';
import { schema } from '../../src/schema/index.js';
import { repairView } from './_repair-view.js';
import {
  createLoroPeers,
  syncAll,
  settle,
  simpleDoc,
  docOf,
  para,
  tableNode,
  mixedDoc,
  findText,
  rangeFullyMarked,
  docText,
  tableShapes,
  addMarkOn,
  typeAfter,
  type LoroPeer,
} from './_loro-helpers.js';

const SENT = 'The quick fox jumped over the lazy dog tonight.';
const hl = (color: string) => schema.marks['highlight']!.create({ color });
const bold = () => schema.marks['bold']!.create();

async function merged(seed = simpleDoc(SENT)): Promise<[LoroPeer, LoroPeer]> {
  const [a, b] = await createLoroPeers(seed, 2);
  return [a!, b!];
}

async function converge(a: LoroPeer, b: LoroPeer): Promise<void> {
  await settle();
  await syncAll([a, b]);
  expect(b.doc().eq(a.doc())).toBe(true);
  expect(() => a.doc().check()).not.toThrow();
}

describe('Peritext criteria (inline marks)', () => {
  it('P1: same-color highlight overlap merges to the union', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'The quick fox', hl('green'));
    addMarkOn(b.view, 'fox jumped over', hl('green'));
    await converge(a, b);
    const union = findText(a.doc(), 'The quick fox jumped over');
    expect(rangeFullyMarked(a.doc(), union.from, union.to, schema.marks['highlight']!, { color: 'green' })).toBe(true);
    a.destroy(); b.destroy();
  });

  it('P2: bold overlap merges to the union', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'The quick fox', bold());
    addMarkOn(b.view, 'fox jumped over', bold());
    await converge(a, b);
    const union = findText(a.doc(), 'The quick fox jumped over');
    expect(rangeFullyMarked(a.doc(), union.from, union.to, schema.marks['bold']!)).toBe(true);
    a.destroy(); b.destroy();
  });

  it('P3: text typed concurrently inside a formatted span inherits the format', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'quick fox jumped', bold());
    typeAfter(b.view, 'fox', ' swiftly');
    await converge(a, b);
    const ins = findText(a.doc(), 'swiftly');
    expect(rangeFullyMarked(a.doc(), ins.from, ins.to, schema.marks['bold']!)).toBe(true);
    a.destroy(); b.destroy();
  });

  // P4/P5 (boundary insertion vs concurrent span CREATION): whether the
  // inserted text lands inside or outside the brand-new span is
  // tie-broken by peer id — Peritext's expand rules govern insertion at
  // an ESTABLISHED span's boundary, not one being created concurrently.
  // The guarantees here are convergence, no text loss, and identical
  // formatting on every peer; inclusion itself is legitimately either.
  it('P4/P5: concurrent span-creation + boundary insert converges without text loss', async () => {
    for (const mark of [bold(), schema.marks['link']!.create({ href: 'https://x.test' })]) {
      const [a, b] = await merged();
      addMarkOn(a.view, 'quick fox', mark);
      typeAfter(b.view, 'fox', 'es');
      await converge(a, b);
      const t = docText(a.doc());
      expect(t).toContain('foxes jumped');
      const span = findText(a.doc(), 'quick fox');
      expect(rangeFullyMarked(a.doc(), span.from, span.to, mark.type)).toBe(true);
      a.destroy(); b.destroy();
    }
  });

  it('P5b: an ESTABLISHED link does not grow over a later boundary insertion', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'quick fox', schema.marks['link']!.create({ href: 'https://x.test' }));
    await converge(a, b); // link established + synced on both peers
    // insertText with explicit no-marks so PM's local mark inheritance
    // (already excluded for link: inclusive false) isn't what's tested.
    const r = findText(b.doc(), 'fox');
    b.view.dispatch(b.view.state.tr.insertText('es', r.to));
    await converge(a, b);
    const ins = findText(a.doc(), 'es jumped');
    expect(rangeFullyMarked(a.doc(), ins.from, ins.from + 2, schema.marks['link']!)).toBe(false);
    a.destroy(); b.destroy();
  });

  it('P6: different-color overlap keeps both colors outside the overlap', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'The quick fox', hl('green'));
    addMarkOn(b.view, 'fox jumped over', hl('yellow'));
    await converge(a, b);
    const left = findText(a.doc(), 'The quick ');
    const right = findText(a.doc(), ' jumped over');
    expect(rangeFullyMarked(a.doc(), left.from, left.to, schema.marks['highlight']!, { color: 'green' })).toBe(true);
    expect(rangeFullyMarked(a.doc(), right.from, right.to, schema.marks['highlight']!, { color: 'yellow' })).toBe(true);
    a.destroy(); b.destroy();
  });

  it('P9: concurrent same-position typing does not interleave', async () => {
    const [a, b] = await merged();
    typeAfter(a.view, 'quick', 'AAAAA');
    typeAfter(b.view, 'quick', 'BBBBB');
    await converge(a, b);
    const t = docText(a.doc());
    expect(t).toContain('AAAAA');
    expect(t).toContain('BBBBB');
    a.destroy(); b.destroy();
  });

  it('P10: shading and highlight compose on the overlap', async () => {
    const [a, b] = await merged();
    addMarkOn(a.view, 'quick fox', schema.marks['shading']!.create({ color: 'D2D2D2' }));
    addMarkOn(b.view, 'fox jumped', hl('green'));
    await converge(a, b);
    const overlap = findText(a.doc(), 'fox');
    expect(rangeFullyMarked(a.doc(), overlap.from, overlap.to, schema.marks['shading']!)).toBe(true);
    expect(rangeFullyMarked(a.doc(), overlap.from, overlap.to, schema.marks['highlight']!)).toBe(true);
    a.destroy(); b.destroy();
  });
});

describe('structural merges (tables, cards) + repair pass', () => {
  function selectIn(peer: LoroPeer, text: string): void {
    const r = findText(peer.doc(), text);
    peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.create(peer.view.state.doc, r.from)));
  }

  it('T1: row-insert vs column-insert converges; leader-gated repair squares the table', async () => {
    const [a, b] = await createLoroPeers(docOf(tableNode(3, 3)), 2) as [LoroPeer, LoroPeer];
    selectIn(a, 'c11');
    addRowAfter(a.view.state, a.view.dispatch);
    selectIn(b, 'c11');
    addColumnAfter(b.view.state, b.view.dispatch);
    await converge(a, b);
    // The merge is ragged (one row short a cell) — the known, accepted
    // outcome for concurrent dimension edits.
    expect(new Set(tableShapes(a.doc())[0]!).size).toBeGreaterThan(1);
    // Structural repair is leader-gated (one peer repairs, the fix
    // syncs): concurrent double-repair would merge duplicate padding —
    // the reason the design gates it in the first place.
    repairView(a.view);
    await settle();
    await syncAll([a, b]);
    expect(b.doc().eq(a.doc())).toBe(true);
    expect(() => a.doc().check()).not.toThrow();
    const rows = tableShapes(a.doc())[0]!;
    expect(new Set(rows).size).toBe(1); // rectangular after one-sided repair
    // Idempotence: nothing left to repair on either peer.
    expect(repairView(b.view)).toBe(false);
    // No cell content lost through merge + repair.
    for (const cellText of ['c00', 'c11', 'c22']) {
      expect(docText(a.doc())).toContain(cellText);
    }
    a.destroy(); b.destroy();
  });

  it('T2/T3: concurrent cell edits (different and same cell) both survive', async () => {
    const [a, b] = await createLoroPeers(docOf(tableNode(3, 3)), 2) as [LoroPeer, LoroPeer];
    typeAfter(a.view, 'c00', 'X');
    typeAfter(b.view, 'c22', 'Y');
    await converge(a, b);
    typeAfter(a.view, 'c11', 'P');
    typeAfter(b.view, 'c11', 'Q');
    await converge(a, b);
    const t = docText(a.doc());
    expect(t).toContain('c00X');
    expect(t).toContain('c22Y');
    expect(t).toContain('P');
    expect(t).toContain('Q');
    a.destroy(); b.destroy();
  });

  it('T4: delete-row vs edit-in-row: delete wins cleanly', async () => {
    const [a, b] = await createLoroPeers(docOf(tableNode(3, 3)), 2) as [LoroPeer, LoroPeer];
    selectIn(a, 'c10');
    deleteRow(a.view.state, a.view.dispatch);
    typeAfter(b.view, 'c11', 'Z');
    await converge(a, b);
    expect(docText(a.doc())).not.toContain('c10');
    expect(tableShapes(a.doc())[0]).toEqual([3, 3]);
    a.destroy(); b.destroy();
  });

  it('T8: delete-card vs edit-inside: delete wins, no orphan container', async () => {
    const [a, b] = await createLoroPeers(mixedDoc(), 2) as [LoroPeer, LoroPeer];
    let cardPos = -1;
    let cardSize = 0;
    a.doc().descendants((n, pos) => {
      if (n.type.name === 'card' && cardPos < 0) {
        cardPos = pos;
        cardSize = n.nodeSize;
      }
      return cardPos < 0;
    });
    a.view.dispatch(a.view.state.tr.delete(cardPos, cardPos + cardSize));
    typeAfter(b.view, 'resource scarcity', ' and famine');
    await converge(a, b);
    let orphan = false;
    a.doc().descendants((n) => {
      if (n.type.name === 'card' && n.firstChild?.type.name !== 'tag') orphan = true;
      return true;
    });
    expect(orphan).toBe(false);
    a.destroy(); b.destroy();
  });
});
