import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildMoveTransaction,
  buildCopyTransaction,
  type DragItem,
} from '../../src/editor/drag-controller.js';

function pocket(text: string) {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
}

function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function cardWith(tagText: string, bodyText?: string) {
  const children = [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
  ];
  if (bodyText) {
    children.push(schema.nodes['card_body']!.create(null, schema.text(bodyText)));
  }
  return schema.nodes['card']!.createChecked(null, children);
}

function makeDoc(...children: ReturnType<typeof block>[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function dragItemForRange(from: number, to: number, type: string, level: number): DragItem {
  return { from, to, id: null, type, level, label: '' };
}

describe('buildMoveTransaction', () => {
  it('moves a card to a position before another card', () => {
    const card1 = cardWith('First');
    const card2 = cardWith('Second');
    const doc = makeDoc(card1, card2);
    const state = EditorState.create({ doc, schema });

    // Drag card2 to the position before card1.
    const card2Pos = 0 + card1.nodeSize; // start of card2
    const card2End = card2Pos + card2.nodeSize;
    const item = dragItemForRange(card2Pos, card2End, 'card', 4);
    const targetPos = 0; // before card1

    const tr = buildMoveTransaction(state, [item], targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(2);
    expect(newDoc.child(0).firstChild!.textContent).toBe('Second');
    expect(newDoc.child(1).firstChild!.textContent).toBe('First');
  });

  it('moves a card to the end of the doc', () => {
    const card1 = cardWith('First');
    const card2 = cardWith('Second');
    const doc = makeDoc(card1, card2);
    const state = EditorState.create({ doc, schema });

    // Drag card1 to the very end of the doc.
    const item = dragItemForRange(0, card1.nodeSize, 'card', 4);
    const targetPos = doc.content.size;

    const tr = buildMoveTransaction(state, [item], targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.child(0).firstChild!.textContent).toBe('Second');
    expect(newDoc.child(1).firstChild!.textContent).toBe('First');
  });

  it('preserves a card body when moving the card', () => {
    const card1 = cardWith('Tag1', 'body1');
    const card2 = cardWith('Tag2');
    const doc = makeDoc(card1, card2);
    const state = EditorState.create({ doc, schema });

    // Move card1 to after card2.
    const item = dragItemForRange(0, card1.nodeSize, 'card', 4);
    const targetPos = doc.content.size;
    const tr = buildMoveTransaction(state, [item], targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(2);
    const movedCard = newDoc.child(1);
    expect(movedCard.firstChild!.textContent).toBe('Tag1');
    expect(movedCard.lastChild!.type.name).toBe('card_body');
    expect(movedCard.lastChild!.textContent).toBe('body1');
  });

  it('returns null when target is strictly inside the source range', () => {
    const card1 = cardWith('First');
    const card2 = cardWith('Second');
    const doc = makeDoc(card1, card2);
    const state = EditorState.create({ doc, schema });

    // Drag card1; target somewhere strictly inside it.
    const item = dragItemForRange(0, card1.nodeSize, 'card', 4);
    const insidePos = 2; // inside card1's content (interior, not boundary)
    const tr = buildMoveTransaction(state, [item], insidePos);
    expect(tr).toBeNull();
  });

  it('moves a Block (heading + subordinate cards) as one unit', () => {
    // Doc: [block A][card a1 under block A][block B][card b1 under block B]
    const blockA = block('Block A');
    const cardA1 = cardWith('A1');
    const blockB = block('Block B');
    const cardB1 = cardWith('B1');
    const doc = makeDoc(blockA, cardA1, blockB, cardB1);
    const state = EditorState.create({ doc, schema });

    // Block A's range = block A heading + card A1.
    const blockARange = blockA.nodeSize + cardA1.nodeSize;
    const item = dragItemForRange(0, blockARange, 'block', 3);

    // Drop after block B's range (i.e., end of doc).
    const targetPos = doc.content.size;
    const tr = buildMoveTransaction(state, [item], targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    // Order should now be: blockB, cardB1, blockA, cardA1
    expect(newDoc.child(0).type.name).toBe('block');
    expect(newDoc.child(0).textContent).toBe('Block B');
    expect(newDoc.child(1).type.name).toBe('card');
    expect(newDoc.child(2).type.name).toBe('block');
    expect(newDoc.child(2).textContent).toBe('Block A');
    expect(newDoc.child(3).type.name).toBe('card');
  });

  it('moves a Pocket and its subordinate Hat/Block/Card content together', () => {
    const pocketA = pocket('A');
    const cardA = cardWith('A-card');
    const pocketB = pocket('B');
    const cardB = cardWith('B-card');
    const doc = makeDoc(pocketA, cardA, pocketB, cardB);
    const state = EditorState.create({ doc, schema });

    const pocketARange = pocketA.nodeSize + cardA.nodeSize;
    const item = dragItemForRange(0, pocketARange, 'pocket', 1);
    const targetPos = doc.content.size;
    const tr = buildMoveTransaction(state, [item], targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    // Pocket A and its card should now be at the end.
    expect(newDoc.child(0).textContent).toBe('B');
    expect(newDoc.child(2).textContent).toBe('A');
    expect(newDoc.child(3).firstChild!.textContent).toBe('A-card');
  });

  it('returns null for empty input', () => {
    const doc = makeDoc(cardWith('First'));
    const state = EditorState.create({ doc, schema });
    const tr = buildMoveTransaction(state, [], 0);
    expect(tr).toBeNull();
  });

  it('moves multiple cards preserving original document order', () => {
    // Doc: [A][B][C][D]. Drag A and C, drop at end.
    // Expected: [B][D][A][C].
    const cardA = cardWith('A');
    const cardB = cardWith('B');
    const cardC = cardWith('C');
    const cardD = cardWith('D');
    const doc = makeDoc(cardA, cardB, cardC, cardD);
    const state = EditorState.create({ doc, schema });

    const aFrom = 0;
    const aTo = cardA.nodeSize;
    const cFrom = aTo + cardB.nodeSize;
    const cTo = cFrom + cardC.nodeSize;

    const items: DragItem[] = [
      dragItemForRange(aFrom, aTo, 'card', 4),
      dragItemForRange(cFrom, cTo, 'card', 4),
    ];
    const tr = buildMoveTransaction(state, items, doc.content.size);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(4);
    expect(newDoc.child(0).firstChild!.textContent).toBe('B');
    expect(newDoc.child(1).firstChild!.textContent).toBe('D');
    expect(newDoc.child(2).firstChild!.textContent).toBe('A');
    expect(newDoc.child(3).firstChild!.textContent).toBe('C');
  });

  it('multi-item drop between two unmoved cards preserves relative order', () => {
    // Doc: [A][B][C][D][E]. Drag B and D, drop between C and (gap).
    // The "between C and D's original position" depends on how we
    // interpret target. Use insertPos = end of C. Expected:
    // [A][C][B][D][E].
    const cardA = cardWith('A');
    const cardB = cardWith('B');
    const cardC = cardWith('C');
    const cardD = cardWith('D');
    const cardE = cardWith('E');
    const doc = makeDoc(cardA, cardB, cardC, cardD, cardE);
    const state = EditorState.create({ doc, schema });

    const bFrom = cardA.nodeSize;
    const bTo = bFrom + cardB.nodeSize;
    const dFrom = bTo + cardC.nodeSize;
    const dTo = dFrom + cardD.nodeSize;
    const targetPos = dFrom; // end of C / start of D

    const items: DragItem[] = [
      dragItemForRange(bFrom, bTo, 'card', 4),
      dragItemForRange(dFrom, dTo, 'card', 4),
    ];
    const tr = buildMoveTransaction(state, items, targetPos);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(5);
    expect(newDoc.child(0).firstChild!.textContent).toBe('A');
    expect(newDoc.child(1).firstChild!.textContent).toBe('C');
    expect(newDoc.child(2).firstChild!.textContent).toBe('B');
    expect(newDoc.child(3).firstChild!.textContent).toBe('D');
    expect(newDoc.child(4).firstChild!.textContent).toBe('E');
  });

  it('multi-item drop is rejected if target is inside any source range', () => {
    const cardA = cardWith('A');
    const cardB = cardWith('B');
    const cardC = cardWith('C');
    const doc = makeDoc(cardA, cardB, cardC);
    const state = EditorState.create({ doc, schema });

    const bFrom = cardA.nodeSize;
    const bTo = bFrom + cardB.nodeSize;
    const cFrom = bTo;
    const cTo = cFrom + cardC.nodeSize;

    const items: DragItem[] = [
      dragItemForRange(bFrom, bTo, 'card', 4),
      dragItemForRange(cFrom, cTo, 'card', 4),
    ];
    // Target inside B's range.
    const tr = buildMoveTransaction(state, items, bFrom + 1);
    expect(tr).toBeNull();
  });
});

describe('buildCopyTransaction', () => {
  it('duplicates a card and inserts the clone, leaving the original', () => {
    const card1 = cardWith('First', 'body 1');
    const card2 = cardWith('Second', 'body 2');
    const doc = makeDoc(card1, card2);
    const state = EditorState.create({ doc, schema });

    const card1End = card1.nodeSize;
    const card2End = card1End + card2.nodeSize;
    const item = dragItemForRange(card1End, card2End, 'card', 4);
    // Drop right after card2 → expect [card1, card2, copy-of-card2].
    const tr = buildCopyTransaction(state, [item], card2End);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(3);
    expect(newDoc.child(0).firstChild!.textContent).toBe('First');
    expect(newDoc.child(1).firstChild!.textContent).toBe('Second');
    expect(newDoc.child(2).firstChild!.textContent).toBe('Second');
  });

  it('rewrites heading IDs in the clone so they do not collide', () => {
    const card1 = cardWith('Original');
    const doc = makeDoc(card1);
    const state = EditorState.create({ doc, schema });

    const originalTagId = card1.firstChild!.attrs['id'];
    const item = dragItemForRange(0, card1.nodeSize, 'card', 4);
    const tr = buildCopyTransaction(state, [item], card1.nodeSize);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(newDoc.childCount).toBe(2);
    const cloneTagId = newDoc.child(1).firstChild!.attrs['id'];
    expect(typeof cloneTagId).toBe('string');
    expect(cloneTagId).not.toBe(originalTagId);
    // Original is untouched.
    expect(newDoc.child(0).firstChild!.attrs['id']).toBe(originalTagId);
  });

  it('rewrites heading IDs nested inside a copied subtree', () => {
    // A pocket containing a card containing a tag — copying the pocket
    // should rewrite IDs on the pocket, the card has none, but the
    // tag inside should get a fresh id.
    const tagId = newHeadingId();
    const innerCard = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: tagId }, schema.text('inner')),
    ]);
    const pocketId = newHeadingId();
    const pocketNode = schema.nodes['pocket']!.create(
      { id: pocketId },
      schema.text('pocket'),
    );
    // Doc shape: [pocketNode, innerCard] — drag the pocket only.
    // Actually we want a pocket containing nested headings. Schema-
    // wise pockets contain inline only; cards live at doc level.
    // Construct: doc = [pocketNode, innerCard], drag both.
    const doc = makeDoc(pocketNode, innerCard);
    const state = EditorState.create({ doc, schema });

    const item = dragItemForRange(
      0,
      pocketNode.nodeSize + innerCard.nodeSize,
      'mixed',
      1,
    );
    const tr = buildCopyTransaction(
      state,
      [item],
      pocketNode.nodeSize + innerCard.nodeSize,
    );
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    // Original 2 + cloned 2 = 4 children.
    expect(newDoc.childCount).toBe(4);
    expect(newDoc.child(2).attrs['id']).not.toBe(pocketId);
    expect(newDoc.child(3).firstChild!.attrs['id']).not.toBe(tagId);
    // And the originals stay put.
    expect(newDoc.child(0).attrs['id']).toBe(pocketId);
    expect(newDoc.child(1).firstChild!.attrs['id']).toBe(tagId);
  });

  it('returns null when the insert position is strictly inside a source range', () => {
    const card1 = cardWith('A');
    const doc = makeDoc(card1);
    const state = EditorState.create({ doc, schema });
    const item = dragItemForRange(0, card1.nodeSize, 'card', 4);
    expect(buildCopyTransaction(state, [item], 1)).toBeNull();
  });

  it('returns null for an empty items list', () => {
    const doc = makeDoc(cardWith('A'));
    const state = EditorState.create({ doc, schema });
    expect(buildCopyTransaction(state, [], 0)).toBeNull();
  });
});
