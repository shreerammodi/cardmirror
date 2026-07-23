import { describe, expect, it } from 'vitest';
import {
  parseRepoRef,
  compareVersions,
  validateManifest,
  checkInstallCollision,
} from '../../apps/desktop/src/plugin-manager.js';

describe('parseRepoRef', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseRepoRef('smodi/cardmirror-ebb')).toEqual({ owner: 'smodi', repo: 'cardmirror-ebb' });
  });
  it('accepts full GitHub URLs, with .git and trailing paths', () => {
    expect(parseRepoRef('https://github.com/smodi/cardmirror-ebb')).toEqual({ owner: 'smodi', repo: 'cardmirror-ebb' });
    expect(parseRepoRef('https://github.com/smodi/cardmirror-ebb.git')).toEqual({ owner: 'smodi', repo: 'cardmirror-ebb' });
    expect(parseRepoRef('https://github.com/smodi/cardmirror-ebb/releases')).toEqual({ owner: 'smodi', repo: 'cardmirror-ebb' });
  });
  it('rejects everything else', () => {
    expect(parseRepoRef('https://gitlab.com/a/b')).toBeNull();
    expect(parseRepoRef('not a ref')).toBeNull();
    expect(parseRepoRef('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders release triples', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });
  it('release beats its own prerelease; prereleases order numerically', () => {
    expect(compareVersions('0.1.0', '0.1.0-beta.17')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-beta.18', '0.1.0-beta.17')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-beta.2', '0.1.0-beta.10')).toBeLessThan(0);
  });
});

describe('validateManifest', () => {
  const good = {
    id: 'cardmirror-ebb',
    name: 'ebb Flow Integration',
    version: '0.1.0',
    apiVersion: 1,
  };
  it('accepts a minimal valid manifest', () => {
    expect(validateManifest(good)).toEqual({ ok: true, manifest: expect.objectContaining(good) });
  });
  it('rejects bad ids, missing fields, wrong apiVersion', () => {
    expect(validateManifest({ ...good, id: '../evil' }).ok).toBe(false);
    expect(validateManifest({ ...good, id: undefined }).ok).toBe(false);
    expect(validateManifest({ ...good, apiVersion: 99 }).ok).toBe(false);
    expect(validateManifest({ ...good, version: 7 }).ok).toBe(false);
  });
  it('rejects Windows reserved device ids', () => {
    expect(validateManifest({ ...good, id: 'con' }).ok).toBe(false);
    expect(validateManifest({ ...good, id: 'com1' }).ok).toBe(false);
  });
});

describe('checkInstallCollision', () => {
  const existing = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, repo: 'owner/demo' };
  it('allows a same-repo reinstall (the update path)', () => {
    expect(checkInstallCollision(existing, 'owner/demo')).toBeNull();
  });
  it('blocks a different repo claiming an installed id', () => {
    expect(checkInstallCollision(existing, 'evil/demo')).toContain('already owns the id');
  });
  it('allows a fresh id with no existing install', () => {
    expect(checkInstallCollision(undefined, 'owner/demo')).toBeNull();
  });
  it('blocks when the existing install has no stored repo', () => {
    expect(checkInstallCollision({ ...existing, repo: undefined }, 'owner/demo')).toContain('already owns the id');
  });
});
