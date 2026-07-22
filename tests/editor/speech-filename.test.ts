/**
 * Speech-doc filename template: date tokens, field substitution, and
 * filename sanitization. A fixed Date keeps every assertion exact (no
 * clock flake, no locale dependence).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH_FILENAME_TEMPLATE,
  formatDate,
  renderSpeechFilename,
  renderSpeechName,
  sanitizeFilename,
} from '../../src/editor/speech-filename.js';

// 2026-04-12 19:05:07 local time. Constructed from parts (not an ISO
// string) so the test reads local-time getters, matching the code.
const AT = new Date(2026, 3, 12, 19, 5, 7);
const MIDNIGHT = new Date(2026, 3, 12, 0, 30, 0);
const NOON = new Date(2026, 3, 12, 12, 30, 0);

describe('formatDate tokens', () => {
  it('doubles the token to zero-pad, singles it to not', () => {
    expect(formatDate('MM-DD hh-mmA', AT)).toBe('04-12 07-05PM');
    expect(formatDate('M-D h-mmA', AT)).toBe('4-12 7-05PM');
  });

  it('is correct at midnight and at noon', () => {
    expect(formatDate('hA', MIDNIGHT)).toBe('12AM');
    expect(formatDate('hA', NOON)).toBe('12PM');
    expect(formatDate('HH', MIDNIGHT)).toBe('00');
    expect(formatDate('HH', NOON)).toBe('12');
  });

  it('supports year, seconds, name tokens, and lowercase am/pm', () => {
    expect(formatDate('YYYY YY ss MMM MMMM ddd dddd a', AT)).toBe(
      '2026 26 07 Apr April Sun Sunday pm',
    );
  });

  it('matches longest-first, so YYYY is not two YY', () => {
    // The regression this guards: alternation order. With YY listed
    // before YYYY, this would render '2626'.
    expect(formatDate('YYYY', AT)).toBe('2026');
    expect(formatDate('MMMM', AT)).toBe('April');
    expect(formatDate('dddd', AT)).toBe('Sunday');
  });

  it('leaves non-token characters literal, needing no escaping', () => {
    expect(formatDate('--/:. ', AT)).toBe('--/:. ');
  });

  it('takes bracketed text literally, so a word can survive', () => {
    // Without brackets every letter here is a token: 'at' would
    // become the day-of-month plus 'pm'.
    expect(formatDate('h[at]A', AT)).toBe('7atPM');
    expect(formatDate('[]', AT)).toBe('');
  });
});

describe('renderSpeechName', () => {
  it('substitutes {round} and {date:...}', () => {
    expect(
      renderSpeechName('Speech {round} {date:M-D h-mmA}', '1NC', AT),
    ).toBe('Speech 1NC 4-12 7-05PM');
  });

  it('leaves an unknown field literal', () => {
    expect(renderSpeechName('{round} {bogus}', '1NC', AT)).toBe('1NC {bogus}');
  });

  it('supports a template with no date field at all', () => {
    expect(renderSpeechName('Speech {round}', '2AC', AT)).toBe('Speech 2AC');
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators so the name is a single path segment', () => {
    const out = sanitizeFilename('1NC/../../evil');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    // The real property: the result cannot walk out of its folder.
    expect(out.split(/[/\\]/)).toHaveLength(1);
  });

  it('turns separators and the colon into hyphens, not nothing', () => {
    // The reason this matters: these are the characters a date format
    // legitimately contains. Deleting them would mush the fields.
    expect(sanitizeFilename('12/04/2026')).toBe('12-04-2026');
    expect(sanitizeFilename('07:05 pm')).toBe('07-05 pm');
    expect(sanitizeFilename('a\\b')).toBe('a-b');
  });

  it('drops the illegal characters that are never deliberate', () => {
    expect(sanitizeFilename('a*b?c"d<e>f|g')).toBe('abcdefg');
  });

  it('collapses whitespace and trims leading/trailing spaces and dots', () => {
    expect(sanitizeFilename('  ..Speech   1NC..  ')).toBe('Speech 1NC');
  });

  it('truncates to 200 characters', () => {
    expect(sanitizeFilename('x'.repeat(500))).toHaveLength(200);
  });

  it('falls back to "Speech" when nothing survives', () => {
    expect(sanitizeFilename('...   ')).toBe('Speech');
    expect(sanitizeFilename('')).toBe('Speech');
  });

  it('defuses an absolute path into one segment', () => {
    expect(sanitizeFilename('C:\\Windows\\evil')).toBe('C--Windows-evil');
  });
});

describe('renderSpeechFilename', () => {
  it('the default template reproduces the legacy filename exactly', () => {
    // Legacy: `Speech ${round} ${month}-${day} ${hour}-${mm}${ampm}.${format}`
    expect(
      renderSpeechFilename(
        DEFAULT_SPEECH_FILENAME_TEMPLATE,
        '1NC',
        'docx',
        AT,
      ),
    ).toBe('Speech 1NC 4-12 7-05PM.docx');
  });

  it('appends the extension from the format, never from the template', () => {
    expect(renderSpeechFilename('Speech {round}', '1NC', 'cmir', AT)).toBe(
      'Speech 1NC.cmir',
    );
  });

  it('sanitizes after rendering, so a hostile round name is defused', () => {
    expect(
      renderSpeechFilename('Speech {round}', '../../evil', 'docx', AT),
    ).toBe('Speech ..-..-evil.docx');
  });

  it('falls back when the template renders to nothing', () => {
    expect(renderSpeechFilename('', '', 'docx', AT)).toBe('Speech.docx');
  });
});

describe('settings default', () => {
  it('the shipped default equals the module default', async () => {
    // Guards the two from drifting apart. If this fails, one of the
    // two was edited without the other.
    const { SETTINGS_DEFAULTS } = await import('../../src/editor/settings.js');
    expect(SETTINGS_DEFAULTS.speechDocFilenameTemplate).toBe(
      DEFAULT_SPEECH_FILENAME_TEMPLATE,
    );
  });
});
