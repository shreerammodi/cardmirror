// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readAccessibilityTreeEnabled,
  writeAccessibilityTreeEnabled,
  ACCESSIBILITY_PREF_FILE,
} from '../../apps/desktop/src/accessibility-pref.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-ax-pref-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('accessibility-pref', () => {
  it('defaults to DISABLED (false) when no pref file exists — fail-safe', () => {
    // The renderer accessibility tree is the crash pathway; a missing pref
    // must keep it OFF so we never re-expose the crash by accident.
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
  });

  it('round-trips an enabled pref', () => {
    writeAccessibilityTreeEnabled(dir, true);
    expect(existsSync(path.join(dir, ACCESSIBILITY_PREF_FILE))).toBe(true);
    expect(readAccessibilityTreeEnabled(dir)).toBe(true);
  });

  it('round-trips back to disabled', () => {
    writeAccessibilityTreeEnabled(dir, true);
    writeAccessibilityTreeEnabled(dir, false);
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
  });

  it('returns false (safe default) on a corrupt pref file', () => {
    writeFileSync(path.join(dir, ACCESSIBILITY_PREF_FILE), '{ this is not json');
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
  });

  it('returns false when the field has the wrong type', () => {
    writeFileSync(
      path.join(dir, ACCESSIBILITY_PREF_FILE),
      JSON.stringify({ accessibilityTreeEnabled: 'yes' }),
    );
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
  });

  it('treats only an explicit boolean true as enabled', () => {
    writeFileSync(path.join(dir, ACCESSIBILITY_PREF_FILE), JSON.stringify({}));
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
    writeFileSync(
      path.join(dir, ACCESSIBILITY_PREF_FILE),
      JSON.stringify({ accessibilityTreeEnabled: 1 }),
    );
    expect(readAccessibilityTreeEnabled(dir)).toBe(false);
  });

  it('returns false when reading from a non-existent directory', () => {
    expect(readAccessibilityTreeEnabled(path.join(dir, 'does', 'not', 'exist'))).toBe(false);
  });
});
