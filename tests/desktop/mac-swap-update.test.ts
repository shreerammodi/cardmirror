// @vitest-environment node
/**
 * macOS bundle-swap updater (2026-07-16, Tauri's mechanism ported —
 * see mac-swap-update.ts). The generated helper script IS the
 * safety-critical artifact, so its content is what gets asserted:
 * wait-for-exit, verified extraction, quarantine strip, backup-and-
 * restore-on-failure, relaunch. Plus the self-updatability gate
 * (bundle shape, translocation, writability).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSwapScript,
  bundlePathFromExe,
  macBundleSelfUpdatable,
} from '../../apps/desktop/src/mac-swap-update.js';

describe('bundlePathFromExe', () => {
  it('resolves the .app bundle from the executable path', () => {
    expect(bundlePathFromExe('/Applications/CardMirror.app/Contents/MacOS/cardmirror')).toBe(
      '/Applications/CardMirror.app',
    );
  });

  it('returns null for a non-bundle layout', () => {
    expect(bundlePathFromExe('/usr/local/bin/deep/nested/cardmirror')).toBeNull();
  });
});

describe('macBundleSelfUpdatable', () => {
  it('rejects Gatekeeper-translocated copies', () => {
    expect(
      macBundleSelfUpdatable(
        '/private/var/folders/x/AppTranslocation/ABC/d/CardMirror.app/Contents/MacOS/cardmirror',
      ),
    ).toBe(false);
  });

  it('accepts a writable bundle; rejects an unwritable parent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-swap-'));
    try {
      const bundle = path.join(dir, 'CardMirror.app');
      mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
      const exe = path.join(bundle, 'Contents', 'MacOS', 'cardmirror');
      expect(macBundleSelfUpdatable(exe)).toBe(true);
      chmodSync(bundle, 0o555);
      try {
        expect(macBundleSelfUpdatable(exe)).toBe(false);
      } finally {
        chmodSync(bundle, 0o755);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildSwapScript', () => {
  const script = buildSwapScript({
    pid: 4242,
    zipPath: "/tmp/it's a test/CardMirror-1.0-universal-mac.zip",
    appBundlePath: '/Applications/CardMirror.app',
  });

  it('waits for the app to exit before touching anything', () => {
    expect(script).toContain('PID=4242');
    expect(script).toContain('kill -0 "$PID"');
    expect(script).toContain('app never exited');
  });

  it('quotes paths safely (spaces and single quotes)', () => {
    expect(script).toContain(`'/tmp/it'\\''s a test/CardMirror-1.0-universal-mac.zip'`);
    expect(script).toContain(`'/Applications/CardMirror.app'`);
  });

  it('strips quarantine from the extracted bundle before the swap', () => {
    const stripIdx = script.indexOf('xattr -dr com.apple.quarantine');
    const swapIdx = script.indexOf('mv "$APP" "$STAGE/previous.app"');
    expect(stripIdx).toBeGreaterThan(0);
    expect(swapIdx).toBeGreaterThan(stripIdx);
  });

  it('restores the old bundle when the swap fails, and always relaunches', () => {
    expect(script).toContain('fail_restore');
    expect(script).toContain('mv "$STAGE/previous.app" "$APP"');
    expect(script).toContain('open -n "$APP"');
  });

  it('extraction failure aborts before the old bundle is touched', () => {
    const extractIdx = script.indexOf('ditto -x -k');
    const backupIdx = script.indexOf('mv "$APP" "$STAGE/previous.app"');
    expect(extractIdx).toBeGreaterThan(0);
    expect(backupIdx).toBeGreaterThan(extractIdx);
  });
});
