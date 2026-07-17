/**
 * electron-builder afterSign hook: re-sign the mac app with the stable
 * self-signed release cert ("CardMirror Local Signing", created by
 * scripts/setup-signing.sh).
 *
 * Why a hook: electron-builder only accepts Apple-issued identity types
 * (Developer ID / Apple Development / …) — a self-signed cert passed via
 * CSC_NAME is rejected with "falling back to ad-hoc signature". So we
 * let electron-builder do its ad-hoc pass (which lays down the right
 * per-binary entitlements), then re-sign everything with the stable
 * cert, preserving those entitlements and the hardened-runtime flags.
 *
 * Why sign at all: an ad-hoc signature changes the app's code identity
 * every build, so TCC grants (microphone) are wiped by every update.
 * The stable cert keeps the designated requirement constant, so grants
 * persist across auto-updates. (Gatekeeper first-install friction is
 * unchanged — only notarization removes that.)
 *
 * No-ops when the identity isn't in the keychain (CI, contributor
 * machines) — those builds stay ad-hoc, exactly as before.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const IDENTITY = process.env.CM_SIGN_IDENTITY || 'CardMirror Local Signing';

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  try {
    const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    if (!identities.includes(IDENTITY)) {
      console.log(`  • sign-mac: identity "${IDENTITY}" not installed; keeping ad-hoc signature`);
      return;
    }
  } catch {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`  • sign-mac: re-signing with "${IDENTITY}" file=${appPath}`);
  // --deep re-signs nested helpers/frameworks; --preserve-metadata keeps
  // the entitlements and hardened-runtime flags electron-builder's pass
  // already applied per binary.
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--preserve-metadata=entitlements,flags',
      '--sign',
      IDENTITY,
      appPath,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • sign-mac: signature verified');
};
