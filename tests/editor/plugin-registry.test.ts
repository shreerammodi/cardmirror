// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { showToast } from '../../src/editor/toast.js';
import {
  installPluginRegistry,
  registerPluginDefinition,
  pluginCommandIds,
  pluginCommandLabel,
  pluginDefaultKey,
  runPluginCommand,
  registeredPlugins,
  resetPluginRegistryForTests,
  type PluginDefinition,
} from '../../src/editor/plugin-registry.js';
import type { CardMirrorPluginApi } from '../../src/editor/plugin-api.js';

const stubApi = { showToast: () => {} } as unknown as CardMirrorPluginApi;

function def(over: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'demo',
    name: 'Demo',
    apiVersion: 1,
    commands: [
      { id: 'demo.hello', label: 'Say Hello', keywords: ['greet'], defaultKey: 'Mod-Alt-h', run: () => {} },
    ],
    ...over,
  };
}

afterEach(() => resetPluginRegistryForTests());

describe('plugin registry', () => {
  it('registers via the window global and exposes commands', () => {
    installPluginRegistry(() => stubApi);
    window.__registerCardMirrorPlugin!(def());
    expect(pluginCommandIds()).toEqual(['demo.hello']);
    expect(pluginCommandLabel('demo.hello')).toBe('Say Hello');
    expect(pluginDefaultKey('demo.hello')).toBe('Mod-Alt-h');
    expect(registeredPlugins()).toEqual([{ id: 'demo', name: 'Demo' }]);
  });
  it('rejects an unknown apiVersion', () => {
    installPluginRegistry(() => stubApi);
    const res = registerPluginDefinition(def({ apiVersion: 2 }));
    expect(res.ok).toBe(false);
    expect(pluginCommandIds()).toEqual([]);
  });
  it('rejects command ids without the plugin-id prefix', () => {
    installPluginRegistry(() => stubApi);
    const bad = def();
    bad.commands[0]!.id = 'other.hello';
    expect(registerPluginDefinition(bad).ok).toBe(false);
  });
  it('rejects duplicate plugin ids', () => {
    installPluginRegistry(() => stubApi);
    expect(registerPluginDefinition(def()).ok).toBe(true);
    expect(registerPluginDefinition(def()).ok).toBe(false);
  });
  it('rejects duplicate command ids within one definition', () => {
    installPluginRegistry(() => stubApi);
    const d = def();
    d.commands.push({ ...d.commands[0]! });
    expect(registerPluginDefinition(d).ok).toBe(false);
    expect(pluginCommandIds()).toEqual([]);
  });
  it('runs a command with the per-plugin api and survives a throwing run', () => {
    installPluginRegistry(() => stubApi);
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    const d = def();
    d.commands[0]!.run = run;
    registerPluginDefinition(d);
    expect(runPluginCommand('demo.hello')).toBe(true);
    expect(run).toHaveBeenCalledWith(stubApi);
    expect(runPluginCommand('missing.cmd')).toBe(false);
  });
  it('rejects non-string keywords and defaultKey types', () => {
    installPluginRegistry(() => stubApi);
    const k = def();
    (k.commands[0] as any).keywords = 42;
    expect(registerPluginDefinition(k).ok).toBe(false);
    const d = def();
    (d.commands[0] as any).defaultKey = 42;
    expect(registerPluginDefinition(d).ok).toBe(false);
    expect(pluginCommandIds()).toEqual([]);
  });
  it('rejects a malformed plugin id and a missing name', () => {
    installPluginRegistry(() => stubApi);
    expect(registerPluginDefinition(def({ id: 'a.b' } as any)).ok).toBe(false);
    expect(registerPluginDefinition(def({ name: '' } as any)).ok).toBe(false);
  });
  it('is immune to getter-swapped command arrays', () => {
    installPluginRegistry(() => stubApi);
    const clean = [{ id: 'demo.ok', label: 'Ok', run: () => {} }];
    const dirty = [{ id: 'other.hijack', label: 'Bad', run: () => {} }];
    let reads = 0;
    const d: any = { id: 'demo', name: 'Demo', apiVersion: 1 };
    Object.defineProperty(d, 'commands', { get: () => (reads++ === 0 ? clean : dirty) });
    registerPluginDefinition(d);
    expect(pluginCommandIds().includes('other.hijack')).toBe(false);
  });
  it('is immune to a stateful per-field getter swapping id after validation', () => {
    installPluginRegistry(() => stubApi);
    let reads = 0;
    const c: any = { label: 'Ok', run: () => {} };
    Object.defineProperty(c, 'id', { get: () => (reads++ === 0 ? 'demo.ok' : 'other.hijack') });
    const d: any = { id: 'demo', name: 'Demo', apiVersion: 1, commands: [c] };
    registerPluginDefinition(d);
    expect(pluginCommandIds().includes('other.hijack')).toBe(false);
    expect(pluginCommandIds().includes('demo.ok')).toBe(true);
  });
  it('toasts when an async run rejects', async () => {
    installPluginRegistry(() => stubApi);
    const d = def();
    d.commands[0]!.run = () => Promise.reject(new Error('boom'));
    registerPluginDefinition(d);
    expect(runPluginCommand('demo.hello')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Demo'));
  });
});
