/**
 * Stale-journal guard: a crash-recovery journal must be flagged when the file
 * it would overwrite is NEWER than the journal (the journal is from an older
 * session and saving it destroys newer work). A legitimate recovery journal —
 * newer than the last on-disk save — must NOT be flagged.
 */
import { describe, expect, it } from 'vitest';
import {
  journalPredatesFile,
  journalStalenessBaseline,
  STALE_JOURNAL_TOLERANCE_MS,
  markRecoveredDraft,
  recoveredDraftJournalSavedAt,
  clearRecoveredDraftMark,
  autosaveBlockedForRecoveredDraft,
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

/** Editing a recovered draft re-journals it with `savedAt` = now, which would
 *  make a stale draft look fresh after a crash-relaunch or mode switch. The
 *  baseline keeps the ORIGINAL recovered-from timestamp in play. */
describe('journalStalenessBaseline', () => {
  it('keeps a laundered journal stale via its recovered-from provenance', () => {
    // Stale draft (T) recovered + edited; the re-journal stamps savedAt ten
    // days later. The file was saved in between — newer than the draft,
    // older than the re-journal.
    const entry = {
      savedAt: iso(T + 10 * 24 * 3600 * 1000),
      recoveredFromSavedAt: iso(T),
    };
    const fileMtime = T + 5 * 24 * 3600 * 1000;
    // Judged on savedAt alone the staleness is invisible…
    expect(journalPredatesFile(entry.savedAt, fileMtime)).toBe(false);
    // …but the provenance baseline still flags it.
    expect(journalPredatesFile(journalStalenessBaseline(entry), fileMtime)).toBe(true);
  });

  it('falls back to savedAt for a normal journal', () => {
    expect(journalStalenessBaseline({ savedAt: iso(T) })).toBe(iso(T));
  });
});

/** Both autosave paths (single-doc runAutosaveAttempt, three-pane
 *  runAutosaveForRecord) gate on this registry: a recovered draft must not
 *  autosave before its first MANUAL save, because only the manual path runs
 *  the stale-overwrite confirmation. Regression for the hole where three-pane
 *  re-armed autosave from the per-path preference on a recovered stale draft
 *  and silently overwrote the newer file. */
describe('recovered-draft marks', () => {
  it('blocks autosave for a marked draft and unblocks once the mark clears', () => {
    const uid = 'mark-test-autosave';
    expect(autosaveBlockedForRecoveredDraft(uid)).toBe(false);
    markRecoveredDraft(uid, iso(T));
    expect(autosaveBlockedForRecoveredDraft(uid)).toBe(true);
    clearRecoveredDraftMark(uid);
    expect(autosaveBlockedForRecoveredDraft(uid)).toBe(false);
  });

  it('stores the journal savedAt for the save-flow guard, per uid', () => {
    const a = 'mark-test-savedat-a';
    const b = 'mark-test-savedat-b';
    markRecoveredDraft(a, iso(T));
    markRecoveredDraft(b, iso(T + 1000));
    expect(recoveredDraftJournalSavedAt(a)).toBe(iso(T));
    expect(recoveredDraftJournalSavedAt(b)).toBe(iso(T + 1000));
    clearRecoveredDraftMark(a);
    expect(recoveredDraftJournalSavedAt(a)).toBeUndefined();
    expect(recoveredDraftJournalSavedAt(b)).toBe(iso(T + 1000));
    clearRecoveredDraftMark(b);
  });

  it('never blocks a doc that was not recovered (unknown uid)', () => {
    expect(autosaveBlockedForRecoveredDraft('never-marked')).toBe(false);
    expect(recoveredDraftJournalSavedAt('never-marked')).toBeUndefined();
    // Clearing an unknown uid is a harmless no-op.
    clearRecoveredDraftMark('never-marked');
  });
});
