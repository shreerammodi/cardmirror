/**
 * Card-paste fitting matrix.
 *
 * Origin (Discord regressions): pasting a cite/undertag/body block copied from
 * inside a card detached the tag — the clipboard slice is a single OPEN `card`
 * (openStart 2, tag cut off), and the paste path split the destination card to
 * insert it. The fix unwraps that container and fits the carried block INTO the
 * cursor's card per an agreed matrix (never breaking the card, preserving block
 * types):
 *
 *   into ↓ \ paste →   body            cite              undertag
 *   card_body          inline          cite block        undertag block
 *   cite_paragraph     inline absorb   merge             undertag block
 *   undertag           split→body      cite block        merge
 *   any empty block    overwrite       overwrite         overwrite
 *   outside a card     paragraph       loose cite        loose undertag
 *
 * Boundaries: a tag / analytic / heading / whole closed card lead bails to the
 * split path (those SHOULD break the card).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';
import { tryPasteCardContent } from '../../src/editor/paste-plugin.js';

// ---- builders -------------------------------------------------------------
const tag = (text: string, id = newHeadingId()) =>
  schema.nodes['tag']!.create({ id }, text ? schema.text(text) : []);
const cardBody = (text: string) =>
  schema.nodes['card_body']!.create(null, text ? schema.text(text) : []);
const citePara = (text: string) =>
  schema.nodes['cite_paragraph']!.create(null, text ? schema.text(text) : []);
const undertag = (text: string) =>
  schema.nodes['undertag']!.create(null, text ? schema.text(text) : []);
const para = (text: string) =>
  schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []);
const cardWith = (...kids: PMNode[]) => schema.nodes['card']!.createChecked(null, kids);
const makeDoc = (kids: PMNode[]) => schema.nodes['doc']!.createChecked(null, kids);

// A cite/body copied from inside a card serializes as a single OPEN card.
const openCardSlice = (...blocks: PMNode[]) =>
  new Slice(Fragment.fromArray([schema.nodes['card']!.create(null, blocks)]), 2, 2);

// ---- positioning + inspection --------------------------------------------
function posInText(doc: PMNode, text: string, offset: number): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos === -1 && n.isText && n.text === text) pos = p + offset;
    return pos === -1;
  });
  if (pos < 0) throw new Error(`text not found: ${text}`);
  return pos;
}
function blockStart(doc: PMNode, typeName: string, occ = 0): number {
  let pos = -1;
  let c = 0;
  doc.descendants((n, p) => {
    if (n.type.name === typeName) {
      if (c === occ) {
        pos = p + 1;
        return false;
      }
      c++;
    }
    return true;
  });
  if (pos < 0) throw new Error(`block not found: ${typeName}`);
  return pos;
}
const topLevelTypes = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.forEach((c) => out.push(c.type.name));
  return out;
};
const childTypes = (node: PMNode): string[] => {
  const out: string[] = [];
  node.forEach((c) => out.push(c.type.name));
  return out;
};
const firstOfType = (doc: PMNode, name: string): PMNode => {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (!found && n.type.name === name) found = n;
    return !found;
  });
  if (!found) throw new Error(`not found: ${name}`);
  return found;
};
const firstCard = (doc: PMNode) => firstOfType(doc, 'card');

function fit(doc: PMNode, cursor: number, slice: Slice): EditorState | null {
  const base = EditorState.create({ doc, plugins: [absorbPlugin] });
  const state = base.apply(
    base.tr.setSelection(TextSelection.create(base.doc, cursor)),
  );
  const tr = tryPasteCardContent(state, slice);
  return tr ? state.apply(tr) : null;
}

// Paste OVER a range selection (from..to), not at a collapsed cursor.
function fitRange(
  doc: PMNode,
  from: number,
  to: number,
  slice: Slice,
): EditorState | null {
  const base = EditorState.create({ doc, plugins: [absorbPlugin] });
  const state = base.apply(
    base.tr.setSelection(TextSelection.create(base.doc, from, to)),
  );
  const tr = tryPasteCardContent(state, slice);
  return tr ? state.apply(tr) : null;
}

describe('card-paste matrix — into card_body', () => {
  it('body → merges inline at the cursor (no new block)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fit(doc, posInText(doc, 'Smith body', 5), openCardSlice(cardBody('XX')))!;
    expect(after).not.toBeNull();
    expect(topLevelTypes(after.doc)).toEqual(['card']);
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'card_body']);
    expect(after.doc.textContent).toContain('SmithXX body');
  });

  it('cite → inserts a cite block, splitting the body, tag attached', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fit(doc, posInText(doc, 'Smith body', 5), openCardSlice(citePara('Cite24')))!;
    expect(topLevelTypes(after.doc)).toEqual(['card']);
    expect(firstCard(after.doc).firstChild!.attrs['id']).toBe('t1');
    expect(childTypes(firstCard(after.doc))).toEqual([
      'tag', 'card_body', 'cite_paragraph', 'card_body',
    ]);
    expect(firstOfType(after.doc, 'cite_paragraph').textContent).toBe('Cite24');
  });

  it('cite at body start → cite goes before the body (no empty edge)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fit(doc, blockStart(doc, 'card_body'), openCardSlice(citePara('Cite24')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'cite_paragraph', 'card_body']);
  });

  it('undertag → inserts an undertag block', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fit(doc, posInText(doc, 'Smith body', 5), openCardSlice(undertag('UT')))!;
    expect(childTypes(firstCard(after.doc))).toEqual([
      'tag', 'card_body', 'undertag', 'card_body',
    ]);
  });
});

describe('card-paste matrix — into cite_paragraph', () => {
  it('body → absorbed inline into the cite', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), citePara('Cite text'), cardBody('b'))]);
    const after = fit(doc, posInText(doc, 'Cite text', 4), openCardSlice(cardBody('XX')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'cite_paragraph', 'card_body']);
    expect(firstOfType(after.doc, 'cite_paragraph').textContent).toBe('CiteXX text');
  });

  it('cite → merges inline (same type)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), citePara('Cite text'), cardBody('b'))]);
    const after = fit(doc, posInText(doc, 'Cite text', 4), openCardSlice(citePara('YY')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'cite_paragraph', 'card_body']);
    expect(firstOfType(after.doc, 'cite_paragraph').textContent).toBe('CiteYY text');
  });

  it('undertag → inserts an undertag block, splitting the cite', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), citePara('Cite text'), cardBody('b'))]);
    const after = fit(doc, posInText(doc, 'Cite text', 4), openCardSlice(undertag('UT')))!;
    expect(childTypes(firstCard(after.doc))).toEqual([
      'tag', 'cite_paragraph', 'undertag', 'cite_paragraph', 'card_body',
    ]);
  });
});

describe('card-paste matrix — into undertag', () => {
  it('body → splits the undertag, body card_body between (Edge 1)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), undertag('Undertag'), citePara('C'))]);
    const after = fit(doc, posInText(doc, 'Undertag', 4), openCardSlice(cardBody('BODY')))!;
    const card = firstCard(after.doc);
    expect(childTypes(card)).toEqual(['tag', 'undertag', 'card_body', 'undertag', 'cite_paragraph']);
    expect(card.child(1).textContent).toBe('Unde');
    expect(card.child(2).textContent).toBe('BODY');
    expect(card.child(3).textContent).toBe('rtag');
  });

  it('cite → inserts a cite block, splitting the undertag', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), undertag('Undertag'))]);
    const after = fit(doc, posInText(doc, 'Undertag', 4), openCardSlice(citePara('C24')))!;
    expect(childTypes(firstCard(after.doc))).toEqual([
      'tag', 'undertag', 'cite_paragraph', 'undertag',
    ]);
  });

  it('undertag → merges inline (same type)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), undertag('Undertag'))]);
    const after = fit(doc, posInText(doc, 'Undertag', 4), openCardSlice(undertag('ZZ')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'undertag']);
    expect(firstOfType(after.doc, 'undertag').textContent).toBe('UndeZZrtag');
  });
});

describe('card-paste matrix — empty target overwrite', () => {
  it('empty undertag ← body: overwritten by a card_body (Edge 2)', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), undertag(''), citePara('C'))]);
    const after = fit(doc, blockStart(doc, 'undertag'), openCardSlice(cardBody('BODY')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'card_body', 'cite_paragraph']);
    expect(after.doc.textContent).toContain('BODY');
  });

  it('empty undertag ← cite: overwritten by the cite', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), undertag(''))]);
    const after = fit(doc, blockStart(doc, 'undertag'), openCardSlice(citePara('C24')))!;
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'cite_paragraph']);
  });
});

describe('card-paste matrix — boundaries', () => {
  it('cursor in the tag bails (not a content slot)', () => {
    const doc = makeDoc([cardWith(tag('Tag text', 't1'), cardBody('a'))]);
    expect(fit(doc, posInText(doc, 'Tag text', 3), openCardSlice(cardBody('XX')))).toBeNull();
  });

  it('a whole closed card (with its tag) bails → split path breaks the card', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('a'))]);
    const wholeCard = cardWith(tag('Other', 'o1'), cardBody('x'));
    const slice = new Slice(Fragment.fromArray([wholeCard]), 0, 0);
    const base = EditorState.create({ doc, plugins: [absorbPlugin] });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, posInText(doc, 'a', 1))),
    );
    expect(tryPasteCardContent(state, slice)).toBeNull();
  });

  it('a tag-led slice bails → split path', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('a'))]);
    const slice = new Slice(Fragment.fromArray([tag('New', 'n1')]), 0, 0);
    const base = EditorState.create({ doc, plugins: [absorbPlugin] });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, posInText(doc, 'a', 1))),
    );
    expect(tryPasteCardContent(state, slice)).toBeNull();
  });
});

describe('card-paste matrix — paste OVER a selection (range)', () => {
  // A range paste used to tear the card apart: tryPasteCardContent bailed on any
  // non-collapsed selection, so the open-card slice fell to the split path and
  // spawned a phantom empty-tag sibling. Card-fittable content must fit in place
  // instead, dropping the selected text first — never breaking the card.

  it('body over a partial card_body selection → replaces inline, card intact', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fitRange(
      doc,
      posInText(doc, 'Smith body', 0),
      posInText(doc, 'Smith body', 5), // select "Smith"
      openCardSlice(cardBody('XX')),
    )!;
    expect(after).not.toBeNull();
    expect(topLevelTypes(after.doc)).toEqual(['card']);
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'card_body']);
    expect(firstCard(after.doc).firstChild!.attrs['id']).toBe('t1'); // tag intact
    expect(firstOfType(after.doc, 'card_body').textContent).toBe('XX body');
  });

  it('cite over a partial card_body selection → cite added, card not torn', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const after = fitRange(
      doc,
      posInText(doc, 'Smith body', 2),
      posInText(doc, 'Smith body', 5), // select "ith"
      openCardSlice(citePara('C24')),
    )!;
    expect(after).not.toBeNull();
    expect(topLevelTypes(after.doc)).toEqual(['card']);
    const types = childTypes(firstCard(after.doc));
    expect(types[0]).toBe('tag');
    expect(types).toContain('cite_paragraph');
    expect(firstCard(after.doc).firstChild!.attrs['id']).toBe('t1');
    expect(firstOfType(after.doc, 'cite_paragraph').textContent).toBe('C24');
  });

  it('body over a FULL paragraph selection → overwrites it, card intact', () => {
    const doc = makeDoc([
      cardWith(tag('T', 't1'), cardBody('Replace me'), citePara('C')),
    ]);
    const after = fitRange(
      doc,
      posInText(doc, 'Replace me', 0),
      posInText(doc, 'Replace me', 10), // the whole body
      openCardSlice(cardBody('NEW')),
    )!;
    expect(after).not.toBeNull();
    expect(topLevelTypes(after.doc)).toEqual(['card']);
    expect(childTypes(firstCard(after.doc))).toEqual([
      'tag', 'card_body', 'cite_paragraph',
    ]);
    expect(firstOfType(after.doc, 'card_body').textContent).toBe('NEW');
    expect(firstCard(after.doc).firstChild!.attrs['id']).toBe('t1');
  });

  it('cite over a FULL card_body selection → becomes a cite, card intact', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Replace me'))]);
    const after = fitRange(
      doc,
      posInText(doc, 'Replace me', 0),
      posInText(doc, 'Replace me', 10),
      openCardSlice(citePara('C24')),
    )!;
    expect(after).not.toBeNull();
    expect(childTypes(firstCard(after.doc))).toEqual(['tag', 'cite_paragraph']);
    expect(firstOfType(after.doc, 'cite_paragraph').textContent).toBe('C24');
  });

  it('selection spanning two blocks of the SAME card → fits, one card survives', () => {
    const doc = makeDoc([
      cardWith(tag('T', 't1'), cardBody('AAA'), citePara('BBB')),
    ]);
    const after = fitRange(
      doc,
      posInText(doc, 'AAA', 1),
      posInText(doc, 'BBB', 2),
      openCardSlice(cardBody('X')),
    )!;
    expect(after).not.toBeNull();
    expect(topLevelTypes(after.doc)).toEqual(['card']); // still exactly ONE card
    expect(firstCard(after.doc).firstChild!.type.name).toBe('tag');
    expect(firstCard(after.doc).firstChild!.attrs['id']).toBe('t1');
  });

  it('a tag-led paste over a selection still bails → split path breaks the card', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('Smith body'))]);
    const slice = new Slice(Fragment.fromArray([tag('New', 'n1')]), 0, 0);
    const base = EditorState.create({ doc, plugins: [absorbPlugin] });
    const state = base.apply(
      base.tr.setSelection(
        TextSelection.create(
          base.doc,
          posInText(doc, 'Smith body', 0),
          posInText(doc, 'Smith body', 5),
        ),
      ),
    );
    expect(tryPasteCardContent(state, slice)).toBeNull();
  });

  it('a selection spanning two DIFFERENT cards bails (not silently merged)', () => {
    const doc = makeDoc([
      cardWith(tag('A', 'a1'), cardBody('aaa')),
      cardWith(tag('B', 'b1'), cardBody('bbb')),
    ]);
    const base = EditorState.create({ doc, plugins: [absorbPlugin] });
    const state = base.apply(
      base.tr.setSelection(
        TextSelection.create(
          base.doc,
          posInText(doc, 'aaa', 1),
          posInText(doc, 'bbb', 2),
        ),
      ),
    );
    expect(tryPasteCardContent(state, openCardSlice(cardBody('X')))).toBeNull();
  });
});

describe('card-paste matrix — outside a card', () => {
  it('body → drops in loose, no blank-tag card created', () => {
    const doc = makeDoc([cardWith(tag('T', 't1'), cardBody('a')), para('loose')]);
    const after = fit(doc, posInText(doc, 'loose', 2), openCardSlice(cardBody('PP')))!;
    expect(after).not.toBeNull();
    // exactly the one original card; no new (blank-tag) card spawned.
    const cards: PMNode[] = [];
    after.doc.forEach((c) => {
      if (c.type.name === 'card') cards.push(c);
    });
    expect(cards.length).toBe(1);
    expect(cards[0]!.firstChild!.textContent.length).toBeGreaterThan(0); // tag not blank
    expect(after.doc.textContent).toContain('PP');
  });

  it('body into an EMPTY paragraph: fills it (no stray empty line), cursor at end', () => {
    // No preceding card, so the absorb plugin leaves the loose paragraph alone
    // and we test the doc-level fill + cursor in isolation.
    const doc = makeDoc([para(''), cardWith(tag('T', 't1'), cardBody('a'))]);
    const after = fit(doc, blockStart(doc, 'paragraph'), openCardSlice(cardBody('PASTED')))!;
    expect(after).not.toBeNull();
    // the empty paragraph is FILLED — one paragraph holding the paste, not an
    // empty line with the content shoved below it.
    const paras: PMNode[] = [];
    after.doc.forEach((c) => {
      if (c.type.name === 'paragraph') paras.push(c);
    });
    expect(paras.length).toBe(1);
    expect(paras[0]!.textContent).toBe('PASTED');
    // cursor lands at the END of the pasted content (keep typing), not stuck
    // in the empty paragraph behind it.
    expect(after.selection.empty).toBe(true);
    expect(after.selection.$head.parent.type.name).toBe('paragraph');
    expect(after.selection.$head.parentOffset).toBe('PASTED'.length);
  });
});
