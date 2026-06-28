/**
 * moveContainerUp / moveContainerDown — reorder the cursor's smallest enclosing
 * outline node one spot among same-level items, flowing across section
 * boundaries (hopping a shallower heading counts as one step; a sibling section
 * is hopped whole).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { moveContainerUp, moveContainerDown } from '../../src/editor/move-container.js';

// ---- builders ----
const hat = (t: string) => schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text(t));
const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
const para = (t: string) => schema.nodes['paragraph']!.create(null, schema.text(t));
const card = (t: string) =>
  schema.nodes['card']!.createChecked(null, [schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t))]);
const au = (t: string) =>
  schema.nodes['analytic_unit']!.createChecked(null, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(t)),
  ]);

function makeDoc(...kids: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, kids);
}

/** Compact `type:text` label per top-level child, for order assertions. */
function seq(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((child) => {
    const t = child.type.name;
    const short = t === 'analytic_unit' ? 'au' : t === 'paragraph' ? 'p' : t;
    out.push(`${short}:${child.textContent}`);
  });
  return out;
}

/** Place the cursor inside the first node matching `find`. */
function cursorIn(doc: PMNode, find: (n: PMNode) => boolean): EditorState {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos === -1 && n.isText && find(n)) pos = p + 1;
    return true;
  });
  if (pos < 0) throw new Error('cursor target text not found');
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function run(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

const inText = (txt: string) => (n: PMNode) => n.text === txt;

// ---- tests ----

describe('moveContainerUp / Down', () => {
  it("the canonical example: a card hops a block heading up (one step)", () => {
    const doc = makeDoc(hat('H2'), card('a'), card('b'), block('c'), card('d'), card('e'));
    const next = run(cursorIn(doc, inText('d')), moveContainerUp());
    expect(next).not.toBeNull();
    expect(seq(next!.doc)).toEqual(['hat:H2', 'card:a', 'card:b', 'card:d', 'block:c', 'card:e']);
  });

  it('a card reorders among sibling cards within its block', () => {
    const doc = makeDoc(block('B'), card('1'), card('2'), card('3'));
    const next = run(cursorIn(doc, inText('2')), moveContainerUp());
    expect(seq(next!.doc)).toEqual(['block:B', 'card:2', 'card:1', 'card:3']);
  });

  it('a card moving up crosses into the previous block (reparents)', () => {
    const doc = makeDoc(block('A'), card('a1'), block('B'), card('b1'));
    const next = run(cursorIn(doc, inText('b1')), moveContainerUp());
    expect(seq(next!.doc)).toEqual(['block:A', 'card:a1', 'card:b1', 'block:B']);
  });

  it('a card moving down becomes the first child of the next block', () => {
    const doc = makeDoc(block('A'), card('a1'), block('B'), card('b1'));
    const next = run(cursorIn(doc, inText('a1')), moveContainerDown());
    expect(seq(next!.doc)).toEqual(['block:A', 'block:B', 'card:a1', 'card:b1']);
  });

  it('cards and analytic units intermix (one is a spot for the other)', () => {
    const doc = makeDoc(block('B'), card('1'), au('a'), card('2'));
    const next = run(cursorIn(doc, inText('2')), moveContainerUp());
    expect(seq(next!.doc)).toEqual(['block:B', 'card:1', 'card:2', 'au:a']);
  });

  it('a block hops a whole sibling block section up', () => {
    const doc = makeDoc(hat('X'), block('A'), card('a1'), card('a2'), block('B'), card('b1'));
    const next = run(cursorIn(doc, inText('B')), moveContainerUp());
    expect(seq(next!.doc)).toEqual(['hat:X', 'block:B', 'card:b1', 'block:A', 'card:a1', 'card:a2']);
  });

  it('a block hops a whole sibling block section down', () => {
    const doc = makeDoc(hat('X'), block('A'), card('a1'), card('a2'), block('B'), card('b1'));
    const next = run(cursorIn(doc, inText('A')), moveContainerDown());
    expect(seq(next!.doc)).toEqual(['hat:X', 'block:B', 'card:b1', 'block:A', 'card:a1', 'card:a2']);
  });

  it('no-op when there is nothing above / below at any level', () => {
    const doc = makeDoc(card('1'), card('2'));
    expect(run(cursorIn(doc, inText('1')), moveContainerUp())).toBeNull();
    expect(run(cursorIn(doc, inText('2')), moveContainerDown())).toBeNull();
  });

  it('no-op when the cursor is not inside any container', () => {
    const doc = makeDoc(para('loose'), card('1'));
    expect(run(cursorIn(doc, inText('loose')), moveContainerUp())).toBeNull();
  });

  it('keeps the cursor inside the moved container (repeatable)', () => {
    const doc = makeDoc(block('B'), card('1'), card('2'), card('3'));
    let state: EditorState | null = run(cursorIn(doc, inText('2')), moveContainerUp());
    expect(seq(state!.doc)).toEqual(['block:B', 'card:2', 'card:1', 'card:3']);
    // Press again — the cursor should still be in card "2", which is now first.
    state = run(state!, moveContainerUp());
    // "2" is already the first card under B; nothing above at level 4 except the
    // block heading, so it hops above the block.
    expect(seq(state!.doc)).toEqual(['card:2', 'block:B', 'card:1', 'card:3']);
  });
});
