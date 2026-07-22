// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPluginRegistry,
  registerPluginDefinition,
  resetPluginRegistryForTests,
} from '../../src/editor/plugin-registry.js';
import {
  buildRibbonKeymap,
  getRibbonCommand,
  ribbonCommandForKey,
  commandLabelFor,
  commandAliasesFor,
} from '../../src/editor/ribbon-commands.js';
import { availableRibbonCommandIds } from '../../src/editor/ribbon-availability.js';
import type { CardMirrorPluginApi } from '../../src/editor/plugin-api.js';

const stubApi = {} as CardMirrorPluginApi;

function registerDemo(run: () => void): void {
  installPluginRegistry(() => stubApi);
  registerPluginDefinition({
    id: 'demo',
    name: 'Demo',
    apiVersion: 1,
    commands: [
      { id: 'demo.hello', label: 'Say Hello', keywords: ['greet'], defaultKey: 'Mod-Alt-9', run },
    ],
  });
}

afterEach(() => resetPluginRegistryForTests());

describe('plugin commands in the chokepoints', () => {
  it('appear in availableRibbonCommandIds', () => {
    registerDemo(() => {});
    expect(availableRibbonCommandIds()).toContain('demo.hello');
  });
  it('resolve labels and keywords through the fallback helpers', () => {
    registerDemo(() => {});
    expect(commandLabelFor('demo.hello')).toBe('Say Hello');
    expect(commandAliasesFor('demo.hello')).toEqual(['greet']);
    // Static ids keep working through the same helpers.
    expect(typeof commandLabelFor('sendToFlowColumn')).toBe('string');
  });
  it('getRibbonCommand runs the plugin run fn', () => {
    const run = vi.fn();
    registerDemo(run);
    const cmd = getRibbonCommand('demo.hello');
    expect(cmd(null as never, undefined, undefined)).toBe(true);
    expect(run).toHaveBeenCalled();
  });
  it('default keys land in the keymap and reverse-resolve', () => {
    registerDemo(() => {});
    expect(buildRibbonKeymap({})['Mod-Alt-9']).toBeDefined();
    expect(ribbonCommandForKey('Mod-Alt-9')).toBe('demo.hello');
  });
  it('overrides rebind plugin commands', () => {
    registerDemo(() => {});
    const overrides = { 'demo.hello': 'Mod-Alt-8' };
    expect(buildRibbonKeymap(overrides)['Mod-Alt-8']).toBeDefined();
    expect(buildRibbonKeymap(overrides)['Mod-Alt-9']).toBeUndefined();
    expect(ribbonCommandForKey('Mod-Alt-8', overrides)).toBe('demo.hello');
  });
});
