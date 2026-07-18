/**
 * Beep-schedule derivation for the audible timer alerts. The
 * crossing guard is the load-bearing rule: only strictly-future
 * threshold crossings are armed, so opening a window (or resuming /
 * rescheduling) with the clock already below a threshold never
 * retro-fires it — and the end beep exists exactly once, at zero.
 */
import { describe, it, expect } from 'vitest';
import { computeBeepSchedule } from '../../src/editor/timer-audio.js';

describe('computeBeepSchedule', () => {
  it('schedules each future threshold plus the end beep, sorted', () => {
    const plan = computeBeepSchedule(10_000, true, [5, 3, 1]);
    expect(plan).toEqual([
      { atMs: 5_000, kind: 'threshold' },
      { atMs: 7_000, kind: 'threshold' },
      { atMs: 9_000, kind: 'threshold' },
      { atMs: 10_000, kind: 'end' },
    ]);
  });

  it('crossing guard: thresholds at or above remaining are dropped', () => {
    // 4s left: the 5s point is already past; 3 and 1 are future.
    const plan = computeBeepSchedule(4_000, true, [5, 3, 1]);
    expect(plan).toEqual([
      { atMs: 1_000, kind: 'threshold' },
      { atMs: 3_000, kind: 'threshold' },
      { atMs: 4_000, kind: 'end' },
    ]);
    // Exactly at a threshold does not re-fire it.
    expect(
      computeBeepSchedule(3_000, true, [3]).filter((b) => b.kind === 'threshold'),
    ).toEqual([]);
  });

  it('paused or expired clocks schedule nothing', () => {
    expect(computeBeepSchedule(10_000, false, [5, 3, 1])).toEqual([]);
    expect(computeBeepSchedule(0, true, [5, 3, 1])).toEqual([]);
    expect(computeBeepSchedule(-100, true, [5, 3, 1])).toEqual([]);
  });

  it('ignores junk thresholds and dedupes', () => {
    const plan = computeBeepSchedule(10_000, true, [3, 3, 0, -2, NaN]);
    expect(plan).toEqual([
      { atMs: 7_000, kind: 'threshold' },
      { atMs: 10_000, kind: 'end' },
    ]);
  });

  it('end beep fires even with no thresholds configured', () => {
    expect(computeBeepSchedule(2_500, true, [])).toEqual([{ atMs: 2_500, kind: 'end' }]);
  });
});
