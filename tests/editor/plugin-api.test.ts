// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createPluginApi } from '../../src/editor/plugin-api.js';
import { isPluginEnabled, setPluginEnabled } from '../../src/editor/plugins-store.js';

const deps = {
  appVersion: '0.1.0-test',
  getView: () => null,
  getDocIdentity: () => null,
  ensureDocId: () => null,
};

beforeEach(() => localStorage.clear());

describe('createPluginApi', () => {
  it('extractSelection reports no-active-doc without a view', () => {
    const api = createPluginApi('demo', deps);
    expect(api.extractSelection()).toEqual({ ok: false, error: 'no-active-doc' });
  });
  it('jumpToSource rejects garbage tokens', async () => {
    const api = createPluginApi('demo', deps);
    expect(await api.jumpToSource('garbage')).toEqual({ ok: false, error: 'bad-request' });
  });
  it('flow methods degrade off-desktop', async () => {
    const api = createPluginApi('demo', deps);
    expect(await api.flowApps()).toEqual([]);
    expect(await api.flowPost('ebb', '/x', {})).toEqual({ ok: false, error: 'unsupported' });
  });
  it('storage is per-plugin and JSON-durable', () => {
    const a = createPluginApi('a', deps);
    const b = createPluginApi('b', deps);
    a.storage.set('k', { n: 1 });
    expect(a.storage.get('k')).toEqual({ n: 1 });
    expect(b.storage.get('k')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('plugin:a')!)).toEqual({ k: { n: 1 } });
  });
});

describe('plugins-store', () => {
  it('defaults to disabled and persists the toggle', () => {
    expect(isPluginEnabled('x')).toBe(false);
    setPluginEnabled('x', true);
    expect(isPluginEnabled('x')).toBe(true);
    setPluginEnabled('x', false);
    expect(isPluginEnabled('x')).toBe(false);
  });
});
