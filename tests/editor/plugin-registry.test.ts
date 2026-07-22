// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
