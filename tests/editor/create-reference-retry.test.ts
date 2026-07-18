/**
 * Create Reference's clipboard write retries transient failures —
 * Windows' clipboard is a global lock briefly held by whatever app
 * copied last (Word, clipboard managers), and Chromium rejects
 * writes from an unfocused document. Field report 2026-07-17: the
 * silent version taught a user the button "needs five clicks".
 */
import { describe, it, expect } from 'vitest';
import { writeClipboardWithRetry } from '../../src/editor/create-reference.js';

const failing = (failures: number) => {
  let calls = 0;
  const fn = async (): Promise<void> => {
    calls++;
    if (calls <= failures) throw new Error('clipboard busy');
  };
  return { fn, calls: () => calls };
};

describe('writeClipboardWithRetry', () => {
  it('succeeds first try without retrying', async () => {
    const w = failing(0);
    expect(await writeClipboardWithRetry(w.fn, [1, 1, 1])).toBe(true);
    expect(w.calls()).toBe(1);
  });

  it('absorbs transient failures and succeeds', async () => {
    const w = failing(2);
    expect(await writeClipboardWithRetry(w.fn, [1, 1, 1])).toBe(true);
    expect(w.calls()).toBe(3);
  });

  it('gives up after exhausting the delays', async () => {
    const w = failing(99);
    expect(await writeClipboardWithRetry(w.fn, [1, 1])).toBe(false);
    expect(w.calls()).toBe(3); // initial + one per delay
  });
});
