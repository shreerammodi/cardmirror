/**
 * Machine-local pref controlling whether Chromium builds the renderer
 * accessibility tree.
 *
 * Why this exists: Electron 42 / Chromium 148 has a deterministic crash in
 * Blink's accessibility serialization (`AXBlockFlowData::ComputeNeighborOnLine`,
 * a `CHECK(index < Size())` in the new AXBlockFlowIterator line-navigation
 * code) that fires whenever an assistive-tech / UI-Automation client (screen
 * reader, Windows Voice Access, etc.) turns the accessibility tree on. We
 * default the tree OFF via the `--disable-renderer-accessibility` Chromium
 * switch, which `main.ts` appends at startup unless this pref says otherwise.
 *
 * The switch is read by Chromium at process start — BEFORE the renderer (and
 * therefore the renderer-owned settings store) exists — so the value has to
 * live in a tiny main-process-readable file, not in the normal settings JSON.
 * The renderer settings toggle writes this file via IPC and prompts a restart.
 *
 * Fail-safe rule: anything other than an explicit `true` reads as DISABLED, so
 * a missing / corrupt / wrong-shaped file can never silently re-expose the
 * crash pathway.
 *
 * Pure module (no `electron` import) so it's unit-testable; `main.ts` supplies
 * `app.getPath('userData')` as the directory.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

export const ACCESSIBILITY_PREF_FILE = 'accessibility-pref.json';

interface AccessibilityPref {
  /** When explicitly `true`, the renderer accessibility tree is allowed
   *  (the user opted back in, accepting the known crash pathway). Any other
   *  value — including a missing file — means DISABLED. */
  accessibilityTreeEnabled: boolean;
}

/** Read whether the renderer accessibility tree is enabled. Returns `false`
 *  (disabled — the safe default) on a missing, unreadable, corrupt, or
 *  wrong-shaped pref file. */
export function readAccessibilityTreeEnabled(userDataDir: string): boolean {
  try {
    const raw = readFileSync(join(userDataDir, ACCESSIBILITY_PREF_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AccessibilityPref>;
    return parsed?.accessibilityTreeEnabled === true;
  } catch {
    return false;
  }
}

/** Persist the renderer-accessibility-tree preference. Atomic (temp + rename)
 *  so a crash mid-write can't leave a half-written file that would read as the
 *  unsafe default's opposite — though even a torn read falls back to disabled. */
export function writeAccessibilityTreeEnabled(
  userDataDir: string,
  enabled: boolean,
): void {
  mkdirSync(userDataDir, { recursive: true });
  const target = join(userDataDir, ACCESSIBILITY_PREF_FILE);
  const tmp = `${target}.tmp`;
  const body: AccessibilityPref = { accessibilityTreeEnabled: enabled === true };
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, target);
}
