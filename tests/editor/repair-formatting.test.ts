/**
 * AI Repair Formatting — signature analysis, plan parsing, and mark
 * application. The model only ever returns a signature→target mapping
 * (plus verbatim-fragment exceptions); these tests cover the analysis
 * that feeds it and the helper that applies it.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  collectBodyBlocks,
  groupBlocksByCard,
  analyzeCard,
  signatureKey,
  buildCardRequest,
  parseFormatResponse,
  applyFormatPlan,
  type FormatFlag,
} from '../../src/editor/ai/repair-formatting.js';

const m = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, t(text, m('cite_mark')));
}
function body(...inlines: ReturnType<typeof t>[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function card(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function para(...inlines: ReturnType<typeof t>[]) {
  return schema.nodes['paragraph']!.create(null, inlines);
}
function makeDoc(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Mark names on the text node at the given block-relative offset. */
function marksAt(doc: import('prosemirror-model').Node, needle: string): string[] {
  let found: string[] | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return found == null;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) found = node.marks.map((mk) => mk.type.name).sort();
    return found == null;
  });
  return found ?? [];
}

describe('collectBodyBlocks', () => {
  it('includes card_body and doc paragraphs; excludes tags, cites, structural blocks', () => {
    const doc = makeDoc(
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
      card(tag('TAG'), citePara('Author 24'), body(t('warrant text'))),
      para(t('loose body text')),
    );
    const blocks = collectBodyBlocks(doc, 0, doc.content.size);
    expect(blocks.map((b) => b.node.type.name)).toEqual(['card_body', 'paragraph']);
  });
});

describe('groupBlocksByCard', () => {
  it('one group per card, loose paragraphs pooled', () => {
    const doc = makeDoc(
      card(tag('A'), body(t('alpha one')), body(t('alpha two'))),
      card(tag('B'), body(t('beta one'))),
      para(t('loose text here')),
    );
    const groups = groupBlocksByCard(doc, collectBodyBlocks(doc, 0, doc.content.size));
    expect(groups.length).toBe(3);
    expect(groups[0]!.length).toBe(2);
    expect(groups[1]!.length).toBe(1);
    expect(groups[2]!.length).toBe(1);
  });
});

describe('analyzeCard', () => {
  it('builds the signature table from run marks', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('plain lead '),
          t('underlined text', m('underline_mark')),
          t(' and ', m('underline_mark')),
          t('bold underline', m('bold'), m('underline_mark')),
          t(' tail', m('underline_direct')),
        ),
      ),
    );
    const analysis = analyzeCard(collectBodyBlocks(doc, 0, doc.content.size));
    const keys = [...analysis.signatures.keys()].sort();
    expect(keys).toEqual(['b+u', 'du', 'plain', 'u']);
    // adjacent same-signature text nodes merge into one run
    const uSig = analysis.signatures.get('u')!;
    expect(uSig.runs).toBe(1);
    expect(uSig.samples[0]).toContain('underlined text');
  });

  it('flags small relative to the LARGEST common size, even when shrunk text is the majority', () => {
    const small = () => m('font_size', { halfPoints: 16 });
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('this shrunk connective text runs long and is the majority of characters here ', small()),
          t('was underlined once'),
          t(' and more shrunk text follows after it for padding', small()),
        ),
      ),
    );
    const analysis = analyzeCard(collectBodyBlocks(doc, 0, doc.content.size));
    const keys = [...analysis.signatures.keys()].sort();
    expect(keys).toEqual(['plain', 'small']);
    const plain = analysis.signatures.get('plain')!;
    expect(plain.samples[0]).toContain('was underlined once');
  });

  it('signatureKey sorts flags and names the empty set', () => {
    expect(signatureKey(new Set<FormatFlag>(['u', 'b']))).toBe('b+u');
    expect(signatureKey(new Set<FormatFlag>())).toBe('plain');
  });

  it('buildCardRequest carries text and the table', () => {
    const doc = makeDoc(card(tag('TAG'), body(t('hello '), t('world', m('underline_mark')))));
    const req = buildCardRequest(analyzeCard(collectBodyBlocks(doc, 0, doc.content.size)));
    expect(req).toContain('CARD TEXT:\nhello world');
    expect(req).toContain('FORMATTING SIGNATURES:');
    expect(req).toMatch(/\bu — 1 run/);
  });

  // Live miss 2026-06-10: an all-bold-underline card (pattern 3) was
  // mapped b+u → em — the model failed to notice the ABSENCE of plain
  // underlining. The fact is now computed and stated in the request.
  it('states the all-underlining-is-bold fact when no plain underline exists', () => {
    const doc = makeDoc(
      card(tag('TAG'), body(t('plain lead '), t('bold underlined', m('bold'), m('underline_mark')))),
    );
    const analysis = analyzeCard(collectBodyBlocks(doc, 0, doc.content.size));
    expect(analysis.hasPlainUnderline).toBe(false);
    expect(buildCardRequest(analysis)).toContain('NO plain (non-bold) underlining');
  });

  it('states that plain underlining exists when it does (even via direct underline)', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(t('direct ', m('underline_direct')), t('standout', m('bold'), m('underline_mark'))),
      ),
    );
    const analysis = analyzeCard(collectBodyBlocks(doc, 0, doc.content.size));
    expect(analysis.hasPlainUnderline).toBe(true);
    expect(buildCardRequest(analysis)).toContain('HAS plain (non-bold) underlining');
  });

  // Live miss: a size-encoded (pattern-4) card with NO underlining had the
  // shrunk MAJORITY text underlined and the base-size text stripped — the
  // model inverted the size direction. The FACTS now state the base size,
  // the shrunk share, and the direction explicitly, and never claim "all
  // underlining is bold" for a card that has no underlining at all.
  it('states the size-encoded direction for a pattern-4 card with no underline', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('READ', m('highlight')),
          t(' base-size read text ', m('emphasis_mark')),
          t('the long shrunk connective tissue that is unread here', m('font_size', { halfPoints: 18 })),
        ),
      ),
    );
    const analysis = analyzeCard(collectBodyBlocks(doc, 0, doc.content.size));
    expect(analysis.hasPlainUnderline).toBe(false);
    expect(analysis.baseHalfPoints).toBe(22);
    const req = buildCardRequest(analysis);
    expect(req).toContain('SIZE-ENCODED');
    expect(req).toContain('Base size is 11pt');
    expect(req).toContain('Do NOT underline the "small"');
    // The misleading bold-underline fact must NOT appear for a no-underline card.
    expect(req).not.toContain('ALL underlined text is bold');
  });
});

describe('parseFormatResponse', () => {
  const known = new Set(['plain', 'u', 'b+u', 'du']);

  it('parses a mapping and exceptions', () => {
    const { plan, dropped } = parseFormatResponse(
      '{"map":{"b+u":["em"],"du":["u"],"plain":[],"u":["u"]},"exceptions":[{"text":"Empire","format":["i","em"]}]}',
      known,
    );
    expect(dropped).toEqual([]);
    expect(plan.map.get('b+u')).toEqual(['em']);
    expect(plan.map.get('plain')).toEqual([]);
    expect(plan.exceptions).toEqual([{ text: 'Empire', format: ['i', 'em'] }]);
  });

  it('drops unknown signatures and invalid flags without failing the card', () => {
    const { plan, dropped } = parseFormatResponse(
      '{"map":{"b+u":["em"],"bogus":["u"],"du":["underline"]}}',
      known,
    );
    expect(plan.map.size).toBe(1);
    expect(dropped.length).toBe(2);
  });

  // Live failure 2026-06-10: a size-recovery card's single emphasized
  // sentence (em+hl) was bulldozed into the blanket plain→u rule —
  // existing emphasis is canonical user work and must survive blanket
  // remapping. The guard re-adds em (dropping u, which em implies).
  it('hard guard: a plan stripping em from an em signature gets em back', () => {
    const sigs = new Set(['plain', 'hl', 'small', 'em+hl']);
    const { plan, warnings } = parseFormatResponse(
      '{"map":{"plain":["u"],"hl":["u","hl"],"small":[],"em+hl":["u","hl"]}}',
      sigs,
    );
    expect(plan.map.get('em+hl')).toEqual(['em', 'hl']);
    expect(warnings.length).toBe(1);
    // The compliant mappings pass through untouched.
    expect(plan.map.get('hl')).toEqual(['u', 'hl']);
  });

  it('hard guard: em-preserving plans produce no warning', () => {
    const { warnings } = parseFormatResponse(
      '{"map":{"em+hl":["em","hl"]}}',
      new Set(['em+hl']),
    );
    expect(warnings).toEqual([]);
  });

  // Live drop 2026-06-10: the model mirrored the SIGNATURE notation in
  // a target — ["u+hl"] as one compound string — and the whole mapping
  // for b+hl+u was discarded, leaving those runs untouched.
  it('accepts compound "u+hl" targets by splitting on +', () => {
    const { plan, dropped } = parseFormatResponse(
      '{"map":{"b+u":["u"],"plain":[],"u":["u+hl"]},"exceptions":[{"text":"Empire","format":["i+u"]}]}',
      known,
    );
    expect(dropped).toEqual([]);
    expect(plan.map.get('u')).toEqual(['u', 'hl']);
    expect(plan.exceptions[0]!.format).toEqual(['i', 'u']);
  });

  it('throws only when there is no JSON at all', () => {
    expect(() => parseFormatResponse('no json here', known)).toThrow();
  });
});

describe('applyFormatPlan', () => {
  function repairCard(
    doc: import('prosemirror-model').Node,
    json: string,
  ): import('prosemirror-model').Node {
    const blocks = collectBodyBlocks(doc, 0, doc.content.size);
    const analysis = analyzeCard(blocks);
    const { plan } = parseFormatResponse(json, new Set(analysis.signatures.keys()));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    applyFormatPlan(tr, analysis, plan);
    return state.apply(tr).doc;
  }

  it('b+u → em: bold and underline replaced by the emphasis mark', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('lead ', m('underline_mark')),
          t('standout', m('bold'), m('underline_mark')),
          t(' tail', m('underline_mark')),
        ),
      ),
    );
    const next = repairCard(doc, '{"map":{"b+u":["em"],"u":["u"]}}');
    expect(marksAt(next, 'standout')).toEqual(['emphasis_mark']);
    expect(marksAt(next, 'lead')).toEqual(['underline_mark']);
  });

  it('du → u: direct underlining becomes the named style', () => {
    const doc = makeDoc(card(tag('TAG'), body(t('directly underlined', m('underline_direct')))));
    const next = repairCard(doc, '{"map":{"du":["u"]}}');
    expect(marksAt(next, 'directly underlined')).toEqual(['underline_mark']);
  });

  it('case 4: plain → u, small stays plain; font sizes untouched', () => {
    const small = () => m('font_size', { halfPoints: 16 });
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(t('shrunk connective ', small()), t('this was underlined'), t(' more shrunk', small())),
      ),
    );
    const next = repairCard(doc, '{"map":{"plain":["u"],"small":[]}}');
    expect(marksAt(next, 'this was underlined')).toEqual(['underline_mark']);
    expect(marksAt(next, 'shrunk connective')).toEqual(['font_size']);
  });

  it('preserves the original highlight color when the target keeps hl', () => {
    const doc = makeDoc(
      card(tag('TAG'), body(t('spoken words', m('highlight', { color: 'green' })))),
    );
    const next = repairCard(doc, '{"map":{"hl":["u","hl"]}}');
    let color = '';
    next.descendants((node) => {
      if (node.isText && node.text === 'spoken words') {
        const hl = node.marks.find((mk) => mk.type.name === 'highlight');
        color = String(hl?.attrs['color']);
      }
      return true;
    });
    expect(marksAt(next, 'spoken words')).toEqual(['highlight', 'underline_mark']);
    expect(color).toBe('green');
  });

  it('identity mappings touch nothing (transaction stays empty)', () => {
    const doc = makeDoc(card(tag('TAG'), body(t('already good', m('underline_mark')))));
    const blocks = collectBodyBlocks(doc, 0, doc.content.size);
    const analysis = analyzeCard(blocks);
    const { plan } = parseFormatResponse('{"map":{"u":["u"]}}', new Set(analysis.signatures.keys()));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const touched = applyFormatPlan(tr, analysis, plan);
    expect(touched.length).toBe(0);
    expect(tr.docChanged).toBe(false);
  });

  it('exceptions override the blanket rule for verbatim fragments', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('they read ', m('underline_mark')),
          t('Empire', m('italic'), m('underline_mark')),
          t(' and other ', m('underline_mark')),
          t('italicized', m('italic'), m('underline_mark')),
          t(' words', m('underline_mark')),
        ),
      ),
    );
    // Blanket: i+u → em. Exception: the book title keeps its italics.
    const next = repairCard(
      doc,
      '{"map":{"i+u":["em"],"u":["u"]},"exceptions":[{"text":"Empire","format":["i","u"]}]}',
    );
    expect(marksAt(next, 'italicized')).toEqual(['emphasis_mark']);
    expect(marksAt(next, 'Empire')).toEqual(['italic', 'underline_mark']);
  });

  it('cite debris in body text is dropped when mapped away', () => {
    const doc = makeDoc(
      card(tag('TAG'), body(t('normal ', m('cite_mark')), t('text'))),
    );
    const next = repairCard(doc, '{"map":{"cite":[],"plain":[]}}');
    expect(marksAt(next, 'normal')).toEqual([]);
  });
});
