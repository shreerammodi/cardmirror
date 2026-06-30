import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';

// SettingsStore tolerates the absence of localStorage / window (its
// load + persist are try/caught), so a fresh instance boots to DEFAULTS
// in the node test env.

describe('settings export', () => {
  it('excludes the Anthropic API key but keeps everything else', () => {
    const s = new SettingsStore();
    s.set('anthropicApiKey', 'sk-secret');
    s.set('commentAuthor', 'Alice');
    const out = s.exportObject();
    expect('anthropicApiKey' in out).toBe(false);
    expect(out['commentAuthor']).toBe('Alice');
    expect(out['ribbonKeyOverrides']).toBeDefined();
  });

  it('excludes the Google Translate key and MyMemory email', () => {
    const s = new SettingsStore();
    s.set('googleTranslateApiKey', 'g-secret');
    s.set('myMemoryEmail', 'me@example.com');
    s.set('translationProvider', 'google');
    const out = s.exportObject();
    expect('googleTranslateApiKey' in out).toBe(false);
    expect('myMemoryEmail' in out).toBe(false);
    // Non-secret translation settings still export.
    expect(out['translationProvider']).toBe('google');
  });
});

describe('settings import (replaceAll)', () => {
  it('overwrites listed fields and preserves the current API key', () => {
    const s = new SettingsStore();
    s.set('anthropicApiKey', 'keep-me');
    s.set('commentAuthor', 'Old');
    s.replaceAll({ commentAuthor: 'New' });
    expect(s.get('commentAuthor')).toBe('New');
    expect(s.get('anthropicApiKey')).toBe('keep-me');
  });

  it('preserves the Google key and MyMemory email across import', () => {
    const s = new SettingsStore();
    s.set('googleTranslateApiKey', 'keep-google');
    s.set('myMemoryEmail', 'keep@example.com');
    // An import that even tries to set them must not overwrite.
    s.replaceAll({ googleTranslateApiKey: 'evil', myMemoryEmail: 'evil@x.com', commentAuthor: 'X' });
    expect(s.get('googleTranslateApiKey')).toBe('keep-google');
    expect(s.get('myMemoryEmail')).toBe('keep@example.com');
    expect(s.get('commentAuthor')).toBe('X');
  });

  it('fills defaults for missing fields and drops unknown keys', () => {
    const s = new SettingsStore();
    s.set('commentAuthor', 'Set');
    s.replaceAll({ navWidth: 300, bogusField: 123 });
    expect(s.get('navWidth')).toBe(300);
    expect(s.get('commentAuthor')).toBe('You'); // missing in import → default
    expect('bogusField' in (s.all() as Record<string, unknown>)).toBe(false);
  });

  it('coerces / clamps garbage values via sanitize', () => {
    const s = new SettingsStore();
    s.replaceAll({
      navWidth: 999999,
      ribbonKeyOverrides: 'not-an-object',
      keyboardMacros: 'nope',
    });
    expect(s.get('navWidth')).toBe(800); // clamped to max
    expect(s.get('ribbonKeyOverrides')).toEqual({});
    expect(s.get('keyboardMacros')).toEqual([]);
  });

  it('accessibilityTreeEnabled: defaults off and only an explicit boolean true sticks', () => {
    // Mirrors the main-process pref's fail-safe: anything but `true` reads as off,
    // so a restored/garbled backup can never silently re-enable the AX crash path.
    const def = new SettingsStore();
    expect(def.get('accessibilityTreeEnabled')).toBe(false); // default
    const garbage = new SettingsStore();
    garbage.replaceAll({ accessibilityTreeEnabled: 'yes' } as never);
    expect(garbage.get('accessibilityTreeEnabled')).toBe(false);
    const on = new SettingsStore();
    on.replaceAll({ accessibilityTreeEnabled: true } as never);
    expect(on.get('accessibilityTreeEnabled')).toBe(true);
  });

  it('fileSearchFormats: defaults to both, accepts cmir/docx, rejects garbage', () => {
    const s = new SettingsStore();
    expect(s.get('fileSearchFormats')).toBe('both'); // default
    s.replaceAll({ fileSearchFormats: 'cmir' });
    expect(s.get('fileSearchFormats')).toBe('cmir');
    s.replaceAll({ fileSearchFormats: 'docx' });
    expect(s.get('fileSearchFormats')).toBe('docx');
    s.replaceAll({ fileSearchFormats: 'nonsense' });
    expect(s.get('fileSearchFormats')).toBe('both'); // garbage → default
  });

  it('round-trips an export back through import', () => {
    const a = new SettingsStore();
    a.set('commentAuthor', 'Round');
    a.set('keyboardMacros', [{ id: 'm1', key: 'Mod-Shift-j', text: 'hi' }]);
    a.set('anthropicApiKey', 'a-key');
    const b = new SettingsStore();
    b.set('anthropicApiKey', 'b-key');
    b.replaceAll(a.exportObject());
    expect(b.get('commentAuthor')).toBe('Round');
    expect(b.get('keyboardMacros')).toEqual([{ id: 'm1', key: 'Mod-Shift-j', text: 'hi' }]);
    expect(b.get('anthropicApiKey')).toBe('b-key'); // not carried by export
  });
});

// Document-text colors (analytic / undertag) are backed by
// `displayColors` and shown in BOTH the Appearance and Accessibility
// pickers. They used to be settable via `customColorOverrides` too,
// where (applied last) they won — but that left the Appearance picker
// inert. They're now unified onto displayColors; sanitize migrates any
// legacy override into displayColors and drops it from the overrides
// blob.
describe('document-text color migration', () => {
  it('folds a legacy customColorOverrides analytic color into displayColors', () => {
    const s = new SettingsStore();
    s.replaceAll({
      displayColors: { analytic: '#1f3864', undertag: '#385623' },
      customColorOverrides: { 'pmd-color-analytic': '#ff0000' },
    });
    // The override value wins (it's what actually rendered before).
    expect(s.get('displayColors').analytic).toBe('#ff0000');
    // …and it's removed from the overrides blob so nothing re-clobbers it.
    expect('pmd-color-analytic' in s.get('customColorOverrides')).toBe(false);
  });

  it('keeps non-document overrides in customColorOverrides untouched', () => {
    const s = new SettingsStore();
    s.replaceAll({
      customColorOverrides: {
        'pmd-c-accent': '#123456',
        'pmd-color-undertag': '#00ff00',
      },
    });
    expect(s.get('customColorOverrides')['pmd-c-accent']).toBe('#123456');
    expect('pmd-color-undertag' in s.get('customColorOverrides')).toBe(false);
    expect(s.get('displayColors').undertag).toBe('#00ff00');
  });

  it('leaves displayColors at its own value when there is no legacy override', () => {
    const s = new SettingsStore();
    s.replaceAll({
      displayColors: { analytic: '#abcdef', undertag: '#385623' },
      customColorOverrides: {},
    });
    expect(s.get('displayColors').analytic).toBe('#abcdef');
  });
});

describe('defaultZoomPct (the open-at body-zoom default)', () => {
  it('clamps to 50–200% and rounds to the nearest 10', () => {
    const over = new SettingsStore();
    over.replaceAll({ defaultZoomPct: 500 } as never);
    expect(over.get('defaultZoomPct')).toBe(200);

    const under = new SettingsStore();
    under.replaceAll({ defaultZoomPct: 17 } as never);
    expect(under.get('defaultZoomPct')).toBe(50);

    const rounded = new SettingsStore();
    rounded.replaceAll({ defaultZoomPct: 135 } as never);
    expect(rounded.get('defaultZoomPct')).toBe(140);
  });

  it('defaults to 100', () => {
    expect(new SettingsStore().get('defaultZoomPct')).toBe(100);
  });
});

describe('preset filename prefixes', () => {
  it('default to SEND_ / READ_ / MARKED_', () => {
    const s = new SettingsStore();
    expect(s.get('sendDocPrefix')).toBe('SEND_');
    expect(s.get('readDocPrefix')).toBe('READ_');
    expect(s.get('markedDocPrefix')).toBe('MARKED_');
  });

  it('accept custom strings (including empty)', () => {
    const s = new SettingsStore();
    s.replaceAll({ sendDocPrefix: 'OUT-', readDocPrefix: '', markedDocPrefix: 'MK_' } as never);
    expect(s.get('sendDocPrefix')).toBe('OUT-');
    expect(s.get('readDocPrefix')).toBe('');
    expect(s.get('markedDocPrefix')).toBe('MK_');
  });
});
