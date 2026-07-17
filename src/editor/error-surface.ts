/**
 * Global last-resort error surfacing.
 *
 * The renderer had NO unhandledrejection/error hooks, and fire-and-forget
 * entry points (`void runSaveFlow()` and friends) swallow rejections — so an
 * exception thrown before a flow's own try/catch produced literally nothing
 * on screen. Field bug 2026-07-12: a user's Save, Save As, and autosave all
 * silently did nothing; a screen recording of "click → nothing" was the only
 * evidence the app gave her. These hooks make that class of failure visible:
 * full details to the console (for DevTools screenshots), plus a throttled
 * toast so the user knows something actually went wrong.
 */

import { showToast } from './toast.js';

/** Min gap between error toasts — a rejection storm (e.g., a broken timer
 *  loop) should not bury the UI in toasts; the console gets every event. */
const TOAST_GAP_MS = 10_000;
let lastToastAt = 0;

function surface(kind: string, err: unknown): void {
  console.error(`[cardmirror ${kind}]`, err);
  const now = Date.now();
  if (now - lastToastAt < TOAST_GAP_MS) return;
  lastToastAt = now;
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  showToast(`Something went wrong: ${msg} — details in the developer console.`);
}

/** Whether a save failure means the file's on-disk location is GONE —
 *  Electron surfaces a renamed/moved/deleted parent folder as ENOENT
 *  (via the IPC error message); the web FS Access API throws a
 *  NotFoundError DOMException for a handle whose file was removed.
 *  Distinct from "couldn't write" errors (permissions, disk full),
 *  which Save As can't fix any better than Save.
 *
 *  Shape-checked rather than `instanceof Error`: DOMException doesn't
 *  inherit from Error in every runtime (it doesn't in jsdom), and the
 *  NotFoundError case is precisely a DOMException. */
export function isFileGoneError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return (typeof message === 'string' && message.includes('ENOENT')) || name === 'NotFoundError';
}

/** Whether a save failure means the file CHANGED ON DISK since we last
 *  read or wrote it — another program, device, or sync service wrote
 *  the path while the doc was open. Raised by the Electron main
 *  process's changed-on-disk guard (doc-writes.ts), which marks the
 *  error message with 'EMODIFIED' because only the message survives
 *  the IPC boundary (same convention as the ENOENT check above).
 *  Distinct from `isFileGoneError`: the file is still there, so the
 *  remedy is overwrite / Save As / cancel, not a forced relocation. */
export function isFileChangedOnDiskError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { message } = err as { message?: unknown };
  return typeof message === 'string' && message.includes('EMODIFIED');
}

/** The friendly text of a "file temporarily locked" save failure, or
 *  null for every other error. Raised by the atomic-write rename in
 *  the Electron main process (doc-writes.ts) after its retry backoff
 *  is exhausted — marked 'ELOCKED' in the message because only the
 *  message survives the IPC boundary (same convention as EMODIFIED /
 *  ENOENT above). Returns just the human sentence so callers can show
 *  it WITHOUT Electron's "Error invoking remote method …" wrapper. */
export function fileLockedMessage(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { message } = err as { message?: unknown };
  if (typeof message !== 'string') return null;
  const idx = message.indexOf('ELOCKED: ');
  return idx >= 0 ? message.slice(idx + 'ELOCKED: '.length) : null;
}

/** Benign browser noise that arrives as a window `error` event without
 *  anything actually being broken: ResizeObserver fires this whenever
 *  layout observers need another tick (both wordings, per browser).
 *  Toasting it would cry wolf on every launch. */
const BENIGN_ERROR = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

export function installGlobalErrorSurface(): void {
  window.addEventListener('unhandledrejection', (e) => {
    surface('unhandled rejection', (e as PromiseRejectionEvent).reason);
  });
  window.addEventListener('error', (e) => {
    // Runtime script errors only — resource load errors don't bubble here.
    if (BENIGN_ERROR.test((e as ErrorEvent).message ?? '')) return;
    surface('uncaught error', (e as ErrorEvent).error ?? (e as ErrorEvent).message);
  });
}
