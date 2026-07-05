// @vitest-environment jsdom
/**
 * UI-flow integration: startSessionFlow / endSessionFlow drive the real
 * seams (collab-hooks plugin source + transaction tagger) the way
 * index.ts does — including the M0 payoff: with read mode ON, a
 * partner's remote edit still lands because the tagger stamps
 * sync-origin on the binding's transactions before filterTransaction
 * runs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EditorState, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import {
  collabPluginSource,
  tagCollabTransaction,
} from '../../src/editor/collab/collab-hooks.js';
import { settings } from '../../src/editor/settings.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import * as collabUi from '../../src/editor/collab/collab-ui.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, sleep, simpleDoc, docText, typeAfter, mkView } from './_loro-helpers.js';

let mock: RoomsMock;

beforeAll(async () => {
  mock = await startRoomsMock();
  // Co-editing is desktop-only: the gate is hard-closed on a browser
  // host, so present as an Electron host before getHost() is first
  // resolved. The stub only needs to exist — kind is read off a field,
  // and every host method this flow touches is optional-chained.
  (window as unknown as { electronAPI?: unknown }).electronAPI = {};
  localStorage.setItem('pmd-collab', '1'); // open the gate (desktop path)
  settings.set('pairingRelayUrl', mock.url);
  settings.set('pairingRelayToken', mock.token);
  const chip = document.createElement('div');
  chip.id = 'collab-chip';
  chip.hidden = true;
  document.body.appendChild(chip);
  window.confirm = vi.fn(() => true); // legacy; end flow now uses the in-app overlay
});

/** Click a button in the active prompt overlay (endSessionFlow's
 *  confirm is an in-app dialog now — window.confirm never returns
 *  keyboard focus to the renderer on Windows/Linux Electron). */
function clickPromptButton(label: string): void {
  const btn = [...document.querySelectorAll('.pmd-route-overlay button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no prompt button labeled "${label}"`);
  btn.click();
}
afterAll(async () => {
  await mock.close();
  localStorage.removeItem('pmd-collab');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** index.ts's plugin assembly in miniature: read mode + whatever the
 *  collab plugin source supplies, with the dispatch tagger applied. */
function buildMiniPlugins(): Plugin[] {
  return [readModePlugin, ...(collabPluginSource()?.plugins() ?? [])];
}

function mkIndexStyleView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const state = EditorState.create({ doc: simpleDoc('shared prep doc contents'), plugins: buildMiniPlugins() });
  const view: EditorView = new EditorView(el, {
    state,
    dispatchTransaction(tx) {
      tagCollabTransaction(tx);
      view.updateState(view.state.apply(tx));
    },
  });
  return view;
}

describe('collab UI flows through the editor seams', () => {
  it('start → partner joins → read-mode host still receives edits → end', async () => {
    let hostView = mkIndexStyleView();
    const deps = {
      getView: () => hostView,
      refreshPlugins: () => {
        hostView.updateState(hostView.state.reconfigure({ plugins: buildMiniPlugins() }));
      },
      newSessionDoc: () => true,
    };

    // The start flow copies the share code to the clipboard; capture it.
    let shareCode = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => {
          shareCode = t;
          return Promise.resolve();
        },
      },
    });

    // Start a session on the host's current doc (window titled like a
    // real host: the flow publishes the doc name to the room's meta map).
    document.title = 'Aff Updates — CardMirror';
    await collabUi.startSessionFlow(deps);
    expect(collabUi.activeSession()).not.toBeNull();
    // Joiners name their unsaved copy from this (field bug: windows and
    // Sessions-list rows just said "collaboration session").
    expect(collabUi.activeSession()!.loroDoc.getMap('meta').get('title')).toBe('Aff Updates');
    expect(collabPluginSource()?.ownsUndo()).toBe(true);
    await settle();
    const chip = document.getElementById('collab-chip')!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain('Session');
    expect(shareCode.startsWith('cmshare1.')).toBe(true);

    // A partner joins with the share code (session layer directly — the
    // join *flow* differs only by the paste dialog).
    let partnerEnded = false;
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const partner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      flushMs: 25,
      minBackoffMs: 20,
      maxBackoffMs: 60,
      callbacks: { onEnded: () => (partnerEnded = true) },
    });
    const partnerView = mkView(partner.plugins());
    await settle();
    partner.start();
    await sleep(80);
    expect(docText(partnerView.state.doc)).toContain('shared prep doc contents');

    // Put the HOST in read mode, then the partner edits: the remote
    // transaction must land anyway (tagger stamps sync-origin; the M0
    // read-mode whitelist admits it).
    hostView.dispatch(hostView.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
    typeAfter(partnerView, 'prep doc', ' updated');
    await sleep(250);
    expect(docText(hostView.state.doc)).toContain('prep doc updated');
    // ...while the read-mode lock still blocks the host's own typing.
    const before = docText(hostView.state.doc);
    hostView.dispatch(hostView.state.tr.insertText('X', 2));
    expect(docText(hostView.state.doc)).toBe(before);

    // M4 read-mode clamp: session undo/redo are swallowed while
    // reading — Loro undo transactions carry the binding meta (→
    // sync-origin) and would otherwise sail through the read-mode
    // lock and revert real edits.
    const src = collabPluginSource()!;
    expect(src.undo(hostView.state, hostView.dispatch)).toBe(true);
    expect(docText(hostView.state.doc)).toBe(before);
    expect(src.redo(hostView.state, hostView.dispatch)).toBe(true);
    expect(docText(hostView.state.doc)).toBe(before);

    hostView.dispatch(hostView.state.tr.setMeta(PMD_READ_MODE_TOGGLE, false));

    // Host ends the session: partner is notified, seams clear, chip hides.
    // The confirm is an in-app overlay — click it like a user would.
    const endP = collabUi.endSessionFlow(deps);
    await settle();
    clickPromptButton('End Session');
    await endP;
    await sleep(120);
    expect(collabUi.activeSession()).toBeNull();
    expect(collabPluginSource()).toBeNull();
    expect(chip.hidden).toBe(true);
    expect(partnerEnded).toBe(true);
    await partner.stop();
    partnerView.destroy();
    hostView.destroy();
  }, 20_000);

  it('cancelling the session-doc swap unwinds the join without touching the room', async () => {
    // A live room hosted outside the UI flows (module `active` state stays free).
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('host doc'),
      client,
    });

    let v = mkIndexStyleView();
    const deps = {
      getView: () => v,
      refreshPlugins: () => {
        v.updateState(v.state.reconfigure({ plugins: buildMiniPlugins() }));
      },
      // User balks at overwriting their unsaved edits.
      newSessionDoc: () => false,
    };
    await collabUi.joinSessionWithCode(deps, shareCode);
    await settle();
    expect(collabUi.activeSession()).toBeNull();
    expect(collabPluginSource()).toBeNull();
    expect(document.getElementById('collab-chip')!.hidden).toBe(true);

    // The room is untouched — a second join attempt that goes through works.
    const okDeps = { ...deps, newSessionDoc: () => true };
    await collabUi.joinSessionWithCode(okDeps, shareCode);
    await settle();
    expect(collabUi.activeSession()).not.toBeNull();
    await collabUi.activeSession()!.stop();
    // manual teardown (we bypassed endSessionFlow's cleanup)
    const endP = collabUi.endSessionFlow(deps);
    await settle();
    clickPromptButton('Leave Session');
    await endP;
    await host.end();
    v.destroy();
  }, 20_000);
});
