/**
 * The "Cycle Timer Preset" command and the Settings profile picker both go
 * through `timer-profile.ts`. Cover the cycle order (College → High School →
 * Pomodoro, wrapping) and that switching a profile applies its saved durations
 * to the live settings + refills the prep clocks.
 */
import { describe, it, expect } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import {
  cycleTimerProfile,
  applyTimerProfile,
  TIMER_PROFILE_LABELS,
} from '../../src/editor/timer-profile.js';
import { getTimerState } from '../../src/editor/timer-state.js';

const MIN = 60 * 1000;

/** Known per-profile durations so the cycle is deterministic regardless of the
 *  shipped defaults. */
function seedProfiles(): void {
  settings.set('timerProfiles', {
    highSchool: { speechPresets: [3, 5, 8], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5], prepMinutes: 0 },
  } as never);
}

describe('timer profile cycling', () => {
  it('cycles College → High School → Pomodoro → College, applying each profile', () => {
    seedProfiles();
    settings.set('timerProfile', 'college');

    expect(cycleTimerProfile()).toBe('highSchool');
    expect(settings.get('timerProfile')).toBe('highSchool');
    expect(settings.get('timerSpeechPresets')).toEqual([3, 5, 8]);
    expect(settings.get('timerPrepMinutes')).toBe(8);

    expect(cycleTimerProfile()).toBe('pomodoro');
    expect(settings.get('timerSpeechPresets')).toEqual([25, 15, 5]);
    expect(settings.get('timerPrepMinutes')).toBe(0);

    expect(cycleTimerProfile()).toBe('college'); // wraps
    expect(settings.get('timerSpeechPresets')).toEqual([3, 6, 9]);
    expect(settings.get('timerPrepMinutes')).toBe(10);
  });

  it('applyTimerProfile refills both prep clocks to the profile total', () => {
    seedProfiles();
    applyTimerProfile('college'); // 10 min prep
    expect(getTimerState().affPrepBaseRemainingMs).toBe(10 * MIN);
    expect(getTimerState().negPrepBaseRemainingMs).toBe(10 * MIN);
  });

  it('labels every profile', () => {
    expect(TIMER_PROFILE_LABELS).toEqual({
      highSchool: 'High school',
      college: 'College',
      pomodoro: 'Pomodoro',
    });
  });
});
