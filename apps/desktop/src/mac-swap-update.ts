/**
 * macOS self-update by bundle swap — Tauri's update mechanism, ported
 * (2026-07-16, modeled on ebb's flow after the update-UX comparison).
 *
 * Squirrel.Mac (electron-updater's installer) refuses unsigned apps, so
 * unsigned/self-signed CardMirror builds can't use `quitAndInstall` on
 * macOS. Instead we do exactly what Tauri's updater does:
 *
 *   1. electron-updater STAGES the update (downloads the release .zip
 *      and verifies its sha512 against the release metadata) — that
 *      part works unsigned; only the Squirrel install step doesn't.
 *   2. On the user's install-confirm we spawn a tiny detached shell
 *      script and quit. The script waits for the app to exit, extracts
 *      the zip, strips any quarantine attribute (defensive — files we
 *      download ourselves never carry one, which is why Gatekeeper
 *      never re-assesses the swapped bundle), moves the old bundle
 *      aside, moves the new one in, and relaunches. Any failure
 *      restores the old bundle — the invariant is "you always have a
 *      launchable CardMirror".
 *
 * Combined with the stable self-signed release cert (see
 * scripts/setup-signing.sh), TCC grants (microphone) persist across
 * these swaps, which is one thing even ebb's ad-hoc signing loses.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `/Applications/CardMirror.app` from the running executable path
 *  (`…/CardMirror.app/Contents/MacOS/cardmirror`), or null when the
 *  layout isn't a normal bundle. */
export function bundlePathFromExe(exePath: string): string | null {
  const bundle = path.resolve(exePath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/** Whether this install can self-update: a real .app bundle, not a
 *  Gatekeeper-translocated copy (read-only randomized mount), and both
 *  the bundle and its parent directory are writable by this user. */
export function macBundleSelfUpdatable(exePath: string): boolean {
  const bundle = bundlePathFromExe(exePath);
  if (!bundle) return false;
  if (bundle.includes('/AppTranslocation/')) return false;
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Single-quote a string for safe embedding in bash. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SwapArgs {
  /** The running app's pid — the script waits for it to exit. */
  pid: number;
  /** The staged update zip (electron-updater's verified download). */
  zipPath: string;
  /** The installed bundle to replace (e.g. /Applications/CardMirror.app). */
  appBundlePath: string;
}

/** The swap helper script. Exported for tests — the script IS the
 *  safety-critical artifact, so its content is what gets asserted. */
export function buildSwapScript(a: SwapArgs): string {
  return `#!/bin/bash
# CardMirror self-update helper (generated; safe to delete).
set -u
PID=${a.pid}
ZIP=${shq(a.zipPath)}
APP=${shq(a.appBundlePath)}
LOG="\${TMPDIR:-/tmp}/cardmirror-update.log"
exec >>"$LOG" 2>&1
echo "== $(date) swap start pid=$PID app=$APP"

# Wait (up to 5 minutes) for the app to fully exit.
for _ in $(seq 1 600); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  echo "app never exited; aborting"
  exit 1
fi

STAGE=$(mktemp -d "\${TMPDIR:-/tmp}/cardmirror-update.XXXXXX") || exit 1

fail_restore() {
  echo "$1"
  [ -d "$STAGE/previous.app" ] && [ ! -d "$APP" ] && mv "$STAGE/previous.app" "$APP"
  rm -rf "$STAGE"
  open "$APP" 2>/dev/null
  exit 1
}

ditto -x -k "$ZIP" "$STAGE" || fail_restore "extract failed"
NEWAPP="$STAGE/$(basename "$APP")"
if [ ! -d "$NEWAPP" ]; then
  NEWAPP=$(find "$STAGE" -maxdepth 1 -name "*.app" -print -quit)
fi
if [ -z "$NEWAPP" ] || [ ! -d "$NEWAPP" ]; then
  fail_restore "no .app in update zip"
fi

# Defensive: our own download never carries quarantine, but strip it in
# case anything upstream stamped it — a quarantined swap would send the
# user through Gatekeeper again.
xattr -dr com.apple.quarantine "$NEWAPP" 2>/dev/null || true

mv "$APP" "$STAGE/previous.app" || fail_restore "could not move old bundle aside"
if ! mv "$NEWAPP" "$APP"; then
  fail_restore "swap failed"
fi

rm -rf "$STAGE"
echo "== swap done; relaunching"
open -n "$APP"
`;
}

/** Write the helper to a temp file and launch it detached; the caller
 *  quits the app immediately after. */
export function launchSwapHelper(a: SwapArgs): void {
  const scriptPath = path.join(os.tmpdir(), `cardmirror-update-${a.pid}.sh`);
  fs.writeFileSync(scriptPath, buildSwapScript(a), { mode: 0o755 });
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
