/**
 * Tests for the AI explainer's context builder + @AI mention
 * detection + Clod activity selection.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildExplainContext,
  formatExplainPrompt,
  hasAiMention,
} from '../../src/editor/ai/explain-context.js';
import {
  activitiesForNow,
  currentClodPeriod,
  getCurrentHoliday,
  pickRandomActivity,
  CLOD_ACTIVITIES_BY_TIME,
  CLOD_HOLIDAY_ACTIVITIES,
  DEFAULT_CLOD_TIME_PERIODS,
} from '../../src/editor/ai/clod.js';

// ---- Doc builders ----------------------------------------------

function paragraph(text: string) {
  return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []);
}
function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function analytic(text: string) {
  return schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text));
}
function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function citeParagraph(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}
function card(...children: any[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function analyticUnit(...children: any[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}
function makeDoc(...children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function selectionAt(doc: any, from: number, to: number): EditorState {
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

// ---- Tests ------------------------------------------------------

describe('buildExplainContext', () => {
  it('returns null on an empty selection', () => {
    const doc = makeDoc(paragraph('hello'));
    const state = EditorState.create({ doc });
    expect(buildExplainContext(state)).toBeNull();
  });

  it('on a doc-level paragraph selection returns selection-only context', () => {
    const doc = makeDoc(paragraph('the quick brown fox'));
    const state = selectionAt(doc, 1, 20);
    const ctx = buildExplainContext(state);
    expect(ctx).not.toBeNull();
    expect(ctx!.selection).toBe('the quick brown fox');
    expect(ctx!.tag).toBeNull();
    expect(ctx!.analytic).toBeNull();
    expect(ctx!.cites).toEqual([]);
  });

  it('inside a card includes the tag and all cite_paragraphs', () => {
    const doc = makeDoc(
      card(
        tag('Restraint is good'),
        citeParagraph('Smith 2024'),
        cardBody('argument body text'),
        citeParagraph('Jones 2023'),
      ),
    );
    // Walk to find the card_body's text. Card opens at 0, tag at 1.
    let from = 0, to = 0;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'argument body text') {
        from = p + 4; to = p + 10; // "ment b"
      }
    });
    const state = selectionAt(doc, from, to);
    const ctx = buildExplainContext(state);
    expect(ctx).not.toBeNull();
    expect(ctx!.selection.length).toBeGreaterThan(0);
    expect(ctx!.tag).toBe('Restraint is good');
    expect(ctx!.cites).toEqual(['Smith 2024', 'Jones 2023']);
  });

  it('inside an analytic_unit returns the analytic in the analytic slot', () => {
    const doc = makeDoc(
      analyticUnit(
        analytic('My analytic header'),
        cardBody('body text here'),
      ),
    );
    let from = 0, to = 0;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'body text here') { from = p + 1; to = p + 5; }
    });
    const state = selectionAt(doc, from, to);
    const ctx = buildExplainContext(state);
    expect(ctx!.analytic).toBe('My analytic header');
    expect(ctx!.tag).toBeNull();
  });
});

describe('formatExplainPrompt', () => {
  it('omits the surrounding-context block when nothing is provided', () => {
    const out = formatExplainPrompt('what does this mean?', {
      selection: 'some text',
      paragraphs: [],
      tag: null,
      analytic: null,
      cites: [],
    });
    expect(out).toContain('Question: what does this mean?');
    expect(out).toContain('Selected text:');
    expect(out).toContain('some text');
    expect(out).not.toContain('Surrounding context');
    expect(out).not.toContain('Source paragraph');
  });

  it('includes tag / analytic / cite lines when present', () => {
    const out = formatExplainPrompt('why does this matter?', {
      selection: 'XXX',
      paragraphs: [],
      tag: 'My Tag',
      analytic: 'My Analytic',
      cites: ['Cite A', 'Cite B'],
    });
    expect(out).toContain('Tag: My Tag');
    expect(out).toContain('Analytic: My Analytic');
    expect(out).toContain('Cite: Cite A');
    expect(out).toContain('Cite: Cite B');
  });

  it('includes the source paragraph block when paragraphs are supplied', () => {
    const out = formatExplainPrompt('q', {
      selection: 'half',
      paragraphs: ['half a sentence inside a longer paragraph'],
      tag: null,
      analytic: null,
      cites: [],
    });
    expect(out).toContain('Source paragraph(s):');
    expect(out).toContain('half a sentence inside a longer paragraph');
  });
});

describe('buildExplainContext — paragraphs touched by selection', () => {
  it('captures the full paragraph even when only a fragment is selected', () => {
    const doc = makeDoc(paragraph('The quick brown fox jumps over the lazy dog'));
    const state = selectionAt(doc, 5, 14);
    const ctx = buildExplainContext(state);
    expect(ctx!.paragraphs).toEqual(['The quick brown fox jumps over the lazy dog']);
  });

  it('captures multiple paragraphs when the selection crosses boundaries', () => {
    const doc = makeDoc(
      paragraph('first paragraph'),
      paragraph('second paragraph'),
    );
    // First-paragraph end: 1 + 15 + 1 = 17. Second-paragraph start: 18.
    const state = selectionAt(doc, 10, 25);
    const ctx = buildExplainContext(state);
    expect(ctx!.paragraphs).toEqual(['first paragraph', 'second paragraph']);
  });
});

describe('hasAiMention', () => {
  it('matches @AI bounded by whitespace', () => {
    expect(hasAiMention('hey @AI can you weigh in')).toBe(true);
    expect(hasAiMention('@AI')).toBe(true);
    expect(hasAiMention('what does @ai think?')).toBe(true); // case-insensitive
  });

  it('does not match substrings inside words', () => {
    expect(hasAiMention('email@AI.example.com')).toBe(false);
    expect(hasAiMention('@AIRPLANE')).toBe(false);
    expect(hasAiMention('@AIs')).toBe(false);
  });

  it('returns false on empty / no-mention text', () => {
    expect(hasAiMention('')).toBe(false);
    expect(hasAiMention('plain reply')).toBe(false);
  });
});

describe('cite-creator response parsing', () => {
  it('parses a clean JSON reply with cite + tokens', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = JSON.stringify({
      cite: 'Smith 24 (UCLA), "Title," Foreign Affairs, 5-12-2024, https://x, accessed 5-14-2026.',
      tokens: ['Smith 24'],
    });
    const out = parseCiteResponse(text);
    expect(out.cite).toContain('Smith 24');
    expect(out.tokens).toEqual(['Smith 24']);
  });

  it('strips a fenced ```json wrapper if the model adds one', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = '```json\n{"cite":"Smith 24, ...","tokens":["Smith 24"]}\n```';
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24, ...');
    expect(out.tokens).toEqual(['Smith 24']);
  });

  it('throws on missing cite field', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    expect(() => parseCiteResponse('{"tokens":["X"]}')).toThrow(/cite/i);
  });

  it('throws on missing tokens array', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    expect(() => parseCiteResponse('{"cite":"X"}')).toThrow(/tokens/i);
  });

  it('substitutes {DATE} placeholder for today', async () => {
    const { resolveCitePrompt } = await import('../../src/editor/ai/cite-creator.js');
    const out = resolveCitePrompt('today is {DATE}', new Date(2026, 0, 5));
    expect(out).toBe('today is 1-5-2026');
  });
});

describe('clod time-period selection', () => {
  it('places 7am in "morning" under defaults', () => {
    const at = new Date(2026, 4, 13, 7, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('morning');
  });

  it('places 3pm in "day"', () => {
    const at = new Date(2026, 4, 13, 15, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('day');
  });

  it('handles the night period that crosses midnight', () => {
    const at = new Date(2026, 4, 13, 2, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('night');
    const lateNight = new Date(2026, 4, 13, 23, 30, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, lateNight)).toBe('night');
  });
});

describe('clod activity pool selection', () => {
  it('returns the day pool on a normal mid-day time', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0); // June 15 (no holiday)
    const pool = activitiesForNow({ now: at });
    expect(pool).toEqual(CLOD_ACTIVITIES_BY_TIME.day);
  });

  it('substitutes a holiday pool on its calendar day (replacing the day pool)', () => {
    const halloween = new Date(2026, 9, 31, 13, 0, 0); // Oct 31, 1pm
    expect(getCurrentHoliday(halloween)).toBe('halloween');
    const pool = activitiesForNow({ now: halloween });
    expect(pool).toEqual(CLOD_HOLIDAY_ACTIVITIES.halloween);
  });

  it('uses custom override when non-empty for the current period', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0);
    const pool = activitiesForNow({
      now: at,
      customByTime: { day: ['my custom activity'] },
    });
    expect(pool).toEqual(['my custom activity']);
  });

  it('falls back to defaults when a custom override is empty', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0);
    const pool = activitiesForNow({
      now: at,
      customByTime: { day: [] },
    });
    expect(pool).toEqual(CLOD_ACTIVITIES_BY_TIME.day);
  });

  it('pickRandomActivity returns one of the pool entries', () => {
    const pool = ['a', 'b', 'c'];
    for (let i = 0; i < 10; i++) {
      expect(pool).toContain(pickRandomActivity(pool));
    }
  });

  it('pickRandomActivity returns a sensible fallback when pool is empty', () => {
    expect(pickRandomActivity([])).toBe('Clod is thinking…');
  });
});
