import { describe, it, expect } from 'vitest';
import { SAMPLE_PARAS, CITE_RUNS } from '../../src/editor/benchmark-sample.js';

// The benchmark's card-cutting test pastes SAMPLE_PARAS as separate paragraphs
// (with blank spacers between), condenses to clean it up, then re-cuts to the
// runs' formatting and applies the cite mark. These invariants guard the
// auto-extracted fixture so a bad re-extraction can't silently neuter the test.

describe('benchmark sample fixture', () => {
  it('is a multi-paragraph card so condense has real work to do', () => {
    expect(SAMPLE_PARAS.length).toBeGreaterThanOrEqual(2);
    for (const para of SAMPLE_PARAS) {
      expect(para.length).toBeGreaterThan(0);
      // each paragraph is substantial real prose
      expect(para.map((r) => r[0]).join('').length).toBeGreaterThan(100);
    }
  });

  it('carries all three cutting marks across its runs', () => {
    const flat = SAMPLE_PARAS.flat();
    for (const code of ['u', 'e', 'h']) {
      expect(flat.some((r) => r[1].includes(code))).toBe(true);
    }
  });

  it('has a realistic cite line with only the author/short-cite marked', () => {
    const citeText = CITE_RUNS.map((r) => r[0]).join('');
    expect(citeText.length).toBeGreaterThan(40); // a full citation, not a stub
    const marked = CITE_RUNS.filter((r) => r[1].includes('c'));
    expect(marked.length).toBeGreaterThan(0);
    // the cite mark covers just the short author/cite, not the whole line
    expect(marked.map((r) => r[0]).join('').length).toBeLessThan(40);
    expect(marked.map((r) => r[0]).join('').length).toBeLessThan(citeText.length);
  });
});
