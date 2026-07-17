// @vitest-environment node
/**
 * Web-edition installer download (web-download.ts): asset selection from a
 * real-shaped GitHub release listing, and platform/chip detection. The
 * asset list mirrors what electron-builder actually publishes — version
 * numbers in every name, plus .blockmap/.yml update-metadata siblings that
 * must never be picked.
 */
import { describe, it, expect } from 'vitest';
import {
  pickInstallerAsset,
  detectInstallerTarget,
  type ReleaseAsset,
} from '../../src/editor/web-download.js';

const asset = (name: string): ReleaseAsset => ({
  name,
  browser_download_url: `https://github.com/ant981228/cardmirror/releases/download/v0.1.0-beta.13/${name}`,
});

// A realistic beta release's asset listing.
const ASSETS: ReleaseAsset[] = [
  asset('CardMirror-0.1.0-beta.13-arm64.dmg'),
  asset('CardMirror-0.1.0-beta.13-arm64.dmg.blockmap'),
  asset('CardMirror-0.1.0-beta.13.dmg'),
  asset('CardMirror-0.1.0-beta.13.dmg.blockmap'),
  asset('CardMirror-Setup-0.1.0-beta.13.exe'),
  asset('CardMirror-Setup-0.1.0-beta.13.exe.blockmap'),
  asset('cardmirror-0.1.0-beta.13.AppImage'),
  asset('cardmirror-0.1.0-beta.13.pacman'),
  asset('latest-mac.yml'),
  asset('latest-linux.yml'),
  asset('latest.yml'),
];

describe('pickInstallerAsset', () => {
  it('picks each platform installer, never metadata siblings', () => {
    expect(pickInstallerAsset(ASSETS, 'win-x64')?.name).toBe('CardMirror-Setup-0.1.0-beta.13.exe');
    expect(pickInstallerAsset(ASSETS, 'mac-arm64')?.name).toBe('CardMirror-0.1.0-beta.13-arm64.dmg');
    expect(pickInstallerAsset(ASSETS, 'linux-appimage')?.name).toBe('cardmirror-0.1.0-beta.13.AppImage');
  });

  it('mac Intel picks the dmg WITHOUT the arm64 marker', () => {
    expect(pickInstallerAsset(ASSETS, 'mac-x64')?.name).toBe('CardMirror-0.1.0-beta.13.dmg');
  });

  it('a universal dmg wins for BOTH mac targets (post-universal releases)', () => {
    const universal = [
      ...ASSETS,
      { name: 'CardMirror-0.1.0-beta.15-universal.dmg', browser_download_url: 'u://dmg' },
    ] as typeof ASSETS;
    expect(pickInstallerAsset(universal, 'mac-arm64')?.name).toBe(
      'CardMirror-0.1.0-beta.15-universal.dmg',
    );
    expect(pickInstallerAsset(universal, 'mac-x64')?.name).toBe(
      'CardMirror-0.1.0-beta.15-universal.dmg',
    );
  });

  it('order independence: intel dmg is found even listed after arm64', () => {
    const reversed = [...ASSETS].reverse();
    expect(pickInstallerAsset(reversed, 'mac-x64')?.name).toBe('CardMirror-0.1.0-beta.13.dmg');
    expect(pickInstallerAsset(reversed, 'mac-arm64')?.name).toBe(
      'CardMirror-0.1.0-beta.13-arm64.dmg',
    );
  });

  it('returns null when the release has no matching asset', () => {
    expect(pickInstallerAsset([asset('latest.yml')], 'win-x64')).toBeNull();
    expect(pickInstallerAsset([], 'mac-arm64')).toBeNull();
  });
});

describe('detectInstallerTarget', () => {
  it('Windows → win-x64 (with or without userAgentData)', () => {
    expect(detectInstallerTarget({ uaDataPlatform: 'Windows' })).toBe('win-x64');
    expect(detectInstallerTarget({ platform: 'Win32', userAgent: 'Mozilla (Windows NT 10.0)' })).toBe(
      'win-x64',
    );
  });

  it('mac resolves by the high-entropy architecture hint', () => {
    expect(detectInstallerTarget({ uaDataPlatform: 'macOS', architecture: 'arm' })).toBe(
      'mac-arm64',
    );
    expect(detectInstallerTarget({ uaDataPlatform: 'macOS', architecture: 'x86' })).toBe('mac-x64');
  });

  it('mac WITHOUT an architecture signal is ambiguous → null (picker)', () => {
    // navigator.platform says "MacIntel" on Apple Silicon too — it must
    // never be trusted to mean Intel.
    expect(detectInstallerTarget({ platform: 'MacIntel', userAgent: 'Mac OS X' })).toBeNull();
  });

  it('Linux desktop → AppImage', () => {
    expect(
      detectInstallerTarget({ platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' }),
    ).toBe('linux-appimage');
  });

  it('phones/tablets are never a target (Android UA contains "linux")', () => {
    expect(
      detectInstallerTarget({ platform: 'Linux armv8l', userAgent: 'Linux; Android 15; Pixel' }),
    ).toBeNull();
    expect(detectInstallerTarget({ platform: 'iPhone', userAgent: 'iPhone OS 18_0' })).toBeNull();
    expect(detectInstallerTarget({ platform: 'iPad', userAgent: 'iPad; CPU OS 18_0' })).toBeNull();
  });
});
