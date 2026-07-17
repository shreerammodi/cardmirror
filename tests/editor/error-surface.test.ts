// @vitest-environment jsdom
/**
 * Global error surfacing (error-surface.ts) — the backstop added after the
 * 2026-07-12 field bug where Save/Save As/autosave all failed with literally
 * nothing on screen. Uncaught errors and unhandled rejections must produce a
 * toast (throttled) and never themselves throw; isFileGoneError must classify
 * exactly the renamed/moved/deleted-location failures that Save As can fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  installGlobalErrorSurface,
  isFileGoneError,
  isFileChangedOnDiskError,
  fileLockedMessage,
} from '../../src/editor/error-surface.js';

describe('isFileGoneError', () => {
  it('classifies Electron ENOENT (raw and IPC-wrapped) as file-gone', () => {
    expect(isFileGoneError(new Error("ENOENT: no such file or directory, open 'C:\\x.cmir'"))).toBe(
      true,
    );
    // The renderer sees main-process errors wrapped by Electron's IPC layer.
    expect(
      isFileGoneError(
        new Error(
          "Error invoking remote method 'host:save-existing': Error: ENOENT: no such file or directory",
        ),
      ),
    ).toBe(true);
  });

  it('classifies the web FS Access NotFoundError as file-gone', () => {
    const err = new DOMException('file gone', 'NotFoundError');
    expect(isFileGoneError(err)).toBe(true);
  });

  it('rejects errors Save As cannot fix, and non-Errors', () => {
    expect(isFileGoneError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isFileGoneError(new DOMException('denied', 'NotAllowedError'))).toBe(false);
    expect(isFileGoneError('ENOENT-ish string')).toBe(false);
    expect(isFileGoneError(null)).toBe(false);
  });
});

describe('isFileChangedOnDiskError', () => {
  it('classifies the main-process EMODIFIED guard error (raw and IPC-wrapped)', () => {
    expect(
      isFileChangedOnDiskError(
        new Error('EMODIFIED: "Aff.cmir" changed on disk after CardMirror last read or wrote it'),
      ),
    ).toBe(true);
    expect(
      isFileChangedOnDiskError(
        new Error(
          "Error invoking remote method 'host:save-existing': Error: EMODIFIED: \"Aff.cmir\" changed on disk",
        ),
      ),
    ).toBe(true);
  });

  it('is disjoint from file-gone: each classifier rejects the other class', () => {
    const changed = new Error('EMODIFIED: "x.cmir" changed on disk');
    const gone = new Error('ENOENT: no such file or directory');
    expect(isFileGoneError(changed)).toBe(false);
    expect(isFileChangedOnDiskError(gone)).toBe(false);
  });

  it('rejects unrelated errors and non-Errors', () => {
    expect(isFileChangedOnDiskError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isFileChangedOnDiskError('EMODIFIED-ish string')).toBe(false);
    expect(isFileChangedOnDiskError(null)).toBe(false);
  });
});

describe('installGlobalErrorSurface', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  // Install ONCE for the whole file — installing per test would stack
  // duplicate listeners and double-count every dispatched event.
  beforeAll(() => {
    installGlobalErrorSurface();
  });
  // Strictly increasing base time per test: the throttle's module-level
  // timestamp persists across tests, and fresh fake timers would otherwise
  // restart the clock BEHIND it, throttling every later test's first toast.
  let base = 1_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    base += 100_000;
    vi.setSystemTime(base);
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
    document.querySelectorAll('.pmd-toast').forEach((t) => t.remove());
  });

  const toasts = (): string[] =>
    [...document.querySelectorAll('.pmd-toast')].map((t) => t.textContent ?? '');

  it('an uncaught error produces a console record and a toast with the message', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom in handler') }));
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(toasts().some((t) => t.includes('boom in handler'))).toBe(true);
  });

  it('throttles toasts (console still gets every event), then re-arms', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('first') }));
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('second') }));
    expect(toasts().length).toBe(1);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    // Past the throttle window a new failure surfaces again.
    vi.advanceTimersByTime(11_000);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('third') }));
    expect(toasts().some((t) => t.includes('third'))).toBe(true);
  });

  it('ignores benign ResizeObserver loop noise entirely (no toast, no record)', () => {
    // Chromium dispatches these as message-only error events (no .error)
    // on healthy launches — they must not trip the "something went
    // wrong" toast. Both browser wordings.
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
      }),
    );
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }));
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    // A real error right after still surfaces — the filter is not a gate
    // on the throttle.
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('real failure') }));
    expect(toasts().some((t) => t.includes('real failure'))).toBe(true);
  });

  it('an unhandled rejection event is surfaced without throwing', () => {
    // jsdom has no PromiseRejectionEvent constructor; the handler must cope
    // with whatever event object arrives (reads .reason, possibly undefined).
    expect(() => window.dispatchEvent(new Event('unhandledrejection'))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});

describe('fileLockedMessage — transiently locked file (ELOCKED)', () => {
  it('extracts the friendly sentence from the IPC-wrapped message', () => {
    const err = new Error(
      "Error invoking remote method 'host:save-existing': Error: ELOCKED: " +
        '"Working (Max, Summer).docx" is temporarily locked by another program ' +
        '— often Dropbox or an antivirus scanner still processing the previous ' +
        'save. Wait a few seconds and save again. (EPERM)',
    );
    const msg = fileLockedMessage(err);
    expect(msg).not.toBeNull();
    expect(msg).toContain('temporarily locked');
    expect(msg).not.toContain('invoking remote method');
    expect(msg).not.toContain('ELOCKED');
  });

  it('null for unrelated errors', () => {
    expect(fileLockedMessage(new Error('EPERM: operation not permitted'))).toBeNull();
    expect(fileLockedMessage(new Error('ENOENT: no such file'))).toBeNull();
    expect(fileLockedMessage(null)).toBeNull();
    expect(fileLockedMessage('string')).toBeNull();
  });
});
