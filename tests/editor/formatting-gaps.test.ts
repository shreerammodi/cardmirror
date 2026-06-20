/**
 * Auto gap-normalization when applying/removing formatting (withGapFix),
 * plus the manual Fix Formatting Gaps command's underline_direct support.
 *
 * The invariant under test: after a formatting apply, a space carries the
 * style only when the words on BOTH sides of it do — bridging across
 * word-by-word formatting, clearing a dangling style a now-plain word leaves,
 * and leaving alone any gap the user didn't act on (surgical per mark type and
 * per location).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  applyUnderline,
  applyHighlight,
  applyCite,
  applyEmphasis,
  setFontSize,
  fixFormattingGaps,
} from '../../src/editor/ribbon-commands.js';

// ---- builders ----

const U = () => schema.marks['underline_mark']!.create();
const UD = () => schema.marks['underline_direct']!.create();
const HL = (color = 'yellow') => schema.marks['highlight']!.create({ color });
const FS = (pt: number) => schema.marks['font_size']!.create({ halfPoints: pt * 2 });

/** A paragraph from `[text, marks]` runs. */
function para(...runs: [string, Mark[]?][]): PMNode {
  const nodes = runs.map(([t, m]) => schema.text(t, m ?? []));
  return schema.nodes['paragraph']!.create(null, nodes);
}

function docOf(...runs: [string, Mark[]?][]): PMNode {
  return schema.nodes['doc']!.createChecked(null, [para(...runs)]);
}

/** A mask string ('_' where `markName` is present, ' ' otherwise), aligned
 *  under the doc's full text — readable golden for gap assertions. */
function mask(doc: PMNode, markName: string): string {
  let out = '';
  doc.descendants((n) => {
    if (!n.isText || !n.text) return true;
    const has = n.marks.some((m) => m.type.name === markName);
    out += (has ? '_' : ' ').repeat(n.text.length);
    return true;
  });
  return out;
}

function apply(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}

/** Select the first occurrence of `text` in the doc (single-textblock docs:
 *  content starts at doc pos 1). */
function select(state: EditorState, text: string): EditorState {
  const full = state.doc.textContent;
  const i = full.indexOf(text);
  if (i < 0) throw new Error(`"${text}" not found`);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1 + i, 1 + i + text.length)),
  );
}

function run(doc: PMNode, text: string, cmd: Command): EditorState {
  return apply(select(EditorState.create({ doc }), text), cmd);
}

// ---- bridge on apply ----

describe('withGapFix — bridging on apply', () => {
  it('underlining a word between two underlined words joins into one run', () => {
    const doc = docOf(['alpha ', [U()]], ['beta'], [' gamma', [U()]]);
    const next = run(doc, 'beta', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('________________'); // "alpha beta gamma"
  });

  it('highlighting a word between two highlighted words bridges the gaps', () => {
    const doc = docOf(['alpha ', [HL()]], ['beta'], [' gamma', [HL()]]);
    const next = run(doc, 'beta', applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('________________');
  });

  it('does NOT bridge when a neighbor is plain (trailing space stays clean)', () => {
    const doc = docOf(['alpha beta gamma']);
    const next = run(doc, 'beta', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('      ____      ');
  });

  it('bridges underline_direct inside a tag (structural block)', () => {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, [
      schema.text('alpha ', [UD()]),
      schema.text('beta'),
      schema.text(' gamma', [UD()]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [tagNode]),
    ]);
    let state = EditorState.create({ doc });
    let bpos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'beta') bpos = p;
      return true;
    });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, bpos, bpos + 4)),
    );
    const next = apply(state, applyUnderline(() => false));
    expect(mask(next.doc, 'underline_direct')).toBe('________________');
  });
});

// ---- cleanup on toggle-off ----

describe('withGapFix — cleanup on toggle-off', () => {
  it('un-underlining the middle word clears the flanking spaces', () => {
    const doc = docOf(['alpha beta gamma', [U()]]);
    const next = run(doc, 'beta', applyUnderline(() => false));
    // alpha + gamma keep their underline; the two spaces around beta clear.
    expect(mask(next.doc, 'underline_mark')).toBe('_____      _____');
  });

  it('un-highlighting the middle word clears the flanking spaces', () => {
    const doc = docOf(['alpha beta gamma', [HL()]]);
    const next = run(doc, 'beta', applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('_____      _____');
  });
});

// ---- surgical ----

describe('withGapFix — full normalization, local scope', () => {
  it('applying one style also cleans an ADJACENT dangling gap of another style', () => {
    // "aa" + the space after it are highlighted; "bb" is plain (a dangling
    // highlight). Underlining "bb" runs the full gap pass over the area, which
    // also strips that adjacent dangling highlight space.
    const doc = docOf(['aa', [HL()]], [' ', [HL()]], ['bb cc']);
    const next = run(doc, 'bb', applyUnderline(() => false));
    expect(mask(next.doc, 'highlight')).toBe('__      '); // only "aa" left
    expect(mask(next.doc, 'underline_mark')).toBe('   __   '); // "bb"
  });

  it('does NOT touch a gap outside the changed area (local scope)', () => {
    // A dangling highlight far from the edit stays put — the pass only runs
    // around what changed, not the whole paragraph.
    const doc = docOf(['aa', [HL()]], [' ', [HL()]], ['bb cc dd ee ff']);
    const next = run(doc, 'ee', applyUnderline(() => false));
    expect(mask(next.doc, 'highlight')).toBe('___              '); // unchanged
  });

  it('leaves a far gap (neither bookend styled) untouched', () => {
    const doc = docOf(['one two three four']);
    const next = run(doc, 'one', applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('___               ');
  });

  it('an explicitly highlighted space between two plain words is preserved', () => {
    // Neither bookend is styled → not the dangling case → leave it.
    const doc = docOf(['word here']);
    let state = EditorState.create({ doc });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 5, 6)), // the space
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('    _    ');
  });

  it('explicitly highlighting whitespace is honored even when one neighbor is styled', () => {
    // "alpha" highlighted, "beta" plain; the user selects the two spaces
    // between and highlights them. Even though one flank is styled, an
    // explicit whitespace-only apply is respected — not stripped.
    const doc = docOf(['alpha', [HL()]], ['  '], ['beta']);
    let state = EditorState.create({ doc });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6, 8)), // the "  "
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('_______    '); // alpha + 2 spaces
  });

  it('explicitly highlighting punctuation is honored even when one neighbor is styled', () => {
    // Same as the whitespace case, but the selection is pure punctuation.
    // No word character is touched → the user's choice stands.
    const doc = docOf(['alpha', [HL()]], ['...'], ['beta']);
    let state = EditorState.create({ doc });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6, 9)), // the "..."
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('________    '); // alpha + "..."
  });

  it('explicitly highlighting a punctuation+space mix is honored', () => {
    // " -- " is punctuation and whitespace, no word char. Ends in a space
    // so trailing-trim drops it: only " --" carries the highlight, and the
    // gap-fix leaves that explicit choice alone.
    const doc = docOf(['alpha', [HL()]], [' -- '], ['beta']);
    let state = EditorState.create({ doc });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6, 10)), // " -- "
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'highlight')).toBe('________     '); // alpha + " --"
  });

  it('still bridges a punctuation gap when a WORD is formatted (control)', () => {
    // The honoring is only for explicit non-word selections. Underlining a
    // real word next to an underlined neighbor must still bridge the comma
    // gap between them.
    const doc = docOf(['alpha,', [U()]], [' beta']);
    const next = run(doc, 'beta', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('___________'); // "alpha, beta"
  });
});

// ---- explicitly-selected edge punctuation ----

describe('withGapFix — selected edge punctuation is formatted, not gap-stripped', () => {
  it('selecting a word WITH its trailing period underlines the period (not the following space)', () => {
    // "government." selected (period included), F9. The period was picked on
    // purpose → it takes the underline; the space before the next sentence is
    // the real gap and stays clean.
    const doc = docOf(['government. Even']);
    const next = run(doc, 'government.', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('___________     '); // "government."
  });

  it('a selected trailing SPACE is still trimmed — period underlined, space not', () => {
    // "government. " selected (trailing space). Layer 3 shaves the space out of
    // the operating range, so we underline the period but not the space.
    const doc = docOf(['government. Even']);
    const next = run(doc, 'government. ', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('___________     ');
  });

  it('an UNselected trailing period still bridges between two underlined words', () => {
    // The period belongs to the (already underlined) "government"; underlining
    // the next word "even" bridges the ". " gap so the run is continuous.
    const doc = docOf(['government', [U()]], ['. even']);
    const next = run(doc, 'even', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('________________'); // all of it
  });

  it('selecting a word WITH a leading paren underlines the paren (not the preceding space)', () => {
    const doc = docOf(['see (government here']);
    const next = run(doc, '(government', applyUnderline(() => false));
    expect(mask(next.doc, 'underline_mark')).toBe('    ___________     '); // "(government"
  });
});

// ---- cite / emphasis ----

describe('withGapFix — cite/emphasis bridge', () => {
  it('citing a word between two cited words bridges', () => {
    const C = () => schema.marks['cite_mark']!.create();
    const doc = docOf(['alpha ', [C()]], ['beta'], [' gamma', [C()]]);
    const next = run(doc, 'beta', applyCite());
    expect(mask(next.doc, 'cite_mark')).toBe('________________');
  });

  it('emphasizing a word between two separately-emphasized words fills the EDGE gaps with underline', () => {
    const E = () => schema.marks['emphasis_mark']!.create();
    // "alpha" and "gamma" are SEPARATELY emphasized — their gaps to "beta" are
    // plain (a real seam, as word-by-word F10 would leave them). Emphasizing
    // "beta" joins it to each neighbor across those plain gaps with underline.
    const doc = docOf(['alpha', [E()]], [' beta '], ['gamma', [E()]]);
    const next = run(doc, 'beta', applyEmphasis());
    expect(mask(next.doc, 'emphasis_mark')).toBe('_____ ____ _____');
    expect(mask(next.doc, 'underline_mark')).toBe('     _    _     ');
  });

  it('re-emphasizing a word inside a continuous emphasized phrase keeps the gaps emphasized', () => {
    const E = () => schema.marks['emphasis_mark']!.create();
    // The whole run "alpha beta gamma" is one continuous emphasized phrase
    // (spaces included). F10 is a one-directional apply, so re-emphasizing
    // "beta" must NOT punch underlined holes at its edges — the already-
    // emphasized gaps mark a continuous phrase, not a seam between separate
    // words, so they stay emphasized.
    const doc = docOf(['alpha beta gamma', [E()]]);
    const next = run(doc, 'beta', applyEmphasis());
    expect(mask(next.doc, 'emphasis_mark')).toBe('________________'); // intact
    expect(mask(next.doc, 'underline_mark')).toBe('                '); // none added
  });

  it('emphasizing a contiguous multi-word selection keeps its INTERNAL gaps emphasized', () => {
    // No emphasized neighbors. Selecting "alpha beta" and emphasizing keeps the
    // internal space emphasized (it's part of the selection), not underlined.
    const doc = docOf(['alpha beta gamma']);
    const next = run(doc, 'alpha beta', applyEmphasis());
    expect(mask(next.doc, 'emphasis_mark')).toBe('__________      '); // "alpha beta"
    expect(mask(next.doc, 'underline_mark')).toBe('                ');
  });

  it('emphasizing a mixed-format span emphasizes it whole — no underline left at internal seams', () => {
    // "aa" emphasized, "bb" underlined, "cc" plain; select all and F10. The
    // seams between the former regions are INTERNAL to the selection, so they
    // must end up emphasized like everything else, not retain underline.
    const E = () => schema.marks['emphasis_mark']!.create();
    const doc = docOf(['aa ', [E()]], ['bb ', [U()]], ['cc']);
    const next = run(doc, 'aa bb cc', applyEmphasis());
    expect(mask(next.doc, 'emphasis_mark')).toBe('________'); // all of "aa bb cc"
    expect(mask(next.doc, 'underline_mark')).toBe('        '); // none
  });

  it('mixed emphasis/underline bookends still bridge with underline', () => {
    const E = () => schema.marks['emphasis_mark']!.create();
    const doc = docOf(['alpha ', [E()]], ['beta'], [' gamma', [U()]]);
    const next = run(doc, 'beta', applyUnderline(() => false));
    // "beta" + both gaps become underline; the emphasized "alpha" word keeps
    // its emphasis but the gap after it is underlined.
    expect(mask(next.doc, 'underline_mark')).toBe('     ___________'); // " beta gamma"
  });

  it('highlighting inside continuously-emphasized text leaves the emphasis whole', () => {
    // All of "alpha beta gamma" is emphasized; highlight just "beta". The edge
    // gaps meet emphasized neighbors, but highlight is an UNRELATED family —
    // the emphasis→underline conversion is reserved for actually applying the
    // underline/emphasis family. So the emphasis must survive untouched at the
    // selection's edges, with no underline introduced.
    const E = () => schema.marks['emphasis_mark']!.create();
    const doc = docOf(['alpha beta gamma', [E()]]);
    const next = run(doc, 'beta', applyHighlight(() => 'yellow'));
    expect(mask(next.doc, 'emphasis_mark')).toBe('________________'); // emphasis intact
    expect(mask(next.doc, 'underline_mark')).toBe('                '); // none added
    expect(mask(next.doc, 'highlight')).toBe('      ____      '); // just "beta"
  });
});

// ---- font size ----

describe('withGapFix — font size', () => {
  it('bridges the smaller-pt size across a gap between two sized words', () => {
    // Both bookends explicit; smaller (12pt) wins for the gap.
    const doc = docOf(['alpha ', [FS(14)]], ['beta'], [' gamma', [FS(12)]]);
    // Set "beta" to 12pt so both gaps have explicit-sized bookends.
    const next = run(doc, 'beta', setFontSize(12, () => 11));
    // Every char now carries a font_size mark (no implicit gaps left).
    expect(mask(next.doc, 'font_size')).toBe('________________');
  });
});

// ---- manual Fix Formatting Gaps ----

describe('fixFormattingGaps (manual) — underline_direct in tags', () => {
  it('bridges direct underline across gaps inside a tag', () => {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, [
      schema.text('alpha', [UD()]),
      schema.text(' '),
      schema.text('beta', [UD()]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [tagNode]),
    ]);
    const state = EditorState.create({ doc }); // empty selection → whole doc
    const next = apply(state, fixFormattingGaps(() => 11));
    expect(mask(next.doc, 'underline_direct')).toBe('__________'); // "alpha beta"
  });
});
