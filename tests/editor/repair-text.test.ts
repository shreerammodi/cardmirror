import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  parseRepairResponse,
  flattenSelection,
  locateFixes,
  buildRepairTransaction,
} from '../../src/editor/ai/repair-text.js';

function tag(text: string) { return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)); }
function cardBody(text: string) { return schema.nodes['card_body']!.create(null, text ? schema.text(text) : []); }
function card(...c: any[]) { return schema.nodes['card']!.createChecked(null, c); }
function makeDoc(...c: any[]) { return schema.nodes['doc']!.createChecked(null, c); }
function para(text: string) { return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []); }

function bodyTexts(doc: any): string[] {
  const out: string[] = [];
  doc.descendants((n: any) => { if (n.isTextblock) out.push(n.textContent); return true; });
  return out;
}

// Apply fixes end to end against a doc with a full-document selection.
function repair(doc: any, fixes: { find: string; replace: string }[]) {
  const state = EditorState.create({ doc });
  const flat = flattenSelection(state.doc, 0, state.doc.content.size);
  const { located, skipped } = locateFixes(flat, fixes);
  const { tr } = buildRepairTransaction(state, located);
  return { next: state.apply(tr), applied: located.length, skipped, flat };
}

describe('parseRepairResponse', () => {
  it('parses a plain JSON object', () => {
    const out = parseRepairResponse('{"fixes":[{"find":"thisis","replace":"this is"}]}');
    expect(out).toEqual([{ find: 'thisis', replace: 'this is' }]);
  });
  it('tolerates code fences and prose around the JSON', () => {
    const out = parseRepairResponse('Here you go:\n```json\n{"fixes":[{"find":"rn","replace":"m"}]}\n```');
    expect(out).toEqual([{ find: 'rn', replace: 'm' }]);
  });
  it('returns [] for an empty fix list', () => {
    expect(parseRepairResponse('{"fixes":[]}')).toEqual([]);
  });
  it('drops malformed / no-op entries', () => {
    const out = parseRepairResponse('{"fixes":[{"find":"a","replace":"b"},{"find":"x"},{"find":"y","replace":"y"}]}');
    expect(out).toEqual([{ find: 'a', replace: 'b' }]);
  });
  it('throws when there is no JSON object', () => {
    expect(() => parseRepairResponse('sorry, no errors')).toThrow();
  });
});

describe('flattenSelection', () => {
  it('joins text within a block and inserts \\n between blocks', () => {
    const doc = makeDoc(card(tag('TAG'), cardBody('alpha'), cardBody('beta')));
    const flat = flattenSelection(doc, 0, doc.content.size);
    expect(flat.text).toBe('TAG\nalpha\nbeta');
    // pos is monotonic and one entry per char.
    expect(flat.pos.length).toBe(flat.text.length);
  });
});

// ---- "could not place suggested fixes" repro (2026-06-10) ----
//
// Live runs on formatted cards frequently skip fixes. These tests
// reproduce the failure classes with the real pipeline. Marks
// themselves are INNOCENT (first test); the failures are inline
// pilcrow glyphs and smart punctuation the model fails to echo
// verbatim, overlapping context windows, and a flatten bug with
// shared node references. Tests assert CURRENT behavior — the
// failing classes are pinned as skips until the locator is fixed.

const mk = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
const run = (text: string, ...marks: ReturnType<typeof mk>[]) => schema.text(text, marks);

/** A realistic condensed cut card body: 8pt cite-marked connective
 *  text, underlined/highlighted fragments, an inline pilcrow, and
 *  smart punctuation — the shape imported formatted cards take. */
function formattedBody() {
  return schema.nodes['card_body']!.create(null, [
    run('Much of ', mk('cite_mark'), mk('font_size', { halfPoints: 16 })),
    run('the critique—which I’ve brought', mk('underline_mark')),
    run('¶', mk('pilcrow_marker')),
    run('to “Occupy” London', mk('underline_mark'), mk('highlight', { color: 'yellow' })),
    run(' suggests thisis a problern', mk('cite_mark'), mk('font_size', { halfPoints: 16 })),
  ]);
}

describe('placement on formatted cards (failure repro)', () => {
  it('marks do NOT break placement: a verbatim find spanning many styled runs places', () => {
    const doc = makeDoc(card(tag('TAG'), formattedBody()));
    const flat = flattenSelection(doc, 0, doc.content.size);
    // The flat text is mark-transparent — styled runs join seamlessly.
    expect(flat.text).toBe(
      'TAG\nMuch of the critique—which I’ve brought¶to “Occupy” London suggests thisis a problern',
    );
    const { located, skipped } = locateFixes(flat, [
      { find: 'thisis a problern', replace: 'this is a problem' },
    ]);
    expect(located.length).toBe(1);
    expect(skipped).toBe(0);
  });

  it('FAILS: model omits the inline pilcrow from its find (condensed cards)', () => {
    const doc = makeDoc(card(tag('TAG'), formattedBody()));
    const flat = flattenSelection(doc, 0, doc.content.size);
    // The doc has "brought¶to"; a model reading the ¶ as noise echoes
    // "broughtto" — verbatim search misses.
    const { located, skipped } = locateFixes(flat, [
      { find: 'broughtto', replace: 'brought to' },
    ]);
    expect(located.length).toBe(0); // pinned current behavior
    expect(skipped).toBe(1);
  });

  it('FAILS: model normalizes smart punctuation in its find', () => {
    const doc = makeDoc(card(tag('TAG'), formattedBody()));
    const flat = flattenSelection(doc, 0, doc.content.size);
    const { located, skipped, notFound } = locateFixes(flat, [
      // doc has — and ’ ; model echoes -- and '
      { find: "critique--which I've brought", replace: "critique—which I've brought it" },
      // doc has “ ” ; model echoes " "
      { find: 'to "Occupy" London', replace: 'to "Occupy" London town' },
    ]);
    expect(located.length).toBe(0); // pinned current behavior
    expect(skipped).toBe(2);
    expect(notFound.length).toBe(2);
  });

  it('FAILS: overlapping context windows drop the second fix', () => {
    const doc = makeDoc(card(tag('TAG'), formattedBody()));
    const flat = flattenSelection(doc, 0, doc.content.size);
    const { located, skipped, overlapped } = locateFixes(flat, [
      { find: 'suggests thisis a', replace: 'suggests this is a' },
      { find: 'thisis a problern', replace: 'thisis a problem' },
    ]);
    expect(located.length).toBe(1); // pinned current behavior
    expect(skipped).toBe(1);
    expect(overlapped.length).toBe(1);
  });

  it('FAILS: shared node references suppress the block-boundary newline', () => {
    // ProseMirror copy/paste reuses node objects — a duplicated
    // paragraph appears twice as the SAME node, so the parent-identity
    // boundary check misses and two blocks flatten run-together. The
    // model then sees (and "fixes") phantom joined words at boundaries.
    const shared = para('same text.');
    const doc = makeDoc(shared, shared, para('tail'));
    const flat = flattenSelection(doc, 0, doc.content.size);
    expect(flat.text).toBe('same text.same text.\ntail'); // pinned: missing \n
  });
});

describe('repair application', () => {
  it('fixes a run-together word within one block', () => {
    const doc = makeDoc(card(tag('TAG'), cardBody('the catsat on it')));
    const { next, applied } = repair(doc, [{ find: 'catsat', replace: 'cat sat' }]);
    expect(applied).toBe(1);
    expect(bodyTexts(next.doc)).toContain('the cat sat on it');
  });

  it('joins a hyphenation split across a block boundary', () => {
    // "re-" ends one body, "search" starts the next.
    const doc = makeDoc(card(tag('TAG'), cardBody('we did re-'), cardBody('search on it')));
    const { next, applied, flat } = repair(doc, [{ find: 're-\nsearch', replace: 'research' }]);
    expect(flat.text).toBe('TAG\nwe did re-\nsearch on it');
    expect(applied).toBe(1);
    // The two bodies join into one with the word repaired.
    const bodies = bodyTexts(next.doc).filter((t) => t !== 'TAG');
    expect(bodies).toEqual(['we did research on it']);
  });

  it('applies the same fix at multiple occurrences in reading order', () => {
    const doc = makeDoc(para('modern and modern'));
    // OCR turned both "m" into "rn": "rnodern" — fix each occurrence.
    const garbled = makeDoc(para('rnodern and rnodern'));
    const { next, applied } = repair(garbled, [
      { find: 'rnodern', replace: 'modern' },
      { find: 'rnodern', replace: 'modern' },
    ]);
    expect(applied).toBe(2);
    expect(bodyTexts(next.doc)).toEqual(['modern and modern']);
    void doc;
  });

  it('counts fixes it cannot place', () => {
    const doc = makeDoc(para('clean text'));
    const { applied, skipped } = repair(doc, [{ find: 'notpresent', replace: 'x' }]);
    expect(applied).toBe(0);
    expect(skipped).toBe(1);
  });

  it('leaves the document unchanged when there are no fixes', () => {
    const doc = makeDoc(para('nothing to do'));
    const { next, applied } = repair(doc, []);
    expect(applied).toBe(0);
    expect(bodyTexts(next.doc)).toEqual(['nothing to do']);
  });
});
