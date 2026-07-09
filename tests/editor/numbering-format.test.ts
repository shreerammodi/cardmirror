// @vitest-environment jsdom
/**
 * Per-user number FORMAT (NUMBERING_PLAN.md §1). Display-only: the glyph
 * separator follows the `cardNumberingFormat` setting; the same letters/digits
 * just render with a different suffix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { createNumberGlyph } from '../../src/editor/numbering-plugin.js';
import type { NumberLabel } from '../../src/editor/numbering.js';

const num: NumberLabel = { kind: 'number', value: 1, text: '1' };
const sub: NumberLabel = { kind: 'sub', value: 1, text: 'a' };
const glyph = (l: NumberLabel): string => createNumberGlyph(l).textContent ?? '';

afterEach(() => settings.set('cardNumberingFormat', 'period'));

describe('card number format', () => {
  it('period → "1." / "a."', () => {
    settings.set('cardNumberingFormat', 'period');
    expect(glyph(num)).toBe('1.');
    expect(glyph(sub)).toBe('a.');
  });
  it('paren → "1)" / "a)"', () => {
    settings.set('cardNumberingFormat', 'paren');
    expect(glyph(num)).toBe('1)');
    expect(glyph(sub)).toBe('a)');
  });
  it('dash → "1 -" / "a -"', () => {
    settings.set('cardNumberingFormat', 'dash');
    expect(glyph(num)).toBe('1 -');
    expect(glyph(sub)).toBe('a -');
  });
});
