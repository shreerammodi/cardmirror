/**
 * Auto-numbering → Word numbering on export (NUMBERING_PLAN.md §5). The skeleton
 * maps to native `<w:numPr>` (ilvl + numId) and a `word/numbering.xml`; no number
 * glyph is written — Word computes it. Each restart run gets a fresh numId (an
 * independent Word counter); a "continue" block keeps the running numId.
 */
import { describe, expect, it } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { exportDoc } from '../../src/export/index.js';

type Role = 'none' | 'number' | 'sub';
function card(tag: string, role: Role = 'none', restart = false): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function block(text: string, restart = true): PMNode {
  return schema.nodes['block']!.create({ id: newHeadingId(), numRestart: restart }, schema.text(text));
}
function doc(...kids: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, kids);
}
const numPr = (ilvl: number, numId: number): string =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
const numCount = (xml: string | null): number => (xml ? (xml.match(/<w:num w:numId=/g) ?? []).length : 0);
const numPrCount = (xml: string): number => (xml.match(/<w:numPr>/g) ?? []).length;

describe('export — numbered cards get numPr', () => {
  it('a number card → ilvl 0; numbering.xml has one num + the two levels', () => {
    const { documentXml, numberingXml } = exportDoc(doc(card('A', 'number')));
    expect(documentXml).toContain(numPr(0, 1));
    expect(numberingXml).toContain('<w:abstractNum w:abstractNumId="0">');
    expect(numberingXml).toContain('<w:numFmt w:val="decimal"/>');
    expect(numberingXml).toContain('<w:numFmt w:val="lowerLetter"/>');
    expect(numberingXml).toContain('<w:lvlText w:val="%1."/>');
    expect(numberingXml).toContain('<w:lvlText w:val="%2)"/>');
    expect(numCount(numberingXml)).toBe(1);
  });

  it('a sub card → ilvl 1', () => {
    const { documentXml } = exportDoc(doc(card('A', 'sub')));
    expect(documentXml).toContain(numPr(1, 1));
  });

  it('a skip (role none) gets no numPr', () => {
    const { documentXml, numberingXml } = exportDoc(doc(card('A')));
    expect(numPrCount(documentXml)).toBe(0);
    expect(numberingXml).toBeNull();
  });
});

describe('export — restart allocates a fresh numId', () => {
  it('a card restart mid-run starts a second numId', () => {
    const { documentXml, numberingXml } = exportDoc(
      doc(card('A', 'number'), card('B', 'number'), card('C', 'number', true)),
    );
    // A, B share numId 1; C restarts → numId 2.
    expect(documentXml).toContain(numPr(0, 1));
    expect(documentXml).toContain(numPr(0, 2));
    expect(numCount(numberingXml)).toBe(2);
  });

  it('a default block restart starts a new numId; each side is its own counter', () => {
    const { documentXml, numberingXml } = exportDoc(
      doc(block('One'), card('A', 'number'), card('B', 'number'), block('Two'), card('C', 'number')),
    );
    expect(documentXml).toContain(numPr(0, 1)); // A, B
    expect(documentXml).toContain(numPr(0, 2)); // C
    expect(numCount(numberingXml)).toBe(2);
  });
});

describe('export — a continue block keeps the running numId', () => {
  it('cards on both sides of a continue block share one numId', () => {
    const { documentXml, numberingXml } = exportDoc(
      doc(
        block('One'),
        card('A', 'number'),
        card('B', 'number'),
        block('Two', false), // continue
        card('C', 'number'),
        card('D', 'number'),
      ),
    );
    // One numId, used by all four cards.
    expect(numCount(numberingXml)).toBe(1);
    expect(numPrCount(documentXml)).toBe(4);
    expect((documentXml.match(/<w:numId w:val="1"\/>/g) ?? []).length).toBe(4);
  });
});
