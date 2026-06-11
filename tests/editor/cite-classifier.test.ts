/**
 * Cite classifier plugin — promotes card_body/paragraph nodes to
 * cite_paragraph when their content is all cite-marked.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { citeClassifierPlugin } from '../../src/editor/cite-classifier-plugin.js';

function cited(text: string) {
  return schema.text(text, [schema.marks['cite_mark']!.create()]);
}
function plain(text: string) {
  return schema.text(text);
}
function tagNode(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function cardWith(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function bodyOf(...inlines: import('prosemirror-model').Node[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function paragraphOf(...inlines: import('prosemirror-model').Node[]) {
  return schema.nodes['paragraph']!.create(null, inlines);
}
function citeParaOf(...inlines: import('prosemirror-model').Node[]) {
  return schema.nodes['cite_paragraph']!.create(null, inlines);
}

/**
 * Apply the classifier to a doc by dispatching a doc-changing transaction
 * that replaces the doc content with itself. state.apply runs the
 * plugin's appendTransaction iteratively, so the result reflects all
 * promotions.
 */
function withPlugin(doc: import('prosemirror-model').Node): import('prosemirror-model').Node {
  const state = EditorState.create({ doc, plugins: [citeClassifierPlugin] });
  const tr = state.tr.replaceWith(0, doc.content.size, doc.content);
  return state.apply(tr).doc;
}

function makeDoc(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

describe('cite classifier plugin', () => {
  it('promotes a card_body whose content is all cite-marked', () => {
    const doc = makeDoc(
      cardWith(
        tagNode('T'),
        bodyOf(cited('Author 2024, Source')),
      ),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph']);
  });

  it('promotes a mixed card_body that contains ANY cite_mark', () => {
    const doc = makeDoc(
      cardWith(
        tagNode('T'),
        bodyOf(cited('Author 2024'), plain(' some body text')),
      ),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('cite_paragraph');
  });

  it('does NOT promote an empty card_body', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), bodyOf()),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('card_body');
  });

  it('does NOT promote a card_body with only plain text', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), bodyOf(plain('plain body text'))),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('card_body');
  });

  it('promotes a doc-level paragraph that contains any cite_mark', () => {
    const doc = makeDoc(paragraphOf(cited('Standalone cite')));
    const result = withPlugin(doc);
    expect(result.firstChild!.type.name).toBe('cite_paragraph');
  });

  it('demotes a cite_paragraph in a card with no cite_mark → card_body', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), citeParaOf(plain('post-split, no cite'))),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('card_body');
  });

  it('demotes an empty cite_paragraph in a card → card_body', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), schema.nodes['cite_paragraph']!.create(null, [])),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('card_body');
  });

  it('demotes a doc-level cite_paragraph with no cite_mark → paragraph', () => {
    const doc = makeDoc(citeParaOf(plain('orphan plain text')));
    const result = withPlugin(doc);
    expect(result.firstChild!.type.name).toBe('paragraph');
  });

  it('leaves a cite_paragraph with cite_mark alone', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), citeParaOf(cited('Already cite'))),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    expect(card.child(1).type.name).toBe('cite_paragraph');
  });

  // Cut docs carry the cite character style on shrunk inter-word
  // SPACES deep into body text — debris, not a cite line. A real case
  // (burgum 18, 2026-06-10) had 55 cite-marked 8pt spaces keeping a
  // body paragraph classified cite, which made shrink refuse it.
  it('ignores whitespace-only cite runs: body with cite-marked spaces stays card_body', () => {
    const doc = makeDoc(
      cardWith(
        tagNode('T'),
        bodyOf(plain('underlined warrant'), cited(' '), plain('more text')),
      ),
    );
    const result = withPlugin(doc);
    expect(result.firstChild!.child(1).type.name).toBe('card_body');
  });

  it('demotes a cite_paragraph whose only cite runs are whitespace', () => {
    const doc = makeDoc(
      cardWith(
        tagNode('T'),
        citeParaOf(plain('body text'), cited(' '), plain('continues')),
      ),
    );
    const result = withPlugin(doc);
    expect(result.firstChild!.child(1).type.name).toBe('card_body');
  });

  it('classifies multiple bodies in a card independently', () => {
    const doc = makeDoc(
      cardWith(
        tagNode('T'),
        bodyOf(cited('Cite 1')),
        bodyOf(plain('Plain body')),
        bodyOf(cited('Cite 2')),
      ),
    );
    const result = withPlugin(doc);
    const card = result.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'card_body', 'cite_paragraph']);
  });

  it('does not loop: re-running on the result yields the same doc', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), bodyOf(cited('Cite'))),
    );
    const once = withPlugin(doc);
    const twice = withPlugin(once);
    expect(once.eq(twice)).toBe(true);
  });

  // Regression: applying F8 / Apply Cite Style runs `tr.addMark`,
  // whose `AddMarkStep.getMap()` returns `StepMap.empty`. If
  // `changedRange` only looks at step maps, the classifier never
  // sees the mark add and the containing paragraph stays a
  // `paragraph` instead of getting promoted. This breaks downstream
  // features that key off the cite_paragraph type (e.g. Copy Last
  // Cite, which then falls back to an older cite further up the
  // doc).
  it('promotes a paragraph when cite_mark is added via addMark', () => {
    const doc = makeDoc(paragraphOf(plain('Test Cite Flow')));
    const state = EditorState.create({ doc, plugins: [citeClassifierPlugin] });
    // Apply cite_mark to "Cite" (the second word). The paragraph's
    // text starts at pos 1; "Test " is 5 chars, so "Cite" is
    // [6, 10) in doc coordinates.
    const tr = state.tr.addMark(
      6,
      10,
      schema.marks['cite_mark']!.create(),
    );
    const next = state.apply(tr);
    expect(next.doc.firstChild!.type.name).toBe('cite_paragraph');
  });
});

// ---- named-style normalizer ----

import { normalizeUnderlineMarks } from '../../src/editor/named-style-normalizer-plugin.js';

function cited2(text: string) {
  return schema.text(text, [schema.marks['cite_mark']!.create()]);
}
function underlined(text: string) {
  return schema.text(text, [schema.marks['underline_mark']!.create()]);
}
function directUnderlined(text: string) {
  return schema.text(text, [schema.marks['underline_direct']!.create()]);
}
function citedAndUnderlined(text: string) {
  return schema.text(text, [
    schema.marks['cite_mark']!.create(),
    schema.marks['underline_mark']!.create(),
  ]);
}

describe('named-style normalizer', () => {
  it('promotes underline_direct → underline_mark in a body textblock', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), bodyOf(directUnderlined('hello'))),
    );
    const result = normalizeUnderlineMarks(doc);
    const body = result.firstChild!.child(1);
    expect(
      body.firstChild!.marks.some((m) => m.type.name === 'underline_mark'),
    ).toBe(true);
    expect(
      body.firstChild!.marks.some((m) => m.type.name === 'underline_direct'),
    ).toBe(false);
  });

  it('demotes underline_mark → underline_direct in a structural textblock', () => {
    const tag = schema.nodes['tag']!.create({ id: newHeadingId() }, underlined('tag text'));
    const doc = makeDoc(schema.nodes['card']!.createChecked(null, [tag]));
    const result = normalizeUnderlineMarks(doc);
    const tagOut = result.firstChild!.firstChild!;
    expect(
      tagOut.firstChild!.marks.some((m) => m.type.name === 'underline_direct'),
    ).toBe(true);
    expect(
      tagOut.firstChild!.marks.some((m) => m.type.name === 'underline_mark'),
    ).toBe(false);
  });

  it('cite_mark + underline_mark in body: cite wins, underline dropped', () => {
    const doc = makeDoc(
      cardWith(tagNode('T'), bodyOf(citedAndUnderlined('Author 24'))),
    );
    const result = normalizeUnderlineMarks(doc);
    const body = result.firstChild!.child(1);
    const text = body.firstChild!;
    expect(text.marks.some((m) => m.type.name === 'cite_mark')).toBe(true);
    expect(text.marks.some((m) => m.type.name === 'underline_mark')).toBe(false);
    expect(text.marks.some((m) => m.type.name === 'underline_direct')).toBe(false);
  });

  it('cite_mark + underline_direct in body: cite wins, direct underline dropped', () => {
    const mixed = schema.text('mixed', [
      schema.marks['cite_mark']!.create(),
      schema.marks['underline_direct']!.create(),
    ]);
    const doc = makeDoc(cardWith(tagNode('T'), bodyOf(mixed)));
    const result = normalizeUnderlineMarks(doc);
    const text = result.firstChild!.child(1).firstChild!;
    expect(text.marks.some((m) => m.type.name === 'cite_mark')).toBe(true);
    expect(text.marks.some((m) => m.type.name === 'underline_direct')).toBe(false);
  });
});

// ---- schema excludes (mutual exclusion on add) ----

describe('mutual exclusion of named-style marks via schema excludes', () => {
  it('adding underline_mark via tr.addMark strips cite_mark in the same range', async () => {
    const { EditorState: ES } = await import('prosemirror-state');
    const doc = makeDoc(cardWith(tagNode('T'), bodyOf(cited2('Author 24'))));
    const state = ES.create({ doc });
    const start = -1;
    let from = -1;
    let to = -1;
    state.doc.descendants((n, p) => {
      if (n.isText && n.text === 'Author 24') {
        from = p;
        to = p + n.nodeSize;
      }
    });
    void start;
    const tr = state.tr.addMark(from, to, schema.marks['underline_mark']!.create());
    const next = state.apply(tr);
    const text = next.doc.firstChild!.child(1).firstChild!;
    expect(text.marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
    // cite stripped because underline_mark.excludes includes cite_mark.
    expect(text.marks.some((m) => m.type.name === 'cite_mark')).toBe(false);
  });
});
