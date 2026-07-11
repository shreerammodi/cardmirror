/**
 * The researcher's standalone default prompt: shares the formatting
 * guide and the delimited-block output instructions with the formatter
 * default (the parser depends on the markers), resolves {DATE}, and
 * drops the formatter-only "do not add information" constraint that
 * would forbid researching.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AI_CITE_PROMPT,
  DEFAULT_AI_RESEARCH_CITE_PROMPT,
  resolveCitePrompt,
} from '../../src/editor/ai/cite-creator.js';

describe('DEFAULT_AI_RESEARCH_CITE_PROMPT', () => {
  it('contains the three delimited-block markers the parser depends on', () => {
    for (const marker of ['[[CITE]]', '[[TOKENS]]', '[[END]]']) {
      expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).toContain(marker);
    }
  });

  it('resolves {DATE} to today', () => {
    const resolved = resolveCitePrompt(DEFAULT_AI_RESEARCH_CITE_PROMPT, new Date(2026, 6, 11));
    expect(resolved).toContain("Today's date is 7-11-2026.");
    expect(resolved).not.toContain('{DATE}');
  });

  it('includes the research-specific instructions', () => {
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).toContain('web search');
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).toContain('qualifications');
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).toContain('No "Tag" prefix');
  });

  it('omits the formatter-only add/remove constraints', () => {
    expect(DEFAULT_AI_CITE_PROMPT).toContain('Do not add any information');
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).not.toContain('Do not add any information');
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).not.toContain('Do not remove any information');
  });

  it('shares the formatting guide and output block with the formatter default', () => {
    // Guide sentinels present in both.
    for (const s of [
      'Examples of the desired format:',
      'Jie Jiang et al. 23',
      "use '&' for two authors and 'et al.' for three or more",
    ]) {
      expect(DEFAULT_AI_CITE_PROMPT).toContain(s);
      expect(DEFAULT_AI_RESEARCH_CITE_PROMPT).toContain(s);
    }
    // Both end with the byte-identical output-format instructions.
    const tailStart = DEFAULT_AI_CITE_PROMPT.indexOf('Respond using the delimited block format');
    expect(tailStart).toBeGreaterThan(-1);
    const tail = DEFAULT_AI_CITE_PROMPT.slice(tailStart);
    expect(DEFAULT_AI_RESEARCH_CITE_PROMPT.endsWith(tail)).toBe(true);
  });
});

describe('DEFAULT_AI_CITE_PROMPT (regression: fragment refactor is a verbatim move)', () => {
  it('keeps its opening, constraints, and examples', () => {
    expect(DEFAULT_AI_CITE_PROMPT.startsWith("Today's date is {DATE}.")).toBe(true);
    for (const s of [
      'You are an expert in formatting academic citations.',
      'Important:',
      '- Do not remove any information from the citation that was included in the submission.',
      'Robert N. Stavins 18',
      'Each token MUST be a verbatim substring of the cite so the editor can locate it.',
    ]) {
      expect(DEFAULT_AI_CITE_PROMPT).toContain(s);
    }
  });
});
