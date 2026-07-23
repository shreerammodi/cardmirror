// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/editor/text-prompt.js', () => ({ confirmDialog: vi.fn() }));
vi.mock('../../src/editor/settings.js', () => ({ settings: { get: () => true } }));
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => ({
    pluginList: () => Promise.resolve([{ id: 'demo', name: 'Demo', version: '1.0.0' }]),
  }),
}));

import { renderPluginsPanel } from '../../src/editor/plugins-settings-ui.js';

/** Wait out the panel's initial `refresh()` microtask. */
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('plugins settings panel styling', () => {
  it('dresses its widgets in the shared settings classes', async () => {
    window.__registerCardMirrorPlugin = (() => ({ ok: true })) as never;
    const el = document.createElement('div');
    renderPluginsPanel(el);
    await settled();

    expect(el.querySelector('.pmd-plugins-input')!.classList).toContain('pmd-settings-text');
    // Every button in the panel — install, per-plugin actions, dev loader —
    // uses the settings button style rather than the bare UA control.
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(2);
    expect(buttons.every((b) => b.classList.contains('pmd-install-info-btn'))).toBe(true);
    expect(el.querySelector('.pmd-plugins-row input')!.classList).toContain('pmd-settings-toggle');
    expect(el.querySelectorAll('.pmd-settings-section-title').length).toBe(3);
  });

  it('renders the gated message as a styled placeholder, not bare text', () => {
    window.__registerCardMirrorPlugin = undefined;
    const el = document.createElement('div');
    renderPluginsPanel(el);
    expect(el.querySelector('.pmd-settings-empty')!.textContent).toBe(
      'Restart CardMirror to activate plugins.',
    );
  });
});
