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
  it('a plugin defaultKey never steals a static DEFAULT key', () => {
    const run = vi.fn();
    installPluginRegistry(() => stubApi);
    registerPluginDefinition({
      id: 'demo',
      name: 'Demo',
      apiVersion: 1,
      // F4 is setPocket's DEFAULT_RIBBON_KEYS binding — the collision case.
      commands: [{ id: 'demo.steal', label: 'Steal F4', defaultKey: 'F4', run }],
    });
    const km = buildRibbonKeymap({});
    expect(km['F4']).toBeDefined();
    // Whatever F4 fires must not be the plugin command: the plugin
    // Command always calls `run` and never throws (runPluginCommand
    // swallows), while the static command may throw on a null state —
    // irrelevant, only "did the plugin run" matters.
    try {
      km['F4']!(null as never, undefined, undefined);
    } catch {
      /* static command touched the (absent) editor state */
    }
    expect(run).not.toHaveBeenCalled();
    expect(ribbonCommandForKey('F4')).toBe('setPocket');
  });
});
