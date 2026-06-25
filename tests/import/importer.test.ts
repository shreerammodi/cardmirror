import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { importDoc } from '../../src/import/index.js';
import { exportDoc } from '../../src/export/index.js';

function bodyXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${inner}</w:body></w:document>`;
}

describe('importer — paragraph kinds', () => {
  it('imports a Heading1 paragraph as pocket', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pocket text</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('pocket');
    expect(doc.firstChild!.textContent).toBe('Pocket text');
  });

  it('imports a Heading2 paragraph as hat', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Hat</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('hat');
  });

  it('imports a Heading3 paragraph as block', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Block</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('block');
  });

  it('imports an Analytic paragraph as analytic_unit > analytic', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Analytic"/></w:pPr><w:r><w:t>An analytic</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
    expect(doc.firstChild!.firstChild!.type.name).toBe('analytic');
    expect(doc.firstChild!.firstChild!.textContent).toBe('An analytic');
  });

  it('absorbs body paragraphs after a standalone analytic into the unit', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Analytic"/></w:pPr><w:r><w:t>Header</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body 1</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body 2</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    const unit = doc.firstChild!;
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.childCount).toBe(3);
    expect(unit.child(0).type.name).toBe('analytic');
    expect(unit.child(1).type.name).toBe('card_body');
    expect(unit.child(2).type.name).toBe('card_body');
  });

  it('imports an Undertag paragraph as undertag', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Undertag"/></w:pPr><w:r><w:t>Undertag</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('undertag');
  });

  it('imports a Normal paragraph (no pStyle) as paragraph', () => {
    const xml = bodyXml(`<w:p><w:r><w:t>Plain</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });

  it('imports an unknown pStyle as paragraph (stylepox cleanup)', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="AAAUNDERLINEKEYBOARD"/></w:pPr><w:r><w:t>Junk</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });
});

// A doc whose tags/headings are plain "Normal" + a direct outline level (no
// heading style) — mirrors the style cleaner's outline-level header detection.
describe('importer — outline-level heading promotion', () => {
  it('promotes a Normal paragraph with outlineLvl 3 + bold to a tag', () => {
    const xml = bodyXml(
      `<w:p><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="26"/></w:rPr><w:t>The tag</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Body</w:t></w:r></w:p>`,
    );
    const card = importDoc(xml).firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.firstChild!.type.name).toBe('tag');
    expect(card.firstChild!.textContent).toBe('The tag');
  });

  it('leaves a Normal outlineLvl-3 paragraph that is NOT bold as a paragraph', () => {
    const doc = importDoc(
      bodyXml(`<w:p><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:r><w:t>Not bold</w:t></w:r></w:p>`),
    );
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });

  it('promotes outlineLvl 0 + bold + 26pt to pocket, but not without the size', () => {
    const pocket = importDoc(
      bodyXml(
        `<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="52"/></w:rPr><w:t>P</w:t></w:r></w:p>`,
      ),
    );
    expect(pocket.firstChild!.type.name).toBe('pocket');
    // bold but no 26pt → the cleaner's size guardrail holds, stays a paragraph.
    const notPocket = importDoc(
      bodyXml(`<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>P</w:t></w:r></w:p>`),
    );
    expect(notPocket.firstChild!.type.name).toBe('paragraph');
  });

  it('promotes outlineLvl 2 + bold + underline + 16pt to block', () => {
    const doc = importDoc(
      bodyXml(
        `<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="32"/></w:rPr><w:t>B</w:t></w:r></w:p>`,
      ),
    );
    expect(doc.firstChild!.type.name).toBe('block');
  });

  it('promotes via an inherited (basedOn) outline level + bold', () => {
    // "CustomX" sets neither outline level nor bold itself — it inherits both
    // from Heading4 through basedOn, and the paragraph has no direct formatting.
    // So this only works if the importer resolves effective outline/bold through
    // basedOn (the un-promoted result would be a plain paragraph).
    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>` +
      `<w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="CustomX"><w:name w:val="Custom X"/>` +
      `<w:basedOn w:val="Heading4"/></w:style></w:styles>`;
    const card = importDoc(
      bodyXml(
        `<w:p><w:pPr><w:pStyle w:val="CustomX"/></w:pPr><w:r><w:t>Inherited tag</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>Body</w:t></w:r></w:p>`,
      ),
      null,
      null,
      styles,
    ).firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.firstChild!.type.name).toBe('tag');
    expect(card.firstChild!.textContent).toBe('Inherited tag');
  });
});

describe('importer — analytic style fallback', () => {
  // Build a minimal word/styles.xml declaring the given styles.
  // Each entry: { id, name?, type? } (type defaults to 'paragraph').
  function stylesXml(
    defs: Array<{ id: string; name?: string; type?: string }>,
  ): string {
    const styleEls = defs
      .map((d) => {
        const type = d.type ?? 'paragraph';
        const nameEl = d.name ? `<w:name w:val="${d.name}"/>` : '';
        return `<w:style w:type="${type}" w:styleId="${d.id}">${nameEl}</w:style>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styleEls}</w:styles>`;
  }

  function importWithStyles(
    inner: string,
    defs: Array<{ id: string; name?: string; type?: string }>,
  ) {
    return importDoc(bodyXml(inner), null, null, stylesXml(defs));
  }

  it('maps a style named "Analytic Real" to analytic (rule 1, by name)', () => {
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="AnalyticReal"/></w:pPr><w:r><w:t>An analytic</w:t></w:r></w:p>`,
      [{ id: 'AnalyticReal', name: 'Analytic Real' }],
    );
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
    expect(doc.firstChild!.firstChild!.type.name).toBe('analytic');
  });

  it('maps "Analytic Real" by styleId even when styles.xml is absent (rule 1, by id)', () => {
    // No styles passed → synthesized StyleInfo, styleId-only match.
    const doc = importDoc(
      bodyXml(
        `<w:p><w:pPr><w:pStyle w:val="AnalyticReal"/></w:pPr><w:r><w:t>An analytic</w:t></w:r></w:p>`,
      ),
    );
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
  });

  it('maps a paragraph style whose name contains "analytic" to analytic (rule 2)', () => {
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="CustomAnaly"/></w:pPr><w:r><w:t>Tagline</w:t></w:r></w:p>`,
      [{ id: 'CustomAnaly', name: 'Card Analytic Heading' }],
    );
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
  });

  it('maps a paragraph style whose styleId contains "analytic" to analytic (rule 2)', () => {
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="MyAnalyticHdg"/></w:pPr><w:r><w:t>Tagline</w:t></w:r></w:p>`,
      [{ id: 'MyAnalyticHdg', name: 'Custom Heading' }],
    );
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
  });

  it('does NOT map a character-type "analytic" style via rule 2', () => {
    // Rule 2 is paragraph-only; a character style named with "analytic"
    // referenced as a pStyle stays a plain paragraph.
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="AnalyticChar2"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`,
      [{ id: 'AnalyticChar2', name: 'Analytic Char Alt', type: 'character' }],
    );
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });

  it('leaves an unrelated paragraph style as a plain paragraph', () => {
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`,
      [{ id: 'BodyText', name: 'Body Text' }],
    );
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });

  it('canonical styleIds still win over the fallback', () => {
    // Undertag has "analytic" nowhere; verify a canonical id is untouched
    // and that the exact-lookup path takes precedence in general.
    const doc = importWithStyles(
      `<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag</w:t></w:r></w:p>`,
      [{ id: 'Heading4', name: 'heading 4' }],
    );
    // A lone tag gets wrapped in a card by the grouping pass.
    expect(doc.firstChild!.type.name).toBe('card');
    expect(doc.firstChild!.firstChild!.type.name).toBe('tag');
  });
});

describe('importer — card grouping', () => {
  it('classifies Normals after a Tag by cite_mark presence: cite-styled → cite_paragraph, plain → card_body', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag text</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Author 2024, Source</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body text.</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('card');
    const card = doc.firstChild!;
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(0).textContent).toBe('Tag text');
    expect(card.child(1).type.name).toBe('cite_paragraph');
    expect(card.child(1).textContent).toBe('Author 2024, Source');
    expect(card.child(2).type.name).toBe('card_body');
    expect(card.child(2).textContent).toBe('Body text.');
  });

  it('classifies multiple cite-styled Normals as multiple cite_paragraphs', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Cite 1</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Cite 2</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    const card = doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph', 'card_body']);
  });

  it('handles a card with just a tag (no body)', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Lonely</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Next block</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('card');
    expect(doc.firstChild!.childCount).toBe(1);
    expect(doc.child(1).type.name).toBe('block');
  });

  it('handles two consecutive Tags as two cards', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag 1</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag 2</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('card');
    expect(doc.child(1).type.name).toBe('card');
  });

  it('absorbs undertags after a tag into the same card', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag text</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Undertag"/></w:pPr><w:r><w:t>Sub-tag note</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Author 2024</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('card');
    const card = doc.firstChild!;
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('undertag');
    expect(card.child(1).textContent).toBe('Sub-tag note');
    expect(card.child(2).type.name).toBe('cite_paragraph');
    expect(card.child(3).type.name).toBe('card_body');
  });

  it('absorbs multiple undertags after a single tag', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Undertag"/></w:pPr><w:r><w:t>Note 1</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Undertag"/></w:pPr><w:r><w:t>Note 2</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    const card = doc.firstChild!;
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('undertag');
    expect(card.child(2).type.name).toBe('undertag');
    // Body has no cite_mark, so it's card_body (not cite_paragraph).
    expect(card.child(3).type.name).toBe('card_body');
  });

  it('handles in-card analytic between tag and body', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Analytic"/></w:pPr><w:r><w:t>An analytic</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.type.name).toBe('card');
    const card = doc.firstChild!;
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('analytic');
    expect(card.child(2).type.name).toBe('card_body');
  });

  it('absorbs a table that follows a tag into the card', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag text</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body before</w:t></w:r></w:p>
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:r><w:t>Body after</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.childCount).toBe(1);
    const card = doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.childCount).toBe(4);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(2).type.name).toBe('table');
    expect(card.child(3).type.name).toBe('card_body');
  });

  it('absorbs a table that follows an analytic into the analytic_unit', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Analytic"/></w:pPr><w:r><w:t>Analytic header</w:t></w:r></w:p>
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `);
    const doc = importDoc(xml);
    const au = doc.firstChild!;
    expect(au.type.name).toBe('analytic_unit');
    expect(au.childCount).toBe(2);
    expect(au.child(0).type.name).toBe('analytic');
    expect(au.child(1).type.name).toBe('table');
  });

  it('stops absorbing at the next heading boundary even mid-table-run', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag A</w:t></w:r></w:p>
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag B</w:t></w:r></w:p>
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>second</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `);
    const doc = importDoc(xml);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('card');
    expect(doc.child(0).childCount).toBe(2); // tag + table
    expect(doc.child(0).child(1).type.name).toBe('table');
    expect(doc.child(1).type.name).toBe('card');
    expect(doc.child(1).childCount).toBe(2);
    expect(doc.child(1).child(1).type.name).toBe('table');
  });
});

describe('importer — heading IDs from bookmarks', () => {
  it('extracts pmd-heading-<uuid> bookmark to id attr', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:bookmarkStart w:id="0" w:name="pmd-heading-deadbeef-1234-5678-9abc-def012345678"/>
        <w:r><w:t>Pocket</w:t></w:r>
        <w:bookmarkEnd w:id="0"/>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.attrs['id']).toBe('deadbeef-1234-5678-9abc-def012345678');
  });

  it('generates a fresh id when no bookmark is present', () => {
    const xml = bodyXml(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pocket</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    const id = doc.firstChild!.attrs['id'];
    expect(id).toMatch(/^[0-9a-f]{8}-/i);
  });

  it('ignores non-pmd bookmark names', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:bookmarkStart w:id="0" w:name="_GoBack"/>
        <w:r><w:t>Pocket</w:t></w:r>
        <w:bookmarkEnd w:id="0"/>
      </w:p>
    `);
    const doc = importDoc(xml);
    const id = doc.firstChild!.attrs['id'];
    // Should be a fresh UUID, not _GoBack.
    expect(id).toMatch(/^[0-9a-f]{8}-/i);
  });
});

describe('importer — marks from rPr', () => {
  function importInline(rPr: string): readonly _Mark[] {
    const xml = bodyXml(`<w:p><w:r><w:rPr>${rPr}</w:rPr><w:t>foo</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    const para = doc.firstChild!;
    return para.firstChild!.marks;
  }

  it('extracts cite_mark from rStyle="Style13ptBold"', () => {
    const marks = importInline('<w:rStyle w:val="Style13ptBold"/>');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.type.name).toBe('cite_mark');
  });

  it('extracts underline_mark from rStyle="StyleUnderline"', () => {
    const marks = importInline('<w:rStyle w:val="StyleUnderline"/>');
    expect(marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
  });

  it('extracts underline_mark from legacy rStyle="StyleBoldUnderline"', () => {
    // Pre-modern Verbatim distributions shipped "Style Bold
    // Underline" (styleId `StyleBoldUnderline`) as the underline
    // character style. 13-14 era debate files have it on
    // thousands of runs.
    const marks = importInline('<w:rStyle w:val="StyleBoldUnderline"/>');
    expect(marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
  });

  it('extracts cite_mark from legacy rStyle="StyleStyleBold12pt"', () => {
    const marks = importInline('<w:rStyle w:val="StyleStyleBold12pt"/>');
    expect(marks.some((m) => m.type.name === 'cite_mark')).toBe(true);
  });

  it('extracts emphasis_mark from rStyle="Emphasis"', () => {
    const marks = importInline('<w:rStyle w:val="Emphasis"/>');
    expect(marks.some((m) => m.type.name === 'emphasis_mark')).toBe(true);
  });

  it('extracts undertag_mark from rStyle="UndertagChar"', () => {
    const marks = importInline('<w:rStyle w:val="UndertagChar"/>');
    expect(marks.some((m) => m.type.name === 'undertag_mark')).toBe(true);
  });

  it('extracts analytic_mark from rStyle="AnalyticChar"', () => {
    const marks = importInline('<w:rStyle w:val="AnalyticChar"/>');
    expect(marks.some((m) => m.type.name === 'analytic_mark')).toBe(true);
  });

  it('extracts bold from <w:b/>', () => {
    const marks = importInline('<w:b/>');
    expect(marks.some((m) => m.type.name === 'bold')).toBe(true);
  });

  it('maps explicit bold-off (<w:b w:val="0"/>) to a bold_off mark', () => {
    const marks = importInline('<w:b w:val="0"/>');
    expect(marks.some((m) => m.type.name === 'bold')).toBe(false);
    // Preserved as bold_off so it round-trips AND renders (un-bolded word
    // inside a bold-by-default tag), rather than being silently dropped.
    expect(marks.some((m) => m.type.name === 'bold_off')).toBe(true);
  });

  it('maps bold-off via w:val="false" to a bold_off mark', () => {
    const marks = importInline('<w:b w:val="false"/>');
    expect(marks.some((m) => m.type.name === 'bold_off')).toBe(true);
  });

  it('extracts italic from <w:i/>', () => {
    const marks = importInline('<w:i/>');
    expect(marks.some((m) => m.type.name === 'italic')).toBe(true);
  });

  it('extracts superscript from <w:vertAlign w:val="superscript"/>', () => {
    const marks = importInline('<w:vertAlign w:val="superscript"/>');
    expect(marks.some((m) => m.type.name === 'superscript')).toBe(true);
  });

  it('extracts subscript from <w:vertAlign w:val="subscript"/>', () => {
    const marks = importInline('<w:vertAlign w:val="subscript"/>');
    expect(marks.some((m) => m.type.name === 'subscript')).toBe(true);
  });

  it('ignores <w:vertAlign w:val="baseline"/> (the normal default)', () => {
    const marks = importInline('<w:vertAlign w:val="baseline"/>');
    expect(marks.some((m) => m.type.name === 'superscript')).toBe(false);
    expect(marks.some((m) => m.type.name === 'subscript')).toBe(false);
  });

  it('round-trips superscript and subscript through the exporter', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t>H</w:t></w:r>
        <w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r>
        <w:r><w:t>O, E=mc</w:t></w:r>
        <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>
      </w:p>
    `);
    const original = importDoc(xml);
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:vertAlign w:val="subscript"/>');
    expect(documentXml).toContain('<w:vertAlign w:val="superscript"/>');
    const re = importDoc(documentXml);
    let subFound = false, supFound = false;
    re.descendants((node) => {
      if (!node.isText) return;
      if (node.marks.some((m) => m.type.name === 'subscript') && node.text === '2') subFound = true;
      if (node.marks.some((m) => m.type.name === 'superscript') && node.text === '2') supFound = true;
    });
    expect(subFound).toBe(true);
    expect(supFound).toBe(true);
  });

  it('extracts highlight color', () => {
    const marks = importInline('<w:highlight w:val="yellow"/>');
    const hl = marks.find((m) => m.type.name === 'highlight');
    expect(hl).toBeDefined();
    expect(hl!.attrs['color']).toBe('yellow');
  });

  it('extracts font_color (the #555555 reference sentinel)', () => {
    const marks = importInline('<w:color w:val="555555"/>');
    const fc = marks.find((m) => m.type.name === 'font_color');
    expect(fc).toBeDefined();
    expect(fc!.attrs['color']).toBe('555555');
  });

  it('extracts font_size in half-points', () => {
    const marks = importInline('<w:sz w:val="26"/>');
    const fs = marks.find((m) => m.type.name === 'font_size');
    expect(fs).toBeDefined();
    expect(fs!.attrs['halfPoints']).toBe(26);
  });

  it('extracts strikethrough from <w:strike/>', () => {
    const marks = importInline('<w:strike/>');
    expect(marks.some((m) => m.type.name === 'strikethrough')).toBe(true);
  });

  it('also recognizes <w:dstrike/> as strikethrough (double → single on round-trip)', () => {
    const marks = importInline('<w:dstrike/>');
    expect(marks.some((m) => m.type.name === 'strikethrough')).toBe(true);
  });

  it('does not extract strikethrough when <w:strike w:val="0"/>', () => {
    const marks = importInline('<w:strike w:val="0"/>');
    expect(marks.some((m) => m.type.name === 'strikethrough')).toBe(false);
  });

  it('extracts shading (the #D2D2D2 protected-highlight sentinel)', () => {
    const marks = importInline('<w:shd w:val="clear" w:color="auto" w:fill="D2D2D2"/>');
    const sh = marks.find((m) => m.type.name === 'shading');
    expect(sh).toBeDefined();
    expect(sh!.attrs['color']).toBe('D2D2D2');
  });

  it('recognizes 6-pt ¶ as Verbatim pilcrow (pilcrow_marker, not font_size)', () => {
    // A run that's just a ¶ glyph at 6pt: Verbatim's pilcrow encoding.
    // The importer should swap the font_size:12 mark for the non-
    // inclusive pilcrow_marker.
    const xml = bodyXml(
      '<w:p><w:r><w:rPr><w:sz w:val="12"/></w:rPr><w:t>¶</w:t></w:r></w:p>',
    );
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.text).toBe('¶');
    expect(text.marks.some((m) => m.type.name === 'pilcrow_marker')).toBe(true);
    expect(text.marks.some((m) => m.type.name === 'font_size')).toBe(false);
  });

  it('does NOT touch 6-pt runs that are not just a single ¶', () => {
    // 6pt text that includes ¶ as part of regular content should keep
    // the font_size mark; we only swap when the whole run is the ¶.
    const xml = bodyXml(
      '<w:p><w:r><w:rPr><w:sz w:val="12"/></w:rPr><w:t>tiny ¶ tiny</w:t></w:r></w:p>',
    );
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks.some((m) => m.type.name === 'font_size')).toBe(true);
    expect(text.marks.some((m) => m.type.name === 'pilcrow_marker')).toBe(false);
  });

  it('extracts font_family from <w:rFonts> (prefers w:ascii)', () => {
    const marks = importInline('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
    const ff = marks.find((m) => m.type.name === 'font_family');
    expect(ff).toBeDefined();
    expect(ff!.attrs['name']).toBe('Arial');
  });

  it('font_family falls back to w:hAnsi when w:ascii is missing', () => {
    const marks = importInline('<w:rFonts w:hAnsi="Times New Roman"/>');
    const ff = marks.find((m) => m.type.name === 'font_family');
    expect(ff).toBeDefined();
    expect(ff!.attrs['name']).toBe('Times New Roman');
  });

  it('font_family is dropped when no font name is present', () => {
    const marks = importInline('<w:rFonts/>');
    const ff = marks.find((m) => m.type.name === 'font_family');
    expect(ff).toBeUndefined();
  });

  it('does not double-count underline when both rStyle="StyleUnderline" and <w:u/> are present', () => {
    const marks = importInline('<w:rStyle w:val="StyleUnderline"/><w:u w:val="single"/>');
    const count = marks.filter((m) => m.type.name === 'underline_mark').length;
    expect(count).toBe(1);
  });
});

describe('importer — hyperlinks', () => {
  it('attaches a link mark from a w:hyperlink element', () => {
    const docXml = bodyXml(`
      <w:p>
        <w:hyperlink r:id="rId2" w:history="1">
          <w:r><w:t>click</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `);
    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`;
    const doc = importDoc(docXml, relsXml);
    const para = doc.firstChild!;
    const text = para.firstChild!;
    const linkMark = text.marks.find((m) => m.type.name === 'link');
    expect(linkMark).toBeDefined();
    expect(linkMark!.attrs['href']).toBe('https://example.com');
  });

  it('converts a HYPERLINK field code to a link mark on the result runs', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r>
        <w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example/page" </w:instrText></w:r>
        <w:r><w:fldChar w:fldCharType="separate"/></w:r>
        <w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>field link</w:t></w:r>
        <w:r><w:fldChar w:fldCharType="end"/></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const para = doc.firstChild!;
    let found = false;
    para.descendants((node) => {
      if (node.isText && node.text === 'field link') {
        found = true;
        const link = node.marks.find((m) => m.type.name === 'link');
        expect(link).toBeDefined();
        expect(link!.attrs['href']).toBe('https://field.example/page');
      }
    });
    expect(found).toBe(true);
    // Instruction text must not bleed into the rendered output.
    expect(para.textContent).toBe('field link');
  });

  it('drops non-hyperlink field codes but keeps their result text', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t>Page </w:t></w:r>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r>
        <w:r><w:instrText xml:space="preserve"> PAGE \\* MERGEFORMAT </w:instrText></w:r>
        <w:r><w:fldChar w:fldCharType="separate"/></w:r>
        <w:r><w:t>7</w:t></w:r>
        <w:r><w:fldChar w:fldCharType="end"/></w:r>
        <w:r><w:t> of 10</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const para = doc.firstChild!;
    expect(para.textContent).toBe('Page 7 of 10');
    para.descendants((node) => {
      if (node.isText && node.text === '7') {
        expect(node.marks.find((m) => m.type.name === 'link')).toBeUndefined();
      }
    });
  });
});

describe('importer — paragraph indent', () => {
  it('reads w:left from <w:ind/> as the paragraph indent dxa value', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:ind w:left="1440"/></w:pPr>
        <w:r><w:t>indented</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const para = doc.firstChild!;
    expect(para.type.name).toBe('paragraph');
    expect(para.attrs['indent']).toBe(1440);
  });

  it('falls back to w:start when w:left is absent', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:ind w:start="720"/></w:pPr>
        <w:r><w:t>start-indented</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.attrs['indent']).toBe(720);
  });

  it('treats non-positive or missing indent as 0', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:ind w:left="-100"/></w:pPr>
        <w:r><w:t>x</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.attrs['indent']).toBe(0);
  });

  it('round-trips indent through the exporter as <w:ind w:left="…"/>', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:ind w:left="1080"/></w:pPr>
        <w:r><w:t>indented</w:t></w:r>
      </w:p>
    `);
    const original = importDoc(xml);
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:ind w:left="1080"/>');
    const reimported = importDoc(documentXml);
    expect(reimported.firstChild!.attrs['indent']).toBe(1080);
  });

  it('preserves indent across heading + card_body structures (cards)', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading4"/><w:ind w:left="360"/></w:pPr>
        <w:r><w:t>Tag indented</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:ind w:left="720"/></w:pPr>
        <w:r><w:t>body indented</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const card = doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(0).attrs['indent']).toBe(360);
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(1).attrs['indent']).toBe(720);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:ind w:left="360"/>');
    expect(documentXml).toContain('<w:ind w:left="720"/>');
  });
});

describe('importer — comment ranges', () => {
  it('applies comment_range marks from <w:commentRangeStart/End> brackets', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">before </w:t></w:r>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t xml:space="preserve">commented </w:t></w:r>
        <w:r><w:t>text</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
        <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
        <w:r><w:t xml:space="preserve"> after</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    let foundCommented = '';
    let foundUncommented = '';
    doc.descendants((node) => {
      if (!node.isText) return;
      const marked = node.marks.some((m) => m.type.name === 'comment_range');
      if (marked) foundCommented += node.text;
      else foundUncommented += node.text;
    });
    expect(foundCommented).toBe('commented text');
    expect(foundUncommented).toBe('before  after');
  });

  it('handles overlapping comment ranges on the same text', () => {
    const xml = bodyXml(`
      <w:p>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t xml:space="preserve">A </w:t></w:r>
        <w:commentRangeStart w:id="2"/>
        <w:r><w:t xml:space="preserve">B </w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
        <w:r><w:t>C</w:t></w:r>
        <w:commentRangeEnd w:id="2"/>
      </w:p>
    `);
    const doc = importDoc(xml);
    const marks: Record<string, string[]> = {};
    doc.descendants((node) => {
      if (!node.isText) return;
      const ids = node.marks
        .filter((m) => m.type.name === 'comment_range')
        .map((m) => String(m.attrs['threadId']))
        .sort();
      marks[node.text!] = ids;
    });
    expect(marks['A ']).toEqual(['1']);
    expect(marks['B ']).toEqual(['1', '2']);
    expect(marks['C']).toEqual(['2']);
  });

  it('round-trips a single comment thread through export and re-import', () => {
    const docXml = bodyXml(`
      <w:p>
        <w:commentRangeStart w:id="5"/>
        <w:r><w:t>flagged</w:t></w:r>
        <w:commentRangeEnd w:id="5"/>
        <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="5"/></w:r>
      </w:p>
    `);
    const original = importDoc(docXml);
    // Synthesize the thread state the editor would have built from
    // comments.xml — exportDoc requires explicit threads in opts to
    // emit anything.
    const threads = [
      {
        id: '5',
        comments: [
          {
            id: '5',
            author: 'Tester',
            initials: 'T',
            date: '2026-05-13T00:00:00Z',
            text: 'Is this right?',
            kind: 'human' as const,
            parentId: null,
          },
        ],
      },
    ];
    const { documentXml, commentsXml, commentsExtendedXml } = exportDoc(original, { threads });
    expect(documentXml).toContain('<w:commentRangeStart w:id="5"/>');
    expect(documentXml).toContain('<w:commentRangeEnd w:id="5"/>');
    expect(documentXml).toContain('<w:commentReference w:id="5"/>');
    expect(commentsXml).toContain('<w:comment w:id="5"');
    expect(commentsXml).toContain('Is this right?');
    expect(commentsExtendedXml).toContain('<w15:commentEx');
    const re = importDoc(documentXml);
    let foundCommented = false;
    re.descendants((node) => {
      if (node.isText && node.text === 'flagged') {
        foundCommented = node.marks.some(
          (m) => m.type.name === 'comment_range' && m.attrs['threadId'] === '5',
        );
      }
    });
    expect(foundCommented).toBe(true);
  });

  it('omits comment brackets when no threads are passed to exportDoc', () => {
    const docXml = bodyXml(`
      <w:p>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t>flagged</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
        <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
      </w:p>
    `);
    const original = importDoc(docXml);
    // No threads → exporter strips brackets even though the mark is
    // still on the doc tree. Matches Save-As "Include comments: off".
    const { documentXml, commentsXml, commentsExtendedXml } = exportDoc(original);
    expect(documentXml).not.toContain('w:commentRangeStart');
    expect(documentXml).not.toContain('w:commentRangeEnd');
    expect(documentXml).not.toContain('w:commentReference');
    expect(commentsXml).toBeNull();
    expect(commentsExtendedXml).toBeNull();
  });
});

describe('importer — paragraph spacing', () => {
  it('captures <w:spacing> attributes verbatim into the paragraph attr', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr>
          <w:spacing w:before="240" w:after="120" w:line="276" w:lineRule="auto"/>
        </w:pPr>
        <w:r><w:t>body</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const sp = doc.firstChild!.attrs['spacing'] as Record<string, string> | null;
    expect(sp).toBeTruthy();
    expect(sp!['w:before']).toBe('240');
    expect(sp!['w:after']).toBe('120');
    expect(sp!['w:line']).toBe('276');
    expect(sp!['w:lineRule']).toBe('auto');
  });

  it('round-trips spacing through the exporter unchanged', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr>
          <w:spacing w:before="240" w:after="120" w:line="276" w:lineRule="auto"/>
        </w:pPr>
        <w:r><w:t>body</w:t></w:r>
      </w:p>
    `);
    const original = importDoc(xml);
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('w:before="240"');
    expect(documentXml).toContain('w:after="120"');
    expect(documentXml).toContain('w:line="276"');
    expect(documentXml).toContain('w:lineRule="auto"');
    // Re-import preserves the same attr set.
    const re = importDoc(documentXml);
    const before = original.firstChild!.attrs['spacing'];
    const after = re.firstChild!.attrs['spacing'];
    expect(after).toEqual(before);
  });

  it('preserves spacing alongside indent and other pPr attrs', () => {
    const xml = bodyXml(`
      <w:p>
        <w:pPr>
          <w:pStyle w:val="Heading4"/>
          <w:spacing w:before="80"/>
          <w:ind w:left="360"/>
        </w:pPr>
        <w:r><w:t>Tag text</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const tag = doc.firstChild!.child(0);
    expect(tag.type.name).toBe('tag');
    expect(tag.attrs['indent']).toBe(360);
    const sp = tag.attrs['spacing'] as Record<string, string> | null;
    expect(sp!['w:before']).toBe('80');
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('w:before="80"');
    expect(documentXml).toContain('<w:ind w:left="360"/>');
  });

  it('paragraphs without <w:spacing> have a null spacing attr (no clutter)', () => {
    const xml = bodyXml(`<w:p><w:r><w:t>plain</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    expect(doc.firstChild!.attrs['spacing']).toBe(null);
  });
});

describe('importer — table / cell raw properties round-trip', () => {
  it('captures and re-emits `<w:tblPr>` extras (borders, custom style)', () => {
    const tblPrInner =
      '<w:tblStyle w:val="MyTable"/>' +
      '<w:tblW w:w="5000" w:type="pct"/>' +
      '<w:tblBorders>' +
      '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '</w:tblBorders>';
    const xml = bodyXml(`
      <w:tbl>
        <w:tblPr>${tblPrInner}</w:tblPr>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `);
    const original = importDoc(xml);
    const table = original.firstChild!;
    expect(table.type.name).toBe('table');
    // The opaque attr should hold the captured fragment (order
    // preserved by the serializer).
    const captured = String(table.attrs['rawTblPr'] ?? '');
    expect(captured).toContain('<w:tblStyle w:val="MyTable"/>');
    expect(captured).toContain('<w:tblBorders>');
    expect(captured).toContain('<w:top w:val="single"');
    // Round-trip: the exact fragment goes back into <w:tblPr>.
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:tblStyle w:val="MyTable"/>');
    expect(documentXml).toContain('<w:tblBorders>');
    // And re-import preserves it again — fully byte-stable.
    const re = importDoc(documentXml);
    const captured2 = String(re.firstChild!.attrs['rawTblPr'] ?? '');
    expect(captured2).toBe(captured);
  });

  it('captures and re-emits per-cell <w:tcBorders> + <w:shd>', () => {
    const tcPrExtras =
      '<w:tcBorders>' +
      '<w:top w:val="single" w:sz="4" w:color="000000"/>' +
      '<w:left w:val="single" w:sz="4" w:color="000000"/>' +
      '<w:bottom w:val="single" w:sz="4" w:color="000000"/>' +
      '<w:right w:val="single" w:sz="4" w:color="000000"/>' +
      '</w:tcBorders>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/>';
    const xml = bodyXml(`
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc>
          <w:tcPr>
            <w:tcW w:w="3000" w:type="dxa"/>
            ${tcPrExtras}
          </w:tcPr>
          <w:p><w:r><w:t>cell</w:t></w:r></w:p>
        </w:tc></w:tr>
      </w:tbl>
    `);
    const original = importDoc(xml);
    const row = original.firstChild!.firstChild!;
    const cell = row.firstChild!;
    const raw = String(cell.attrs['rawTcPr'] ?? '');
    expect(raw).toContain('<w:tcBorders>');
    expect(raw).toContain('<w:shd');
    // gridSpan/vMerge/tcW were stripped (they're structurally regenerated)
    expect(raw).not.toContain('<w:tcW');
    expect(raw).not.toContain('<w:gridSpan');
    expect(raw).not.toContain('<w:vMerge');
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:tcBorders>');
    expect(documentXml).toContain('<w:shd w:val="clear"');
  });

  it('strips track-change markers (tblPrChange / tcPrChange / cellIns / cellDel)', () => {
    const xml = bodyXml(`
      <w:tbl>
        <w:tblPr>
          <w:tblStyle w:val="Plain"/>
          <w:tblPrChange w:id="1" w:author="A">
            <w:tblPr><w:tblStyle w:val="Old"/></w:tblPr>
          </w:tblPrChange>
        </w:tblPr>
        <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc>
          <w:tcPr>
            <w:tcW w:w="3000" w:type="dxa"/>
            <w:cellIns w:id="2" w:author="A"/>
            <w:tcPrChange w:id="3" w:author="A">
              <w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>
            </w:tcPrChange>
          </w:tcPr>
          <w:p><w:r><w:t>cell</w:t></w:r></w:p>
        </w:tc></w:tr>
      </w:tbl>
    `);
    const doc = importDoc(xml);
    const table = doc.firstChild!;
    const rawTbl = String(table.attrs['rawTblPr'] ?? '');
    expect(rawTbl).toContain('<w:tblStyle w:val="Plain"/>');
    expect(rawTbl).not.toContain('tblPrChange');
    const cell = table.firstChild!.firstChild!;
    const rawTc = String(cell.attrs['rawTcPr'] ?? '');
    expect(rawTc).not.toContain('cellIns');
    expect(rawTc).not.toContain('tcPrChange');
  });
});

describe('importer — track changes accept-on-import', () => {
  it('keeps text inside <w:ins> as normal content', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">Before </w:t></w:r>
        <w:ins w:id="1" w:author="A">
          <w:r><w:t>inserted</w:t></w:r>
        </w:ins>
        <w:r><w:t xml:space="preserve"> after</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('Before inserted after');
  });

  it('drops text inside <w:del> entirely', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">Keep </w:t></w:r>
        <w:del w:id="1" w:author="A">
          <w:r><w:delText xml:space="preserve">drop this </w:delText></w:r>
        </w:del>
        <w:r><w:t xml:space="preserve">end</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('Keep end');
  });

  it('accepts <w:moveTo> as kept and drops <w:moveFrom>', () => {
    const xml = bodyXml(`
      <w:p>
        <w:moveFrom w:id="1" w:author="A">
          <w:r><w:t>(removed source) </w:t></w:r>
        </w:moveFrom>
        <w:r><w:t xml:space="preserve">middle </w:t></w:r>
        <w:moveTo w:id="2" w:author="A">
          <w:r><w:t>(moved-in target)</w:t></w:r>
        </w:moveTo>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('middle (moved-in target)');
  });

  it('handles tracked changes nested inside a hyperlink', () => {
    const xml = bodyXml(`
      <w:p>
        <w:hyperlink>
          <w:r><w:t xml:space="preserve">visible </w:t></w:r>
          <w:ins w:id="1" w:author="A">
            <w:r><w:t>more</w:t></w:r>
          </w:ins>
          <w:del w:id="2" w:author="A">
            <w:r><w:delText> stale</w:delText></w:r>
          </w:del>
        </w:hyperlink>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('visible more');
  });
});

describe('importer — special hyphen characters', () => {
  it('imports w:noBreakHyphen as U+2011', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">F</w:t><w:noBreakHyphen/><w:t xml:space="preserve">16</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('F‑16');
  });

  it('imports w:softHyphen as U+00AD', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">anti</w:t><w:softHyphen/><w:t xml:space="preserve">dis</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.firstChild!.textContent).toBe('anti­dis');
  });

  it('round-trips U+2011 back to w:noBreakHyphen', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">F</w:t><w:noBreakHyphen/><w:t xml:space="preserve">16</w:t></w:r>
      </w:p>
    `);
    const original = importDoc(xml);
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:noBreakHyphen/>');
    const reimported = importDoc(documentXml);
    expect(reimported.firstChild!.textContent).toBe('F‑16');
  });

  it('round-trips U+00AD back to w:softHyphen', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:t xml:space="preserve">anti</w:t><w:softHyphen/><w:t xml:space="preserve">dis</w:t></w:r>
      </w:p>
    `);
    const original = importDoc(xml);
    const { documentXml } = exportDoc(original);
    expect(documentXml).toContain('<w:softHyphen/>');
    const reimported = importDoc(documentXml);
    expect(reimported.firstChild!.textContent).toBe('anti­dis');
  });
});

describe('importer — multi-paragraph patterns', () => {
  it('imports a doc with the multi-file pattern (Pocket → empty Pocket → Pocket)', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>File A</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>File B</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe('pocket');
    expect(doc.child(1).type.name).toBe('pocket');
    expect(doc.child(1).childCount).toBe(0);
    expect(doc.child(2).type.name).toBe('pocket');
  });

  it('imports a CP-style doc (no Heading1 at all)', () => {
    const xml = bodyXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Hat</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Block</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Tag</w:t></w:r></w:p>
    `);
    const doc = importDoc(xml);
    expect(doc.child(0).type.name).toBe('hat');
    expect(doc.child(1).type.name).toBe('block');
    expect(doc.child(2).type.name).toBe('card');
  });
});

describe('round-trip: import → export → import', () => {
  it('preserves a simple structure', () => {
    const original = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: '11111111-1111-1111-1111-111111111111' }, schema.text('Pocket')),
      schema.nodes['hat']!.create({ id: '22222222-2222-2222-2222-222222222222' }, schema.text('Hat')),
      schema.nodes['block']!.create({ id: '33333333-3333-3333-3333-333333333333' }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: '44444444-4444-4444-4444-444444444444' }, schema.text('Tag')),
        schema.nodes['cite_paragraph']!.create(
          null,
          schema.text('Author 2024', [schema.marks['cite_mark']!.create()]),
        ),
        schema.nodes['card_body']!.create(null, schema.text('Body')),
      ]),
    ]);

    const { documentXml, relsXml } = exportDoc(original);
    const reimported = importDoc(documentXml, relsXml);

    expect(reimported.childCount).toBe(4);
    expect(reimported.child(0).type.name).toBe('pocket');
    expect(reimported.child(0).textContent).toBe('Pocket');
    expect(reimported.child(0).attrs['id']).toBe('11111111-1111-1111-1111-111111111111');
    expect(reimported.child(1).type.name).toBe('hat');
    expect(reimported.child(2).type.name).toBe('block');
    expect(reimported.child(3).type.name).toBe('card');
    const card = reimported.child(3);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(0).attrs['id']).toBe('44444444-4444-4444-4444-444444444444');
    expect(card.child(1).type.name).toBe('cite_paragraph');
    expect(card.child(2).type.name).toBe('card_body');
  });

  it('preserves marks through round-trip', () => {
    const original = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('plain '),
        schema.text('underlined', [schema.marks['underline_mark']!.create()]),
        schema.text(' '),
        schema.text('highlighted', [
          schema.marks['underline_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
      ]),
    ]);

    const { documentXml, relsXml } = exportDoc(original);
    const reimported = importDoc(documentXml, relsXml);

    const para = reimported.firstChild!;
    expect(para.textContent).toBe('plain underlined highlighted');

    // Find the highlighted text node and verify its marks.
    let foundHighlighted = false;
    para.descendants((node) => {
      if (node.isText && node.text === 'highlighted') {
        foundHighlighted = true;
        expect(node.marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
        expect(node.marks.some((m) => m.type.name === 'highlight')).toBe(true);
      }
    });
    expect(foundHighlighted).toBe(true);
  });

  it('preserves hyperlinks through round-trip', () => {
    const original = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('see '),
        schema.text('this article', [schema.marks['link']!.create({ href: 'https://example.com/article' })]),
      ]),
    ]);

    const { documentXml, relsXml } = exportDoc(original);
    const reimported = importDoc(documentXml, relsXml);

    const para = reimported.firstChild!;
    let found = false;
    para.descendants((node) => {
      if (node.isText && node.text === 'this article') {
        found = true;
        const link = node.marks.find((m) => m.type.name === 'link');
        expect(link).toBeDefined();
        expect(link!.attrs['href']).toBe('https://example.com/article');
      }
    });
    expect(found).toBe(true);
  });
});

// Type alias used by the importInline helper above (declared here so it's
// hoisted via TypeScript type-only ordering rules).
type _Mark = ReturnType<typeof schema.marks['bold']['create']>;
