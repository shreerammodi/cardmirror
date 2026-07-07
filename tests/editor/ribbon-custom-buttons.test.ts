/**
 * Custom ribbon buttons — the `ribbonCustomButtons` setting sanitizer. The
 * ribbon renders at most MAX_RIBBON_CUSTOM_BUTTONS buttons, each `{ command,
 * icon }`; sanitize keeps well-formed entries, drops malformed ones, and caps
 * the count. (Command/icon are validated loosely here to avoid an import
 * cycle; the ribbon skips unknown commands at render time.)
 */

import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  MAX_RIBBON_CUSTOM_BUTTONS,
  type RibbonCustomButton,
} from '../../src/editor/settings.js';

describe('ribbonCustomButtons sanitize', () => {
  it('defaults to empty and rejects non-arrays', () => {
    const s = new SettingsStore();
    expect(s.get('ribbonCustomButtons')).toEqual([]);
    s.replaceAll({ ribbonCustomButtons: 'nope' as unknown as RibbonCustomButton[] });
    expect(s.get('ribbonCustomButtons')).toEqual([]);
  });

  it('keeps well-formed entries, drops malformed ones, caps the count', () => {
    const s = new SettingsStore();
    s.replaceAll({
      ribbonCustomButtons: [
        { command: 'toggleReadMode', icon: 'star' },
        { command: '', icon: 'flag' }, // empty command → dropped
        { command: 'x', icon: '' }, // empty icon → dropped
        { command: 'y' }, // missing icon → dropped
        'nope', // not an object → dropped
        { command: 'a', icon: 'bold' },
        { command: 'b', icon: 'italic' },
        { command: 'c', icon: 'check' },
        { command: 'd', icon: 'heart' },
        { command: 'e', icon: 'zap' },
        { command: 'f', icon: 'bell' }, // 7th valid → dropped by the cap
      ] as unknown as RibbonCustomButton[],
    });
    const out = s.get('ribbonCustomButtons');
    expect(out).toHaveLength(MAX_RIBBON_CUSTOM_BUTTONS); // 6
    expect(out[0]).toEqual({ command: 'toggleReadMode', icon: 'star' });
    expect(out.every((b) => !!b.command && !!b.icon)).toBe(true);
    // The 7th valid entry (bell) was cut by the cap, not the malformed ones.
    expect(out.map((b) => b.icon)).not.toContain('bell');
  });
});
