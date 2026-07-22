// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { createPluginApi } from '../../src/editor/plugin-api.js';
import { parseSourceToken } from '../../src/editor/plugin-source-token.js';
import { isPluginEnabled, setPluginEnabled } from '../../src/editor/plugins-store.js';

const deps = {
  appVersion: '0.1.0-test',
  getView: () => null,
  getDocIdentity: () => null,
  ensureDocId: () => null,
};

/** State-backed view stand-in with a cursor at `pos` (extraction reads
 *  view.state only). Mirrors the fakeView pattern in plugin-extract.test.ts. */
function fakeView(doc: PMNode, pos: number): EditorView {
  const state = EditorState.create({ doc });
  const sel = TextSelection.create(state.doc, pos);
  return { state: state.apply(state.tr.setSelection(sel)) } as unknown as EditorView;
}

beforeEach(() => localStorage.clear());

describe('createPluginApi', () => {
  it('extractSelection reports no-active-doc without a view', () => {
    const api = createPluginApi('demo', deps);
    expect(api.extractSelection()).toEqual({ ok: false, error: 'no-active-doc' });
  });
  it('extractSelection does not mint a docId when extraction fails', () => {
    // Body-only doc, cursor in the paragraph: no governing heading, so
    // extraction fails BEFORE any mint. A pristine file must stay pristine.
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('just prose')),
    ]);
    const ensureDocId = vi.fn(() => 'minted-id');
    const api = createPluginApi('demo', {
      ...deps,
      getView: () => fakeView(doc, 2),
      getDocIdentity: () => ({ docId: null, docTitle: 'T' }),
      ensureDocId,
    });
    const res = api.extractSelection();
    expect(res.ok).toBe(false);
    expect(ensureDocId).not.toHaveBeenCalled();
  });
  it('extractSelection mints once and stamps tokens on first success', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['block']!.create({ id: 'h-1' }, schema.text('A heading')),
    ]);
    const ensureDocId = vi.fn(() => 'minted-id');
    const api = createPluginApi('demo', {
      ...deps,
      getView: () => fakeView(doc, 2),
      getDocIdentity: () => ({ docId: null, docTitle: 'T' }),
      ensureDocId,
    });
    const res = api.extractSelection();
    if (!res.ok) throw new Error(res.error);
    expect(ensureDocId).toHaveBeenCalledTimes(1);
    expect(res.docId).toBe('minted-id');
    for (const item of res.items) {
      expect(parseSourceToken(item.source)!.docId).toBe('minted-id');
    }
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
