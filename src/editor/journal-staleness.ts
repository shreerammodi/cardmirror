/**
 * Is a crash-recovery journal older than the file it would overwrite?
 *
 * Journals are keyed by session doc-uid, not by file path, so an old
 * journal from a crashed session lingers in the store even as later
 * sessions open, edit, and save the SAME file under fresh uids. On the next
 * launch that stale journal shows up in the recovery sidebar, and its Save
 * writes the old journal bytes straight over the newer file — destroying the
 * work done since the crash.
 *
 * A legitimate recovery journal is NEWER than the last on-disk save (it holds
 * unsaved edits), so `savedAt > fileMtime` and this returns false. Only a
 * journal that predates the file's last modification — the stale case — trips
 * it, which the recovery Save turns into a hard confirmation before writing.
 */

/** Small grace window so filesystem timestamp resolution, clock skew, or a
 *  sync service touching mtime doesn't flag an essentially-contemporaneous
 *  journal. A genuinely stale journal predates the file by minutes-to-days,
 *  far beyond this. */
export const STALE_JOURNAL_TOLERANCE_MS = 5_000;

/** True when the file on disk (`fileMtimeMs`) is meaningfully newer than the
 *  journal (`savedAtIso`), i.e. saving the journal would overwrite newer
 *  work. False when the timestamp is unparseable (fail open — never block a
 *  recovery on a bad clock). */
export function journalPredatesFile(
  savedAtIso: string,
  fileMtimeMs: number,
  toleranceMs: number = STALE_JOURNAL_TOLERANCE_MS,
): boolean {
  const journalMs = Date.parse(savedAtIso);
  if (!Number.isFinite(journalMs)) return false;
  return fileMtimeMs > journalMs + toleranceMs;
}
