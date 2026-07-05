// @vitest-environment jsdom
/**
 * Formatting-fusion heal: Peritext range marks cover text concurrently
 * inserted inside their range, so a partner's underlined typing inside
 * a shrunk span inherits `font_size` at merge (no op records it), and
 * Loro's UndoManager re-marks drifted ranges across interleaved remote
 * ops. The heal strips ONLY `origin: 'shrink'` sizes that fuse with
 * underline/emphasis; sizes the user chose survive every fusion path.
 * Field root-cause write-up: COLLAB_CRDT_PLAN.md §14.
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { LoroUndoPlugin, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { schema } from '../../src/schema/index.js';
import { collabInvariantHealPlugin } from '../../src/editor/collab/collab-invariants.js';
import { shrinkText, setFontSize } from '../../src/editor/ribbon-commands.js';
import {
  createLoroPeers,
  syncAll,
  settle,
  docOf,
  para,
  findText,
  type LoroPeer,
} from './_loro-helpers.js';

const u = () => schema.marks['underline_mark']!.create();
const fontSizeType = schema.marks['font_size']!;
const shrunk = (hp: number) => fontSizeType.create({ halfPoints: hp, origin: 'shrink' });
const manual = (hp: number) => fontSizeType.create({ halfPoints: hp });

/** Marks on the text node containing `text` (throws if absent). */
function marksOn(doc: PMNode, text: string): readonly import('prosemirror-model').Mark[] {
  const { from } = findText(doc, text);
  const node = doc.nodeAt(from);
  if (!node?.isText) throw new Error(`no text node at "${text}"`);
  return node.marks;
}

function fontSizeOn(doc: PMNode, text: string) {
  return marksOn(doc, text).find((m) => m.type === fontSizeType) ?? null;
}

/** Session-shaped peers: sync + undo + invariant heal, like installSeams. */
async function sessionPeers(seed: PMNode, n: number): Promise<LoroPeer[]> {
  return createLoroPeers(seed, n, (ldoc) => [
    LoroUndoPlugin({ doc: ldoc as never }),
    collabInvariantHealPlugin(),
  ]);
}

const SEED = () => docOf(para('intro CONNECTIVE TEXT HERE outro'));

/** A shrinks the connective span; B concurrently types an underlined
 *  sentence inside it. Returns after full convergence. */
async function fuse(
  a: LoroPeer,
  b: LoroPeer,
  size: (hp: number) => import('prosemirror-model').Mark,
): Promise<void> {
  const span = findText(a.doc(), 'CONNECTIVE TEXT HERE');
  a.view.dispatch(a.view.state.tr.addMark(span.from, span.to, size(16)));
  const at = findText(b.doc(), 'TEXT').from; // strictly inside the span
  b.view.dispatch(b.view.state.tr.insert(at, schema.text('INSERTED ', [u()])));
  await settle();
  await syncAll([a, b]);
  await syncAll([a, b]); // second exchange delivers heal ops
  expect(b.doc().eq(a.doc())).toBe(true);
}

describe('collab invariant heal — shrink×underline fusion', () => {
  it('strips shrink-origin font_size from concurrently inserted underlined text (both peers)', async () => {
    const [a, b] = await sessionPeers(SEED(), 2);
    await fuse(a!, b!, shrunk);
    for (const peer of [a!, b!]) {
      const inserted = marksOn(peer.doc(), 'INSERTED');
      expect(inserted.some((m) => m.type.name === 'underline_mark')).toBe(true);
      expect(fontSizeOn(peer.doc(), 'INSERTED')).toBeNull();
      // the deliberate shrink outside the insertion is untouched
      expect(fontSizeOn(peer.doc(), 'CONNECTIVE')?.attrs['halfPoints']).toBe(16);
    }
    a!.destroy();
    b!.destroy();
  });

  it('leaves user-chosen (origin: null) font_size fused — manual always wins', async () => {
    const [a, b] = await sessionPeers(SEED(), 2);
    await fuse(a!, b!, manual);
    for (const peer of [a!, b!]) {
      // inherited size KEPT: the user set this size deliberately
      expect(fontSizeOn(peer.doc(), 'INSERTED')?.attrs['halfPoints']).toBe(16);
      expect(marksOn(peer.doc(), 'INSERTED').some((m) => m.type.name === 'underline_mark')).toBe(
        true,
      );
    }
    a!.destroy();
    b!.destroy();
  });

  it('heals undo/redo range drift across interleaved remote ops', async () => {
    const [a, b] = await sessionPeers(SEED(), 2);
    const span = findText(a!.doc(), 'CONNECTIVE TEXT HERE');
    a!.view.dispatch(a!.view.state.tr.addMark(span.from, span.to, shrunk(16)));
    await settle();
    await syncAll([a!, b!]);

    // remote underlined insert lands inside the shrunk span
    const at = findText(b!.doc(), 'TEXT').from;
    b!.view.dispatch(b!.view.state.tr.insert(at, schema.text('INSERTED ', [u()])));
    await settle();
    await syncAll([a!, b!]);

    // undo re-marks/unmarks at remapped ranges; redo re-marks the full
    // current extent INCLUDING the remote insert — both would fuse
    // without the heal
    loroUndo(a!.view.state, a!.view.dispatch);
    await settle();
    loroRedo(a!.view.state, a!.view.dispatch);
    await settle();
    await syncAll([a!, b!]);
    await syncAll([a!, b!]);

    for (const peer of [a!, b!]) {
      expect(fontSizeOn(peer.doc(), 'INSERTED')).toBeNull();
      expect(marksOn(peer.doc(), 'INSERTED').some((m) => m.type.name === 'underline_mark')).toBe(
        true,
      );
    }
    expect(b!.doc().eq(a!.doc())).toBe(true);
    a!.destroy();
    b!.destroy();
  });

  it('does not fire on local transactions — only the binding’s', async () => {
    // Local fusion via direct tr (no command does this; pins the scoping:
    // the heal must not police user edits, only merge/undo artifacts).
    const [a] = await sessionPeers(docOf(para('some underlined words here')), 1);
    const r = findText(a!.doc(), 'underlined');
    a!.view.dispatch(a!.view.state.tr.addMark(r.from, r.to, u()).addMark(r.from, r.to, shrunk(16)));
    await settle();
    expect(fontSizeOn(a!.doc(), 'underlined')?.attrs['origin']).toBe('shrink');
    a!.destroy();
  });
});

describe('font_size provenance tagging', () => {
  const ctx = {
    effectivePt: () => 11,
    normalPt: () => 11,
    restoreOmissions: () => false,
    protectionPatterns: () => [] as readonly RegExp[],
  };

  it('shrink cycle stamps origin: shrink', () => {
    const doc = docOf(para('plain connective text'));
    let state = EditorState.create({ doc });
    const r = findText(state.doc, 'connective');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, r.from, r.to)));
    const cmd = shrinkText(ctx.effectivePt, ctx.normalPt, ctx.restoreOmissions, ctx.protectionPatterns);
    const ran = cmd(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ran).toBe(true);
    expect(fontSizeOn(state.doc, 'connective')?.attrs['origin']).toBe('shrink');
  });

  it('setFontSize (size chip) stays origin: null', () => {
    const doc = docOf(para('plain connective text'));
    let state = EditorState.create({ doc });
    const r = findText(state.doc, 'connective');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, r.from, r.to)));
    const ran = setFontSize(8, ctx.effectivePt)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ran).toBe(true);
    const fs = fontSizeOn(state.doc, 'connective');
    expect(fs?.attrs['halfPoints']).toBe(16);
    expect(fs?.attrs['origin']).toBeNull();
  });
});
