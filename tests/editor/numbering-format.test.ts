// @vitest-environment jsdom
/**
 * Per-user number/substructure FORMAT (NUMBERING_PLAN.md §1). Display-only: the
 * number and substructure separators follow INDEPENDENT settings, substructure
 * capitalization is its own toggle, and the same digits/letters render with the
 * chosen suffix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { createNumberGlyph, numberingDisplaySig } from '../../src/editor/numbering-plugin.js';
import type { NumberLabel } from '../../src/editor/numbering.js';

const num: NumberLabel = { kind: 'number', value: 1, text: '1' };
const sub: NumberLabel = { kind: 'sub', value: 1, text: 'a' };
const glyph = (l: NumberLabel): string => createNumberGlyph(l).textContent ?? '';

afterEach(() => {
  settings.set('cardNumberingFormat', 'period');
  settings.set('cardNumberingSubFormat', 'paren');
  settings.set('cardNumberingSubCapitalized', false);
});

describe('number separator', () => {
  const cases: Array<[string, string]> = [
    ['period', '1.'],
    ['paren', '1)'],
    ['dash', '1 -'],
    ['colon', '1:'],
    ['emdash', '1—'],
    ['endash', '1–'],
    ['doublehyphen', '1--'],
    ['triplehyphen', '1---'],
  ];
  for (const [sep, expected] of cases) {
    it(`${sep} → "${expected}"`, () => {
      settings.set('cardNumberingFormat', sep as never);
      expect(glyph(num)).toBe(expected);
    });
  }
});

describe('substructure separator + capitalization', () => {
  it('follows cardNumberingSubFormat, independent of the number separator', () => {
    settings.set('cardNumberingFormat', 'colon');
    settings.set('cardNumberingSubFormat', 'paren');
    expect(glyph(num)).toBe('1:');
    expect(glyph(sub)).toBe('a)');
  });
  it('period → "a."', () => {
    settings.set('cardNumberingSubFormat', 'period');
    expect(glyph(sub)).toBe('a.');
  });
  it('capitalized → "A)"', () => {
    settings.set('cardNumberingSubFormat', 'paren');
    settings.set('cardNumberingSubCapitalized', true);
    expect(glyph(sub)).toBe('A)');
  });
  it('capitalization leaves numbers untouched', () => {
    settings.set('cardNumberingSubCapitalized', true);
    expect(glyph(num)).toBe('1.');
  });
});

describe('substructure weight (cardNumberingSubBold)', () => {
  afterEach(() => settings.set('cardNumberingSubBold', true));

  it('defaults to bold: no plain-weight class on the sub glyph', () => {
    expect(createNumberGlyph(sub).classList.contains('pmd-card-number-sub-plain')).toBe(false);
  });

  it('off → the sub glyph carries the plain-weight class; numbers never do', () => {
    settings.set('cardNumberingSubBold', false);
    expect(createNumberGlyph(sub).classList.contains('pmd-card-number-sub-plain')).toBe(true);
    expect(createNumberGlyph(num).classList.contains('pmd-card-number-sub-plain')).toBe(false);
  });

  it('flipping it changes the display signature (drives NUMBERING_REFRESH + nav re-render)', () => {
    const before = numberingDisplaySig();
    settings.set('cardNumberingSubBold', false);
    expect(numberingDisplaySig()).not.toBe(before);
  });
});
