// @vitest-environment jsdom
/**
 * UI-flow integration: startSessionFlow / endSessionFlow drive the real
 * seams (collab-hooks plugin source + transaction tagger) the way
 * index.ts does — including the M0 payoff: with read mode ON, a
 * partner's remote edit still lands because the tagger stamps
 * sync-origin on the binding's transactions before filterTransaction
 * runs.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EditorState, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import {
  collabPluginsFor,
  collabPluginSourceFor,
  tagCollabTransaction,
  collabCopresenceFor,
  onCollabCopresenceChange,
  collabCloseKeepResumable,
  collabEndOrLeaveSession,
  collabCaptureSessionHandoff,
} from '../../src/editor/collab/collab-hooks.js';
import { loadSessionRecord } from '../../src/editor/collab/collab-store.js';

// Sessions are keyed by the owning doc's uid; this test window's one doc.
const OWNER = 'ui-flows-doc';
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
  // Route-style choice buttons carry the label in a <strong> (with a
  // description below); the Cancel button is plain text.
  const btn = [...document.querySelectorAll('.pmd-route-overlay button')].find((b) => {
    const strong = b.querySelector('strong');
    return (strong ? strong.textContent : b.textContent) === label;
  }) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no prompt button labeled "${label}"`);
  btn.click();
}

/** Start a session, clicking through the confirm-on-start dialog (names the
 *  doc; "Start Session" / Cancel). Mirrors how the end flow is driven below. */
async function startSession(deps: Parameters<typeof collabUi.startSessionFlow>[0]): Promise<void> {
  const p = collabUi.startSessionFlow(deps);
  await settle();
  clickPromptButton('Start Session');
  await p;
}
afterAll(async () => {
  await mock.close();
  localStorage.removeItem('pmd-collab');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** index.ts's plugin assembly in miniature: read mode + whatever the
 *  collab plugin source supplies, with the dispatch tagger applied. */
function buildMiniPlugins(ownerUid = OWNER): Plugin[] {
  return [readModePlugin, ...collabPluginsFor(ownerUid)];
}

function mkIndexStyleView(ownerUid = OWNER): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const state = EditorState.create({ doc: simpleDoc('shared prep doc contents'), plugins: buildMiniPlugins(ownerUid) });
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
      getOwnerUid: () => OWNER,
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
    await startSession(deps);
    expect(collabUi.activeSession()).not.toBeNull();
    // Joiners name their unsaved copy from this (field bug: windows and
    // Sessions-list rows just said "collaboration session").
    expect(collabUi.activeSession()!.loroDoc.getMap('meta').get('title')).toBe('Aff Updates');
    expect(collabPluginSourceFor(OWNER)?.ownsUndo()).toBe(true);
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
    const src = collabPluginSourceFor(OWNER)!;
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
    expect(collabPluginSourceFor(OWNER)).toBeNull();
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
      getOwnerUid: () => OWNER,
      refreshPlugins: () => {
        v.updateState(v.state.reconfigure({ plugins: buildMiniPlugins() }));
      },
      // User balks at overwriting their unsaved edits.
      newSessionDoc: () => false,
    };
    await collabUi.joinSessionWithCode(deps, shareCode);
    await settle();
    expect(collabUi.activeSession()).toBeNull();
    expect(collabPluginSourceFor(OWNER)).toBeNull();
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

  it('offloads the join to a new window instead of creating a session here', async () => {
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('host doc'),
      client,
    });
    const v = mkIndexStyleView();
    let spawnedWith: string | null = null;
    let newSessionDocCalled = false;
    const deps = {
      getView: () => v,
      getOwnerUid: () => OWNER,
      refreshPlugins: () => {
        v.updateState(v.state.reconfigure({ plugins: buildMiniPlugins() }));
      },
      newSessionDoc: () => {
        newSessionDocCalled = true;
        return true;
      },
      // Stand in for "this window has a real doc open" → spawn a new window.
      spawnJoinWindow: (code: string) => {
        spawnedWith = code;
        return true;
      },
    };
    await collabUi.joinSessionWithCode(deps, shareCode);
    await settle();
    // The join was handed off: no session was created in this window, and the
    // in-window doc swap never ran.
    expect(spawnedWith).toBe(shareCode);
    expect(collabUi.activeSession()).toBeNull();
    expect(newSessionDocCalled).toBe(false);
    await host.end();
    v.destroy();
  }, 20_000);

  it('two docs each run an INDEPENDENT session in one window (no fusion)', async () => {
    const viewA = mkIndexStyleView('doc-A');
    const viewB = mkIndexStyleView('doc-B');
    const viewForUid = (u: string): EditorView | null =>
      u === 'doc-A' ? viewA : u === 'doc-B' ? viewB : null;
    const depsFor = (uid: string, view: EditorView) => ({
      getView: () => view,
      getOwnerUid: () => uid,
      getViewForUid: viewForUid,
      refreshPlugins: () =>
        view.updateState(view.state.reconfigure({ plugins: buildMiniPlugins(uid) })),
      newSessionDoc: () => true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    // Host a session on doc A, then a SEPARATE session on doc B — same window.
    await startSession(depsFor('doc-A', viewA));
    await startSession(depsFor('doc-B', viewB));
    await settle();

    // Two independent sessions coexist, each bound to its OWN doc's view.
    const srcA = collabPluginSourceFor('doc-A');
    const srcB = collabPluginSourceFor('doc-B');
    expect(srcA).not.toBeNull();
    expect(srcB).not.toBeNull();
    expect(srcA).not.toBe(srcB);

    // Ending A leaves B live (per-doc lifecycle — not window-global).
    const endA = collabUi.endSessionFlow(depsFor('doc-A', viewA));
    await settle();
    clickPromptButton('End Session');
    await endA;
    expect(collabPluginSourceFor('doc-A')).toBeNull();
    expect(collabPluginSourceFor('doc-B')).not.toBeNull();

    const endB = collabUi.endSessionFlow(depsFor('doc-B', viewB));
    await settle();
    clickPromptButton('End Session');
    await endB;
    expect(collabPluginSourceFor('doc-B')).toBeNull();
    viewA.destroy();
    viewB.destroy();
  }, 20_000);

  it('exposes per-doc copresence for the shell footer, isolated per session', async () => {
    const viewA = mkIndexStyleView('cp-A');
    const viewB = mkIndexStyleView('cp-B');
    const viewForUid = (u: string): EditorView | null =>
      u === 'cp-A' ? viewA : u === 'cp-B' ? viewB : null;
    const depsFor = (uid: string, view: EditorView) => ({
      getView: () => view,
      getOwnerUid: () => uid,
      getViewForUid: viewForUid,
      refreshPlugins: () =>
        view.updateState(view.state.reconfigure({ plugins: buildMiniPlugins(uid) })),
      newSessionDoc: () => true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    // The shell subscribes to copresence changes to repaint slot footers;
    // assert the notifier actually fires on start/end.
    let notifications = 0;
    const unsub = onCollabCopresenceChange(() => {
      notifications++;
    });

    // No session yet → no copresence for either doc.
    expect(collabCopresenceFor('cp-A')).toBeNull();

    await startSession(depsFor('cp-A', viewA));
    await startSession(depsFor('cp-B', viewB));
    await settle();
    expect(notifications).toBeGreaterThan(0);

    // Each session reports its OWN copresence; a doc with no session is null.
    const cpA = collabCopresenceFor('cp-A');
    const cpB = collabCopresenceFor('cp-B');
    expect(cpA).not.toBeNull();
    expect(cpB).not.toBeNull();
    expect(cpA).not.toBe(cpB);
    // Each host sees itself in its own presence (self dot), isolated per doc.
    expect(cpA!.peers.some((p) => p.self)).toBe(true);
    expect(collabCopresenceFor('cp-none')).toBeNull();

    // Ending A drops only A's copresence; B keeps reporting.
    const endA = collabUi.endSessionFlow(depsFor('cp-A', viewA));
    await settle();
    clickPromptButton('End Session');
    await endA;
    expect(collabCopresenceFor('cp-A')).toBeNull();
    expect(collabCopresenceFor('cp-B')).not.toBeNull();

    const endB = collabUi.endSessionFlow(depsFor('cp-B', viewB));
    await settle();
    clickPromptButton('End Session');
    await endB;
    expect(collabCopresenceFor('cp-B')).toBeNull();
    unsub();
    viewA.destroy();
    viewB.destroy();
  }, 20_000);

  it('closing a co-edited doc keeps the session resumable; end/leave clears it', async () => {
    const viewK = mkIndexStyleView('close-keep');
    const viewE = mkIndexStyleView('close-end');
    const viewForUid = (u: string): EditorView | null =>
      u === 'close-keep' ? viewK : u === 'close-end' ? viewE : null;
    const depsFor = (uid: string, view: EditorView) => ({
      getView: () => view,
      getOwnerUid: () => uid,
      getViewForUid: viewForUid,
      refreshPlugins: () =>
        view.updateState(view.state.reconfigure({ plugins: buildMiniPlugins(uid) })),
      newSessionDoc: () => true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    // Close-but-keep: the live session tears down, but its persisted record
    // stays so the Sessions list can resume it (unsynced edits sync on rejoin).
    await startSession(depsFor('close-keep', viewK));
    const keepRoom = collabUi.activeSession()!.roomId;
    await collabCloseKeepResumable('close-keep');
    await settle();
    expect(collabPluginSourceFor('close-keep')).toBeNull();
    expect(collabCopresenceFor('close-keep')).toBeNull();
    expect(await loadSessionRecord(keepRoom)).not.toBeNull();

    // End/leave: the session AND its resumable record are gone.
    await startSession(depsFor('close-end', viewE));
    const endRoom = collabUi.activeSession()!.roomId;
    await collabEndOrLeaveSession('close-end');
    await settle();
    expect(collabPluginSourceFor('close-end')).toBeNull();
    expect(collabCopresenceFor('close-end')).toBeNull();
    expect(await loadSessionRecord(endRoom)).toBeNull();

    viewK.destroy();
    viewE.destroy();
  }, 20_000);

  it('session flush + keep-resumable close + resume-in-place (existingDoc)', async () => {
    const view = mkIndexStyleView('ho-doc');
    const depsFor = (uid: string, v: EditorView, onNewDoc?: () => void) => ({
      getView: () => v,
      getOwnerUid: () => uid,
      getViewForUid: (u: string) => (u === uid ? v : null),
      refreshPlugins: () => v.updateState(v.state.reconfigure({ plugins: buildMiniPlugins(uid) })),
      newSessionDoc: () => {
        onNewDoc?.();
        return true;
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    await startSession(depsFor('ho-doc', view));
    const room = collabUi.activeSession()!.roomId;

    // Capture reports the live session and flushes its record (so unsynced
    // edits survive the toggle's reload).
    const handoff = await collabCaptureSessionHandoff();
    expect(handoff).toContainEqual({ uid: 'ho-doc', roomId: room });
    expect(await loadSessionRecord(room)).not.toBeNull();

    // Simulate the pre-reload teardown that keeps the record resumable.
    await collabCloseKeepResumable('ho-doc');
    expect(collabPluginSourceFor('ho-doc')).toBeNull();
    expect(await loadSessionRecord(room)).not.toBeNull();

    // Resume INTO the still-open doc (existingDoc): must NOT mint a new doc, and
    // the session rebinds to that view.
    let newDocCalled = false;
    await collabUi.resumeSessionFlow(
      depsFor('ho-doc', view, () => {
        newDocCalled = true;
      }),
      room,
      { existingDoc: true },
    );
    await settle();
    expect(newDocCalled).toBe(false);
    expect(collabPluginSourceFor('ho-doc')).not.toBeNull();

    const end = collabUi.endSessionFlow(depsFor('ho-doc', view));
    await settle();
    // Resumed from a host record → host role → "End Session".
    clickPromptButton('End Session');
    await end;
    view.destroy();
  }, 20_000);
});
