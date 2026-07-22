/**
 * Stale-journal guard: a crash-recovery journal must be flagged when the file
 * it would overwrite is NEWER than the journal (the journal is from an older
 * session and saving it destroys newer work). A legitimate recovery journal —
 * newer than the last on-disk save — must NOT be flagged.
 */
import { describe, expect, it } from 'vitest';
import {
  journalPredatesFile,
  STALE_JOURNAL_TOLERANCE_MS,
} from '../../src/editor/journal-staleness.js';

const iso = (ms: number) => new Date(ms).toISOString();
const T = 1_800_000_000_000; // fixed base epoch ms

describe('journalPredatesFile', () => {
  it('flags a journal older than the file (stale — the data-loss case)', () => {
    // Journal from an old session; file saved days later.
    expect(journalPredatesFile(iso(T), T + 3 * 24 * 3600 * 1000)).toBe(true);
  });

  it('does NOT flag a normal recovery journal (newer than the last save)', () => {
    // Legit crash recovery: unsaved edits, so the journal is AFTER the file.
    expect(journalPredatesFile(iso(T), T - 60_000)).toBe(false);
  });

  it('does not flag a file only marginally newer (within the grace window)', () => {
    expect(journalPredatesFile(iso(T), T + STALE_JOURNAL_TOLERANCE_MS - 1)).toBe(false);
  });

  it('flags once the file is newer beyond the grace window', () => {
    expect(journalPredatesFile(iso(T), T + STALE_JOURNAL_TOLERANCE_MS + 1)).toBe(true);
  });

  it('treats an equal timestamp as not stale', () => {
    expect(journalPredatesFile(iso(T), T)).toBe(false);
  });

  it('fails open on an unparseable journal timestamp (never blocks on a bad clock)', () => {
    expect(journalPredatesFile('not-a-date', T + 10 * 24 * 3600 * 1000)).toBe(false);
    expect(journalPredatesFile('', T)).toBe(false);
  });

  it('respects a custom tolerance', () => {
    expect(journalPredatesFile(iso(T), T + 1000, 2000)).toBe(false);
    expect(journalPredatesFile(iso(T), T + 3000, 2000)).toBe(true);
  });
});
