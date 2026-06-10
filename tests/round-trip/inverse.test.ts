/**
 * First-pass INVERSE tests: export an editor-authored document and
 * assert that importing the result reproduces the original node tree
 * exactly (`doc.eq`).
 *
 * This is a deliberately stronger property than the other round-trip
 * suites, which compare import-vs-reimport of real .docx files. That
 * proves *stability* (a second trip changes nothing) but not
 * *inverseness* (the first trip changes nothing) — and the difference
 * is exactly where the undertag-italic bug hid: parity `<w:i/>` came
 * back as a real italic mark on the first trip, then round-tripped
 * stably forever after.
 *
 * Constructs with KNOWN non-inverse behavior are pinned in the
 * "documented exceptions" block below with the expected output — so a
 * change in either direction (regression or fix) shows up as a test
 * failure that points here.
 */

import { describe, expect, it } from 'vitest';
import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';

async function roundTrip(doc: PMNode): Promise<PMNode> {
  return fromDocx(await toDocx(doc));
}

/** Rebuild every text node's mark set through `addToSet` (schema rank
 *  order). Mark *order* is not user-visible — transforms keep marks
 *  rank-sorted, but both hand-built fixtures and the importer push
 *  marks in arbitrary order, and `Node.eq` compares element-wise. */
function rankSorted(node: PMNode): PMNode {
  if (node.isText) {
    const sorted = node.marks.reduce((set, m) => m.addToSet(set), Mark.none);
    return node.mark(sorted);
  }
  const children: PMNode[] = [];
  node.content.forEach((child) => children.push(rankSorted(child)));
  return node.copy(Fragment.from(children));
}

async function expectInverse(doc: PMNode, label: string): Promise<void> {
  const after = await roundTrip(doc);
  const a = rankSorted(doc);
  const b = rankSorted(after);
  if (!a.eq(b)) {
    // eq gives no diff — surface both trees so the failure is readable.
    expect(b.toJSON(), `${label}: export∘import must be identity`).toEqual(a.toJSON());
  }
  expect(a.eq(b), `${label}: export∘import must be identity`).toBe(true);
}

function para(...content: PMNode[]): PMNode {
  return schema.nodes['paragraph']!.create(null, content);
}

function docOf(...blocks: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, blocks);
}

function marked(text: string, ...marks: Mark[]): PMNode {
  return schema.text(text, marks);
}

const m = (name: string, attrs?: Record<string, unknown>) =>
  schema.marks[name]!.create(attrs);

describe('inverse round-trip — per-mark', () => {
  /** One minimal doc per mark the schema claims to round-trip:
   *  plain lead-in + a marked run, in a body paragraph. */
  const PER_MARK: Array<[string, PMNode]> = [
    ['bold', marked('bold run', m('bold'))],
    ['italic', marked('italic run', m('italic'))],
    ['strikethrough', marked('struck run', m('strikethrough'))],
    ['superscript', marked('super run', m('superscript'))],
    ['subscript', marked('sub run', m('subscript'))],
    ['underline_mark', marked('underlined evidence', m('underline_mark'))],
    ['emphasis_mark', marked('emphasized words', m('emphasis_mark'))],
    ['undertag_mark', marked('undertagged evidence', m('undertag_mark'))],
    ['analytic_mark', marked('analytic words', m('analytic_mark'))],
    ['highlight (yellow)', marked('key phrase', m('highlight', { color: 'yellow' }))],
    ['highlight (green)', marked('other phrase', m('highlight', { color: 'green' }))],
    ['shading', marked('shaded words', m('shading', { color: 'D2D2D2' }))],
    ['font_color', marked('red words', m('font_color', { color: 'FF0000' }))],
    ['font_size', marked('big words', m('font_size', { halfPoints: 28 }))],
    ['font_family', marked('mono words', m('font_family', { name: 'Consolas' }))],
    ['link', marked('a link', m('link', { href: 'https://example.com/' }))],
    ['pilcrow_marker', marked('¶', m('pilcrow_marker'))],
  ];

  for (const [name, run] of PER_MARK) {
    it(`${name} survives export∘import unchanged`, async () => {
      await expectInverse(docOf(para(schema.text('plain lead-in '), run)), name);
    });
  }

  it('cite_mark survives unchanged in its canonical home (cite_paragraph)', async () => {
    // In a plain paragraph it instead promotes the paragraph — see the
    // documented exceptions below.
    await expectInverse(
      docOf(
        schema.nodes['card']!.create(null, [
          schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
          schema.nodes['cite_paragraph']!.create(null, [
            marked('Author 24', m('cite_mark')),
            schema.text(' — staff writer'),
          ]),
          schema.nodes['card_body']!.create(null, schema.text('body text')),
        ]),
      ),
      'cite_mark',
    );
  });

  it('underline_direct survives unchanged in a structural textblock (tag)', async () => {
    // In a body paragraph it canonicalizes to underline_mark — see the
    // documented exceptions below.
    await expectInverse(
      docOf(
        schema.nodes['card']!.create(null, [
          schema.nodes['tag']!.create(
            { id: newHeadingId() },
            marked('directly underlined tag', m('underline_direct')),
          ),
          schema.nodes['card_body']!.create(null, schema.text('body text')),
        ]),
      ),
      'underline_direct',
    );
  });

  it('mark combinations on one run survive unchanged', async () => {
    await expectInverse(
      docOf(
        para(
          marked('bold italic underline', m('bold'), m('italic'), m('underline_mark')),
          schema.text(' between '),
          marked(
            'colored sized highlighted',
            m('font_color', { color: '0000FF' }),
            m('font_size', { halfPoints: 26 }),
            m('highlight', { color: 'cyan' }),
          ),
        ),
      ),
      'combinations',
    );
  });
});

describe('inverse round-trip — editor-authored structure', () => {
  it('a full card under pocket/hat/block survives unchanged', async () => {
    const doc = docOf(
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Hat')),
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Aggression likely')),
        schema.nodes['cite_paragraph']!.create(null, [
          marked('Author 24', m('cite_mark')),
          schema.text(' — staff writer'),
        ]),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain context '),
          marked('underlined warrant', m('underline_mark')),
          schema.text(' more context '),
          marked('highlighted impact', m('highlight', { color: 'yellow' }), m('underline_mark')),
        ]),
      ]),
      schema.nodes['analytic_unit']!.create(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('Extend this')),
        schema.nodes['undertag']!.create(null, marked('it answers their turn', m('undertag_mark'))),
      ]),
    );
    await expectInverse(doc, 'card structure');
  });
});

describe('inverse round-trip — documented exceptions', () => {
  it('user italic on an undertag run is swallowed into the style', async () => {
    // The exporter emits <w:i/> on every undertag run (the style
    // implies italic display), so undertag and undertag+italic produce
    // IDENTICAL runs — the importer must pick one inverse image and
    // picks bare undertag (importer.ts parseRPr). Visual rendering is
    // unchanged; only the redundant mark is lost. Same trade as
    // underline_mark's dual-encoded <w:u/>.
    const before = docOf(
      para(marked('undertagged italic', m('undertag_mark'), m('italic'))),
    );
    const after = await roundTrip(before);
    const expected = docOf(para(marked('undertagged italic', m('undertag_mark'))));
    expect(rankSorted(after).eq(rankSorted(expected))).toBe(true);
  });

  it('a body paragraph carrying cite_mark promotes to cite_paragraph', async () => {
    // Word has no paragraph style for cite lines — classification is
    // content-based (hasCiteMark), so a plain paragraph with a cite run
    // canonically IS a cite_paragraph after import.
    const before = docOf(para(marked('Author 24', m('cite_mark'))));
    const after = await roundTrip(before);
    const expected = docOf(
      schema.nodes['cite_paragraph']!.create(null, marked('Author 24', m('cite_mark'))),
    );
    expect(rankSorted(after).eq(rankSorted(expected))).toBe(true);
  });

  it('underline_direct in a body paragraph canonicalizes to underline_mark', async () => {
    // Direct <w:u/> with no named style is promoted to the named-style
    // mark in body-like textblocks (the same normalization the editor's
    // named-style-normalizer applies to live documents); structural
    // textblocks keep underline_direct — see the per-mark tag test.
    const before = docOf(para(marked('direct underline', m('underline_direct'))));
    const after = await roundTrip(before);
    const expected = docOf(para(marked('direct underline', m('underline_mark'))));
    expect(rankSorted(after).eq(rankSorted(expected))).toBe(true);
  });
});
