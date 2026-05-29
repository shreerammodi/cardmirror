/**
 * Find / Replace plugin — matching + navigate + replace behavior.
 * UI / floating bar is tested via real-use; the plugin's match
 * scanning and replacement semantics are covered here.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  findReplaceKey,
  findReplacePlugin,
  runReplace,
  runReplaceAll,
} from '../../src/editor/find-replace-plugin.js';

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function freshState(text: string): EditorState {
  return EditorState.create({
    doc: makeDoc([paragraph(text)]),
    schema,
    plugins: [findReplacePlugin()],
  });
}

function setQuery(
  state: EditorState,
  query: string,
  opts: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    sortMode?: 'categorized' | 'uncategorized';
    anchor?: number;
    categoryOrder?: ('heading' | 'tag' | 'cite' | 'other')[];
  } = {},
): EditorState {
  return state.apply(
    state.tr.setMeta(findReplaceKey, {
      type: 'setQuery',
      query,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
      // Tests default to uncategorized sort anchored at position 0 so
      // matches stay in document order (anchor 0 ⇒ every match is
      // "after" the cursor ⇒ pure doc order) — what most expectations
      // assume.
      sortMode: opts.sortMode ?? 'uncategorized',
      anchor: opts.anchor ?? 0,
      categoryOrder: opts.categoryOrder ?? ['heading', 'tag', 'cite', 'other'],
    }),
  );
}

describe('find-replace plugin', () => {
  it('finds every occurrence of a substring', () => {
    const state = setQuery(freshState('hello world hello again hello'), 'hello');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(3);
    expect(s.currentIndex).toBe(0);
  });

  it('case-insensitive by default', () => {
    const state = setQuery(freshState('Hello WORLD hElLo'), 'hello');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(2);
  });

  it('case-sensitive when toggled', () => {
    const state = setQuery(freshState('Hello WORLD hElLo'), 'hello', {
      caseSensitive: true,
    });
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(0);
  });

  it('whole-word excludes substring hits', () => {
    const state = setQuery(freshState('the cat catalog scatter'), 'cat', {
      wholeWord: true,
    });
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(1);
  });

  it('navigate wraps around the ends', () => {
    let state = setQuery(freshState('a a a'), 'a');
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(0);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(1);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    // Three forward hops from index 0 in a list of 3 → wraps back to 0.
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(0);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: -1 }),
    );
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(2);
  });

  it('replace swaps the current match and rescans', () => {
    let state = setQuery(freshState('foo bar foo bar'), 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    const cmd = runReplace('XYZ');
    let next: EditorState | null = null;
    cmd(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.doc.textContent).toBe('XYZ bar foo bar');
    const s = findReplaceKey.getState(state)!;
    // One match left (the second 'foo'); active index advanced to it.
    expect(s.matches.length).toBe(1);
    expect(s.currentIndex).toBe(0);
  });

  it('replace all is correct when matches are sorted out of doc order (categorized)', () => {
    // Five paragraphs each ending in "---1AC". Sort with an anchor
    // between paragraphs 2 and 3 so the document-order-from-cursor rule
    // produces a matches array NOT in doc order: [p3, p4, p5, p1, p2].
    // Replace All with a longer string previously corrupted every
    // match except the last-in-display-order — see the bug fix.
    const doc = makeDoc([
      paragraph('one---1AC'),
      paragraph('two---1AC'),
      paragraph('three---1AC'),
      paragraph('four---1AC'),
      paragraph('five---1AC'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    // Use a categorized sort to verify the array order is what
    // would have triggered the bug. All matches are 'other' here,
    // so the categorized branch falls through to document-order-from-cursor.
    const scout = setQuery(state, '---1AC', { sortMode: 'uncategorized', anchor: 0 });
    const docOrderFroms = findReplaceKey
      .getState(scout)!.matches.map((m) => m.from);
    const anchor = (docOrderFroms[1]! + docOrderFroms[2]!) / 2;
    const armed = setQuery(state, '---1AC', { sortMode: 'categorized', anchor });
    const cmd = runReplaceAll('---Lalala');
    let next: EditorState | null = null;
    cmd(armed, (tr) => { next = armed.apply(tr); });
    expect(next).not.toBeNull();
    // Each paragraph should now end in "---Lalala", with no
    // residual "1AC" suffixes and no truncation of the body text.
    const paragraphs: string[] = [];
    next!.doc.descendants((node) => {
      if (node.type.name === 'paragraph') {
        paragraphs.push(node.textContent);
        return false;
      }
      return true;
    });
    expect(paragraphs).toEqual([
      'one---Lalala',
      'two---Lalala',
      'three---Lalala',
      'four---Lalala',
      'five---Lalala',
    ]);
  });

  it('replace all swaps every match in a single transaction', () => {
    let state = setQuery(freshState('foo bar foo bar foo'), 'foo');
    const cmd = runReplaceAll('Q');
    let next: EditorState | null = null;
    cmd(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.doc.textContent).toBe('Q bar Q bar Q');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(0);
    expect(s.currentIndex).toBe(-1);
  });

  it('scope restricts matches to within the given range', () => {
    // Three paragraphs each containing 'foo'. Scope to just the
    // second paragraph; only that one match should be returned.
    const doc = makeDoc([
      paragraph('foo one'),
      paragraph('foo two'),
      paragraph('foo three'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    // Find the second paragraph's position range.
    let p2From = -1;
    let p2To = -1;
    let pIdx = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') {
        if (pIdx === 1) {
          p2From = pos;
          p2To = pos + node.nodeSize;
        }
        pIdx++;
        return false;
      }
      return true;
    });
    // First scan with no scope to confirm there are 3 hits.
    const unscoped = setQuery(state, 'foo');
    expect(findReplaceKey.getState(unscoped)!.matches.length).toBe(3);
    // Now apply scope and re-query.
    const scoped = unscoped.apply(
      unscoped.tr.setMeta(findReplaceKey, {
        type: 'setScope',
        scope: { from: p2From, to: p2To },
      }),
    );
    const matches = findReplaceKey.getState(scoped)!.matches;
    expect(matches.length).toBe(1);
    expect(matches[0]!.from).toBeGreaterThanOrEqual(p2From);
    expect(matches[0]!.to).toBeLessThanOrEqual(p2To);
  });

  it('scope tracks position shifts when the doc is edited', () => {
    const doc = makeDoc([
      paragraph('one foo'),
      paragraph('two foo'),
      paragraph('three foo'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    // Scope over the second + third paragraphs (skip the first).
    const scoped = state.apply(
      state.tr.setMeta(findReplaceKey, {
        type: 'setScope',
        scope: { from: 9, to: state.doc.content.size },
      }),
    );
    const queried = setQuery(scoped, 'foo');
    const before = findReplaceKey.getState(queried)!;
    expect(before.matches.length).toBe(2);
    const beforeFroms = before.matches.map((m) => m.from);
    // Insert text BEFORE the scope. The scope (and matches) should
    // shift by the insertion's length.
    const inserted = queried.apply(queried.tr.insertText('PRELUDE ', 1));
    const after = findReplaceKey.getState(inserted)!;
    expect(after.scope).not.toBeNull();
    expect(after.scope!.from).toBe(9 + 'PRELUDE '.length);
    expect(after.matches.length).toBe(2);
    for (let i = 0; i < beforeFroms.length; i++) {
      expect(after.matches[i]!.from).toBe(beforeFroms[i]! + 'PRELUDE '.length);
    }
  });

  it('clear resets the state', () => {
    let state = setQuery(freshState('a a a'), 'a');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(3);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'clear' }),
    );
    const s = findReplaceKey.getState(state)!;
    expect(s.query).toBe('');
    expect(s.matches.length).toBe(0);
    expect(s.currentIndex).toBe(-1);
  });

  it('rescans automatically when the doc changes', () => {
    let state = setQuery(freshState('foo bar foo'), 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    // Append " foo" at the end of the paragraph by inserting text.
    const insertAt = state.doc.content.size - 1;
    state = state.apply(state.tr.insertText(' foo', insertAt));
    expect(findReplaceKey.getState(state)!.matches.length).toBe(3);
  });

  it('matches across separate textblocks (one per paragraph)', () => {
    const doc = makeDoc([
      paragraph('hello world'),
      paragraph('again hello'),
      paragraph('no match here'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const next = setQuery(state, 'hello');
    expect(findReplaceKey.getState(next)!.matches.length).toBe(2);
  });
});

describe('find ordering', () => {
  function hat(text: string) {
    return schema.nodes['hat']!.create({ id: null }, schema.text(text));
  }
  function tag(text: string) {
    return schema.nodes['tag']!.create({ id: null }, schema.text(text));
  }
  function citePara(text: string) {
    return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
  }
  function cardBody(text: string) {
    return schema.nodes['card_body']!.create(null, schema.text(text));
  }
  function cardWith(...children: import('prosemirror-model').Node[]) {
    return schema.nodes['card']!.createChecked(null, children);
  }

  it('categorized: heading hits come before tag, cite, and body hits', () => {
    const doc = makeDoc([
      paragraph('foo before card'),
      hat('foo in hat'),
      cardWith(
        tag('foo in tag'),
        citePara('foo in cite'),
        cardBody('foo in body'),
      ),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const next = setQuery(state, 'foo', {
      sortMode: 'categorized',
      anchor: 0,
      categoryOrder: ['heading', 'tag', 'cite', 'other'],
    });
    const cats = findReplaceKey.getState(next)!.matches.map((m) => m.category);
    expect(cats).toEqual(['heading', 'tag', 'cite', 'other', 'other']);
  });

  it('uncategorized: document order from the cursor, wrapping to the top', () => {
    // 5 matches in order: 'foo' at positions p1 < p2 < p3 < p4 < p5.
    // With anchor between p2 and p3, the result order runs top-to-bottom
    // from the cursor — p3, p4, p5 (after-anchor, doc order) — then wraps
    // to the top — p1, p2 (before-anchor, doc order). NOT closest-first.
    const doc = makeDoc([
      paragraph('foo one'),
      paragraph('foo two'),
      paragraph('foo three'),
      paragraph('foo four'),
      paragraph('foo five'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    // Scan anchored at 0 so every match is "after" → raw doc-order froms.
    const scout = setQuery(state, 'foo', { sortMode: 'uncategorized', anchor: 0 });
    const docOrderFroms = findReplaceKey.getState(scout)!.matches.map((m) => m.from);
    // Anchor between match 2 and match 3.
    const anchor = (docOrderFroms[1]! + docOrderFroms[2]!) / 2;
    const next = setQuery(state, 'foo', { sortMode: 'uncategorized', anchor });
    const orderedFroms = findReplaceKey.getState(next)!.matches.map((m) => m.from);
    // After-anchor in doc order (m3, m4, m5), then wrap to the top in
    // doc order (m1, m2).
    expect(orderedFroms).toEqual([
      docOrderFroms[2],
      docOrderFroms[3],
      docOrderFroms[4],
      docOrderFroms[0],
      docOrderFroms[1],
    ]);
  });

  it('categorized: within a category, ranking falls back to document order from the cursor', () => {
    // Two paragraphs both 'other'. Anchor at the SECOND one → it's the
    // first match at/after the cursor, so it leads the 'other' bucket;
    // the first match wraps to after it.
    const doc = makeDoc([
      paragraph('foo one'),
      paragraph('foo two'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const scout = setQuery(state, 'foo', { sortMode: 'uncategorized', anchor: 0 });
    const fromsDocOrder = findReplaceKey.getState(scout)!.matches.map((m) => m.from);
    const anchor = fromsDocOrder[1]!;
    const next = setQuery(state, 'foo', {
      sortMode: 'categorized',
      anchor,
      categoryOrder: ['heading', 'tag', 'cite', 'other'],
    });
    const orderedFroms = findReplaceKey.getState(next)!.matches.map((m) => m.from);
    // The match AT or AFTER the anchor (the second one) ranks first.
    expect(orderedFroms[0]).toBe(fromsDocOrder[1]);
    expect(orderedFroms[1]).toBe(fromsDocOrder[0]);
  });

  it('categorized: within cite, cite-marked text outranks unmarked text in a cite_paragraph', () => {
    const citeMarkType = schema.marks['cite_mark']!;
    const citeMark = citeMarkType.create();
    // Two cite paragraphs both containing 'foo'. The SECOND one has
    // cite_mark applied to the 'foo' run. Even though it's later in
    // doc order, it should rank above the first when sorted
    // categorized — the cite-mark sub-priority wins before
    // document order.
    const doc = makeDoc([
      schema.nodes['cite_paragraph']!.create(
        null,
        schema.text('foo plain in cite paragraph'),
      ),
      schema.nodes['cite_paragraph']!.create(
        null,
        schema.nodes['cite_paragraph']!
          .createAndFill()!
          .type.create(null, [
            schema.text('foo', [citeMark]),
            schema.text(' marked in cite paragraph'),
          ]).content,
      ),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const next = setQuery(state, 'foo', {
      sortMode: 'categorized',
      anchor: 0,
      categoryOrder: ['heading', 'tag', 'cite', 'other'],
    });
    const matches = findReplaceKey.getState(next)!.matches;
    expect(matches.length).toBe(2);
    // Both are cite category; the cite-marked one (subcategory 0)
    // comes before the plain one (subcategory 1).
    expect(matches.map((m) => m.category)).toEqual(['cite', 'cite']);
    expect(matches.map((m) => m.subcategory)).toEqual([0, 1]);
  });

  it('categorized: user-defined order reshuffles categories', () => {
    const doc = makeDoc([
      hat('foo in hat'),
      cardWith(tag('foo in tag')),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const next = setQuery(state, 'foo', {
      sortMode: 'categorized',
      anchor: 0,
      categoryOrder: ['tag', 'heading', 'cite', 'other'],
    });
    const cats = findReplaceKey.getState(next)!.matches.map((m) => m.category);
    expect(cats).toEqual(['tag', 'heading']);
  });
});
