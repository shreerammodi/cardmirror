/**
 * Select Similar Formatting — matching-function tests.
 *
 * The plugin's apply / decorations work happens against a live PM
 * view and is tricky to drive in vitest, so we test the pure
 * matching function (`computeSimilarMatches`) directly. That's the
 * core of the feature; the plugin is a thin wrapper around it.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  computeSimilarMatches,
  computeStyleMatches,
  selectAllOfStyle,
  buildSimilarSelectionPlugin,
  selectSimilar,
  getSimilarSelectionState,
  type EffectivePtResolver,
} from '../../src/editor/similar-selection-plugin.js';
import { applyHighlight } from '../../src/editor/ribbon-commands.js';

/**
 * Test-side effective-pt resolver. Mirrors the production
 * `effectivePtForNode` in `index.ts` but with hardcoded defaults so
 * the test doesn't depend on the live settings store. Order: explicit
 * `font_size` mark > named-style mark default > paragraph-type
 * default > normal (11pt).
 */
const TEST_DEFAULTS = {
  normal: 11,
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  cite: 13,
  underline: 11,
  emphasis: 11,
  undertag: 12,
} as const;

const effectivePt: EffectivePtResolver = (node, parent) => {
  if (!node || !node.isText) return paragraphDefault(parent);
  const fs = node.marks.find((m) => m.type.name === 'font_size');
  if (fs) return Number(fs.attrs['halfPoints'] ?? 22) / 2;
  for (const m of node.marks) {
    switch (m.type.name) {
      case 'cite_mark': return TEST_DEFAULTS.cite;
      case 'underline_mark': return TEST_DEFAULTS.underline;
      case 'emphasis_mark': return TEST_DEFAULTS.emphasis;
      case 'undertag_mark': return TEST_DEFAULTS.undertag;
      case 'analytic_mark': return TEST_DEFAULTS.analytic;
    }
  }
  return paragraphDefault(parent);
};

function paragraphDefault(parent: PMNode): number {
  switch (parent.type.name) {
    case 'pocket': return TEST_DEFAULTS.pocket;
    case 'hat': return TEST_DEFAULTS.hat;
    case 'block': return TEST_DEFAULTS.block;
    case 'tag': return TEST_DEFAULTS.tag;
    case 'analytic': return TEST_DEFAULTS.analytic;
    case 'undertag': return TEST_DEFAULTS.undertag;
    default: return TEST_DEFAULTS.normal;
  }
}

function tag(
  text: string,
  marks: ReturnType<typeof schema.marks['bold']['create']>[] = [],
  id = newHeadingId(),
) {
  return schema.nodes['tag']!.create({ id }, schema.text(text, marks));
}
function cardBody(text: string, marks: ReturnType<typeof schema.marks['bold']['create']>[] = []) {
  return schema.nodes['card_body']!.create(
    null,
    schema.text(text, marks),
  );
}
function card(...children: ReturnType<typeof tag>[]) {
  return schema.nodes['card']!.create(null, children);
}
function docOf(...children: ReturnType<typeof card>[]) {
  return schema.nodes['doc']!.create(null, children);
}

const bold = () => schema.marks['bold']!.create();
const italic = () => schema.marks['italic']!.create();
const fs = (halfPoints: number) =>
  schema.marks['font_size']!.create({ halfPoints });

describe('computeSimilarMatches', () => {
  it('matches all tags in the doc when cursor is on a tag (no direct fmt)', () => {
    const doc = docOf(
      card(tag('TagOne'), cardBody('Body A')),
      card(tag('TagTwo'), cardBody('Body B')),
      card(tag('TagThree'), cardBody('Body C')),
    );
    // Cursor inside "TagOne". Doc structure puts tag content at:
    //   doc 0 / card 1 / tag 2 / text starts at 2.
    // Easier: walk to find the first tag's text-start.
    const cursorPos = findTextStart(doc, 'TagOne');
    const matches = computeSimilarMatches(doc, cursorPos, null, effectivePt);
    expect(matches.length).toBe(3);
    expect(textAtRanges(doc, matches).sort()).toEqual([
      'TagOne',
      'TagThree',
      'TagTwo',
    ]);
  });

  it('matches only card_body runs that share the same direct fmt', () => {
    const doc = docOf(
      card(tag('T1'), cardBody('Plain body 1')),
      card(tag('T2'), cardBody('Bold body 2', [bold()])),
      card(tag('T3'), cardBody('Plain body 3')),
    );
    const plainPos = findTextStart(doc, 'Plain body 1');
    const plainMatches = computeSimilarMatches(doc, plainPos, null, effectivePt);
    expect(textAtRanges(doc, plainMatches).sort()).toEqual([
      'Plain body 1',
      'Plain body 3',
    ]);

    const boldPos = findTextStart(doc, 'Bold body 2');
    const boldMatches = computeSimilarMatches(doc, boldPos, null, effectivePt);
    expect(textAtRanges(doc, boldMatches)).toEqual(['Bold body 2']);
  });

  it('treats different mark attrs as distinct fingerprints', () => {
    const doc = docOf(
      card(
        tag('T'),
        cardBody('8pt run', [fs(16)]),
        cardBody('11pt run', [fs(22)]),
        cardBody('Another 8pt', [fs(16)]),
      ),
    );
    const small = findTextStart(doc, '8pt run');
    const smallMatches = computeSimilarMatches(doc, small, null, effectivePt);
    expect(textAtRanges(doc, smallMatches).sort()).toEqual([
      '8pt run',
      'Another 8pt',
    ]);
  });

  it('does not match runs whose parent block type differs', () => {
    const doc = docOf(
      card(
        tag('A tag'),
        cardBody('A tag'), // same text, different parent
      ),
    );
    const tagPos = findTextStart(doc, 'A tag', 0); // first occurrence = the tag
    const matches = computeSimilarMatches(doc, tagPos, null, effectivePt);
    expect(textAtRanges(doc, matches)).toEqual(['A tag']);
  });

  it('respects mark-order differences as not-equal (sanity)', () => {
    // Marks of different types in the same set still hash to the
    // same equality via marksEqual (PM normalizes order). This just
    // confirms the equality check accepts equivalent multi-mark sets.
    const doc = docOf(
      card(
        tag('T'),
        cardBody('bold-italic', [bold(), italic()]),
        cardBody('italic-bold', [italic(), bold()]),
      ),
    );
    const pos = findTextStart(doc, 'bold-italic');
    const matches = computeSimilarMatches(doc, pos, null, effectivePt);
    // PM normalizes marks: both runs end up with marks in the same
    // order, so they match each other.
    expect(textAtRanges(doc, matches).sort()).toEqual([
      'bold-italic',
      'italic-bold',
    ]);
  });

  it('restricts matching to the provided scope range', () => {
    const doc = docOf(
      card(tag('Tag1'), cardBody('alpha')),
      card(tag('Tag2'), cardBody('beta')),
      card(tag('Tag3'), cardBody('gamma')),
    );
    const cursorPos = findTextStart(doc, 'Tag1');
    // Scope = approximately the first two cards. Find a boundary
    // that includes Tag1+Tag2 but not Tag3.
    const tag3Pos = findTextStart(doc, 'Tag3');
    const matches = computeSimilarMatches(
      doc,
      cursorPos,
      { from: 0, to: tag3Pos - 1 }, // before Tag3's container
      effectivePt,
    );
    const found = textAtRanges(doc, matches).sort();
    expect(found).toContain('Tag1');
    expect(found).toContain('Tag2');
    expect(found).not.toContain('Tag3');
  });

  it('returns empty when the cursor is on an empty paragraph', () => {
    const doc = docOf(
      card(tag('Tag'), cardBody('body')),
    );
    // Position 0 is the doc start — not inside any textblock.
    expect(computeSimilarMatches(doc, 0, null, effectivePt)).toEqual([]);
  });

  // Chip-resolved font-size: cursor on a bare tag run resolves to
  // 13pt (the tag style default). Another tag run with an explicit
  // `font_size: 26` (halfPoints, = 13pt) reads visually identical in
  // the chip and should match — even though one mark set is empty
  // and the other has a font_size mark. A tag run at 26pt (=fs(52))
  // should NOT match. A card_body run at 13pt (different parent
  // type) should NOT match either.
  it('matches by effective (chip-resolved) font size, not raw font_size mark', () => {
    const doc = docOf(
      card(tag('Bare tag run'), cardBody('Body 13pt', [fs(26)])),       // 13pt tag, 13pt body (wrong parent)
      card(tag('Equal-with-explicit', [fs(26)])),                       // 13pt tag — explicit but equal → match
      card(tag('Another bare tag')),                                    // 13pt tag → match
      card(tag('Big tag', [fs(52)])),                                   // 26pt tag → no match
    );
    const cursorPos = findTextStart(doc, 'Bare tag run');
    const matches = computeSimilarMatches(doc, cursorPos, null, effectivePt);
    const found = textAtRanges(doc, matches).sort();
    expect(found).toEqual([
      'Another bare tag',
      'Bare tag run',
      'Equal-with-explicit',
    ]);
  });

  it('matches bare run with explicit-but-equal font_size when chip pt matches', () => {
    // Two card_body runs that read 11pt in the chip: one is bare
    // (inherits Normal=11), one has explicit font_size: 22 (=11pt).
    // They should match each other.
    const doc = docOf(
      card(
        tag('T'),
        cardBody('Bare 11pt'),
        cardBody('Explicit 11pt', [fs(22)]),
        cardBody('Explicit 8pt', [fs(16)]),
      ),
    );
    const cursorPos = findTextStart(doc, 'Bare 11pt');
    const matches = computeSimilarMatches(doc, cursorPos, null, effectivePt);
    const found = textAtRanges(doc, matches).sort();
    expect(found).toEqual(['Bare 11pt', 'Explicit 11pt']);
  });

  it('whitespace-only runs match on marks alone, ignoring size (cut-doc 8pt spaces)', () => {
    // Imported cuts leave 8pt cite-styled SPACES between full-size
    // runs. Size is invisible on a space; requiring effective-pt
    // equality made Select Similar → F12 skip exactly that debris.
    const cite = () => schema.marks['cite_mark']!.create();
    const body = schema.nodes['card_body']!.create(null, [
      schema.text('lead words', [cite()]),
      schema.text(' ', [cite(), fs(16)]),
      schema.text('tail words', [cite()]),
    ]);
    const doc = docOf(card(tag('T'), body));
    const cursorPos = findTextStart(doc, 'lead words');
    const matches = computeSimilarMatches(doc, cursorPos, null, effectivePt);
    expect(textAtRanges(doc, matches)).toEqual(['lead words', ' ', 'tail words']);
  });
});

// ---- helpers ----

function findTextStart(
  doc: ReturnType<typeof docOf>,
  needle: string,
  occurrence = 0,
): number {
  let seen = 0;
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (!node.isText) return true;
    if (node.text && node.text.includes(needle)) {
      if (seen === occurrence) {
        found = pos + node.text.indexOf(needle) + 1; // inside the text
        return false;
      }
      seen += 1;
    }
    return true;
  });
  if (found === -1) throw new Error(`needle not found: ${needle}`);
  return found;
}

function textAtRanges(
  doc: ReturnType<typeof docOf>,
  ranges: { from: number; to: number }[],
): string[] {
  return ranges.map((r) => doc.textBetween(r.from, r.to));
}

// ---- Unified Select Similar command + shadow-aware format commands ----

describe('selectSimilar (unified command)', () => {
  it('with no selection, lights up matches doc-wide and renders decorations', () => {
    const doc = docOf(
      card(tag('TagA'), cardBody('aa')),
      card(tag('TagB'), cardBody('bb')),
    );
    const state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    const tagAStart = findTextStart(state.doc, 'TagA');
    const positioned = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, tagAStart)),
    );
    let next: EditorState | null = null;
    selectSimilar(effectivePt)(positioned, (tr) => { next = positioned.apply(tr); });
    const ps = getSimilarSelectionState(next!);
    expect(ps.mode).toBe('idle');
    expect(ps.matches.length).toBeGreaterThan(0);
    expect(ps.scope).toBeNull();
  });

  it('with a non-empty selection, sets the scope and collapses the PM selection', () => {
    const doc = docOf(
      card(tag('TagA'), cardBody('aa')),
      card(tag('TagB'), cardBody('bb')),
    );
    const state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    const tagAStart = findTextStart(state.doc, 'TagA');
    const tagAEnd = tagAStart + 'TagA'.length;
    const withSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, tagAStart, tagAEnd)),
    );
    let next: EditorState | null = null;
    selectSimilar(effectivePt)(withSel, (tr) => { next = withSel.apply(tr); });
    const ps = getSimilarSelectionState(next!);
    expect(ps.mode).toBe('awaiting-cursor');
    expect(ps.scope).not.toBeNull();
    // PM selection should be collapsed (so the orange tint isn't hidden).
    expect(next!.selection.empty).toBe(true);
  });

  // Scoped flow lets the user fix multiple formats in the same
  // span without redrawing the selection: after matches are
  // computed, clicking elsewhere INSIDE the original scope but on
  // a run with different formatting should re-fingerprint and
  // swap matches, not clear the shadow. A click OUTSIDE the
  // scope still clears as before.
  it('after scoped match, clicking on a different format inside the scope re-fingerprints', () => {
    const doc = docOf(
      card(
        tag('Tag'),
        cardBody('plain alpha'),
        cardBody('bold beta', [bold()]),
        cardBody('plain gamma'),
      ),
      card(tag('OutOfScope'), cardBody('out plain')),
    );
    let s = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    // Scope = the first card's three card_body lines. `findTextStart`
    // returns a position inside the run (after the first char), so
    // back off by 1 on the start side to include the full "plain
    // alpha" run rather than clipping its first character.
    const alphaStart = findTextStart(s.doc, 'plain alpha');
    const gammaEnd = findTextStart(s.doc, 'plain gamma') + 'plain gamma'.length;
    s = s.apply(
      s.tr.setSelection(
        TextSelection.create(s.doc, alphaStart - 1, gammaEnd),
      ),
    );
    selectSimilar(effectivePt)(s, (tr) => { s = s.apply(tr); });
    expect(getSimilarSelectionState(s).mode).toBe('awaiting-cursor');

    // Click on "plain alpha" → matches the two plain runs.
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, alphaStart + 2)));
    let ps = getSimilarSelectionState(s);
    expect(ps.mode).toBe('idle');
    expect(textAtRanges(s.doc, ps.matches).sort()).toEqual([
      'plain alpha',
      'plain gamma',
    ]);
    expect(ps.scope).not.toBeNull();

    // Click on "bold beta" — same scope, different fingerprint.
    // Should re-match to just the bold run, scope preserved.
    const betaPos = findTextStart(s.doc, 'bold beta') + 2;
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, betaPos)));
    ps = getSimilarSelectionState(s);
    expect(textAtRanges(s.doc, ps.matches)).toEqual(['bold beta']);
    expect(ps.scope).not.toBeNull();

    // Click OUTSIDE the scope → dismiss.
    const outPos = findTextStart(s.doc, 'out plain') + 2;
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, outPos)));
    ps = getSimilarSelectionState(s);
    expect(ps.matches).toHaveLength(0);
    expect(ps.scope).toBeNull();
  });

  it('re-invocation while in awaiting-cursor mode toggles off', () => {
    const doc = docOf(card(tag('Tag'), cardBody('body')));
    const state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    // Set scope via the command with a non-empty selection.
    const tagStart = findTextStart(state.doc, 'Tag');
    const withSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, tagStart, tagStart + 3)),
    );
    let s = withSel;
    selectSimilar(effectivePt)(s, (tr) => { s = s.apply(tr); });
    expect(getSimilarSelectionState(s).mode).toBe('awaiting-cursor');
    // Re-invoke: should clear back to idle.
    selectSimilar(effectivePt)(s, (tr) => { s = s.apply(tr); });
    const ps = getSimilarSelectionState(s);
    expect(ps.mode).toBe('idle');
    expect(ps.matches).toHaveLength(0);
    expect(ps.scope).toBeNull();
  });
});

describe('format commands consume the shadow selection', () => {
  it('applyHighlight operates across shadow matches when PM selection is collapsed', () => {
    // Two card_body runs that both qualify for select-similar (plain
    // body text, same parent type). Light up matches, then hit
    // applyHighlight — both runs get highlighted in one tr.
    const doc = docOf(
      card(tag('T1'), cardBody('alpha')),
      card(tag('T2'), cardBody('beta')),
    );
    let s = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    const alphaStart = findTextStart(s.doc, 'alpha');
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, alphaStart)));
    // Trigger select similar.
    selectSimilar(effectivePt)(s, (tr) => { s = s.apply(tr); });
    const before = getSimilarSelectionState(s);
    expect(before.matches.length).toBe(2);
    // Apply highlight — should bridge to both matches in one tr.
    applyHighlight(() => 'yellow')(s, (tr) => { s = s.apply(tr); });
    // Both runs should now carry highlight=yellow.
    const hasYellow = (text: string): boolean => {
      let found = false;
      s.doc.descendants((node) => {
        if (found) return false;
        if (!node.isText || node.text !== text) return true;
        found = node.marks.some(
          (m) => m.type.name === 'highlight' && m.attrs['color'] === 'yellow',
        );
        return true;
      });
      return found;
    };
    expect(hasYellow('alpha')).toBe(true);
    expect(hasYellow('beta')).toBe(true);
    // Shadow selection should survive the format apply.
    expect(getSimilarSelectionState(s).matches.length).toBe(2);
  });
});

// ---- Select all of a named style (right-click a ribbon style button) ----

const citeMark = () => schema.marks['cite_mark']!.create();

function pocket(text: string) {
  return schema.nodes['pocket']!.create(
    { id: newHeadingId() },
    text ? schema.text(text) : undefined,
  );
}
function bodyOf(...inline: PMNode[]) {
  return schema.nodes['card_body']!.create(null, inline);
}

describe('computeStyleMatches', () => {
  it('block selector matches every textblock of that type', () => {
    const doc = schema.nodes['doc']!.create(null, [
      pocket('Pocket A'),
      card(tag('Tag 1'), cardBody('body 1')),
      card(tag('Tag 2'), cardBody('body 2')),
      pocket('Pocket B'),
    ]);
    const tags = computeStyleMatches(doc, { kind: 'block', nodeType: 'tag' });
    expect(textAtRanges(doc, tags).sort()).toEqual(['Tag 1', 'Tag 2']);
    const pockets = computeStyleMatches(doc, { kind: 'block', nodeType: 'pocket' });
    expect(textAtRanges(doc, pockets).sort()).toEqual(['Pocket A', 'Pocket B']);
  });

  it('block selector skips empty blocks (no content range)', () => {
    const doc = schema.nodes['doc']!.create(null, [pocket('Has text'), pocket('')]);
    const matches = computeStyleMatches(doc, { kind: 'block', nodeType: 'pocket' });
    expect(textAtRanges(doc, matches)).toEqual(['Has text']);
  });

  it('mark selector matches carrying runs and merges contiguous ones', () => {
    const doc = schema.nodes['doc']!.create(null, [
      card(
        tag('T'),
        bodyOf(
          schema.text('plain '),
          schema.text('cited', [citeMark()]),
          // Contiguous cite run with an extra mark — should merge with
          // the previous cite run into one range, not split it.
          schema.text('part', [citeMark(), bold()]),
          schema.text(' tail'),
        ),
      ),
    ]);
    const matches = computeStyleMatches(doc, { kind: 'mark', markTypes: ['cite_mark'] });
    expect(textAtRanges(doc, matches)).toEqual(['citedpart']);
  });

  it('underline selector matches the named style, not structural direct underline', () => {
    // `underline_mark` is the named "Underline" character style (body);
    // `underline_direct` is the raw underline used inside structural
    // blocks (tags / analytics). "Select all underline" targets only the
    // style, so a directly-underlined tag must not match.
    const doc = schema.nodes['doc']!.create(null, [
      card(
        schema.nodes['tag']!.create(
          { id: newHeadingId() },
          schema.text('tag underline', [schema.marks['underline_direct']!.create()]),
        ),
        bodyOf(schema.text('body underline', [schema.marks['underline_mark']!.create()])),
      ),
    ]);
    const matches = computeStyleMatches(doc, {
      kind: 'mark',
      markTypes: ['underline_mark'],
    });
    expect(textAtRanges(doc, matches)).toEqual(['body underline']);
  });

  it('returns empty when no instance of the style exists', () => {
    const doc = docOf(card(tag('T'), cardBody('b')));
    expect(computeStyleMatches(doc, { kind: 'block', nodeType: 'undertag' })).toEqual([]);
  });

  it('bounds matches to a scope range when given', () => {
    const doc = docOf(
      card(tag('Tag1'), cardBody('a')),
      card(tag('Tag2'), cardBody('b')),
      card(tag('Tag3'), cardBody('c')),
    );
    const tag3 = findTextStart(doc, 'Tag3');
    const scoped = computeStyleMatches(
      doc,
      { kind: 'block', nodeType: 'tag' },
      { from: 0, to: tag3 - 1 }, // before Tag3's container
    );
    const found = textAtRanges(doc, scoped).sort();
    expect(found).toContain('Tag1');
    expect(found).toContain('Tag2');
    expect(found).not.toContain('Tag3');
  });
});

describe('selectAllOfStyle command', () => {
  it('lights up every instance as the shadow selection', () => {
    const doc = schema.nodes['doc']!.create(null, [
      card(tag('Alpha'), cardBody('a')),
      card(tag('Beta'), cardBody('b')),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    let dispatched = false;
    const ok = selectAllOfStyle({ kind: 'block', nodeType: 'tag' })(state, (tr) => {
      state = state.apply(tr);
      dispatched = true;
    });
    expect(ok).toBe(true);
    expect(dispatched).toBe(true);
    expect(textAtRanges(state.doc, getSimilarSelectionState(state).matches).sort()).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('returns false without dispatching when nothing matches', () => {
    const doc = docOf(card(tag('T'), cardBody('b')));
    const state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    let dispatched = false;
    const ok = selectAllOfStyle({ kind: 'block', nodeType: 'undertag' })(state, () => {
      dispatched = true;
    });
    expect(ok).toBe(false);
    expect(dispatched).toBe(false);
  });

  it('bounds to the PM selection and sets the scope tint', () => {
    const doc = docOf(
      card(tag('Alpha'), cardBody('a')),
      card(tag('Beta'), cardBody('b')),
      card(tag('Gamma'), cardBody('c')),
    );
    const gamma = findTextStart(doc, 'Gamma');
    let state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    // Select a region covering Alpha + Beta but not Gamma.
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, 1, gamma - 1),
      ),
    );
    const ok = selectAllOfStyle({ kind: 'block', nodeType: 'tag' })(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ok).toBe(true);
    const ps = getSimilarSelectionState(state);
    expect(ps.scope).not.toBeNull();
    const found = textAtRanges(state.doc, ps.matches).sort();
    expect(found).toContain('Alpha');
    expect(found).toContain('Beta');
    expect(found).not.toContain('Gamma');
    // PM selection collapsed so the shadow drives bulk ops.
    expect(state.selection.empty).toBe(true);
  });

  it('reuses a sticky scope on a later call with no fresh selection', () => {
    const doc = schema.nodes['doc']!.create(null, [
      card(tag('Alpha'), cardBody('cited a', [schema.marks['cite_mark']!.create()])),
      card(tag('Beta'), cardBody('cited b', [schema.marks['cite_mark']!.create()])),
      card(tag('Gamma'), cardBody('cited c', [schema.marks['cite_mark']!.create()])),
    ]);
    const gamma = findTextStart(doc, 'Gamma');
    let state = EditorState.create({
      doc,
      schema,
      plugins: [buildSimilarSelectionPlugin(effectivePt)],
    });
    // First call WITH a selection covering Alpha + Beta sets the scope.
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, gamma - 1)),
    );
    selectAllOfStyle({ kind: 'block', nodeType: 'tag' })(state, (tr) => {
      state = state.apply(tr);
    });
    const scope1 = getSimilarSelectionState(state).scope;
    expect(scope1).not.toBeNull();

    // Second call with NO fresh selection (collapsed) reuses that scope —
    // a different style, still bounded to Alpha + Beta, never Gamma.
    expect(state.selection.empty).toBe(true);
    selectAllOfStyle({ kind: 'mark', markTypes: ['cite_mark'] })(state, (tr) => {
      state = state.apply(tr);
    });
    const ps = getSimilarSelectionState(state);
    expect(ps.scope).toEqual(scope1);
    const found = textAtRanges(state.doc, ps.matches);
    expect(found.join(' ')).toContain('cited a');
    expect(found.join(' ')).toContain('cited b');
    expect(found.join(' ')).not.toContain('cited c');
  });
});
