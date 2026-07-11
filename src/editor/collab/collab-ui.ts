/**
 * Collaboration-session UI flows: start / join / copy-code / end,
 * wired to the ribbon commands, plus the status-bar chip. Lazily
 * imported (this module pulls the Loro wasm via collab-session).
 *
 * One session per window at a time, bound to the single-doc view. The
 * flows own the editor's collab seams (collab-hooks): while a session
 * is live they register the plugin source (Loro sync + undo manager),
 * the transaction tagger (stamps sync-origin on the binding's remote
 * transactions so read mode and the AI coordinator admit them), and
 * refresh the plugin stack through the injected reconfigure capability.
 *
 * Invite transport: the share code (clipboard) and, on desktop, sealed
 * pairing-mailbox invites (inviteStarredFlow / joinSessionWithCode via
 * the Receive pill's Join).
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { promptForText, promptForRouteChoice } from '../text-prompt.js';
import { markSyncOrigin } from '../sync-origin.js';
import { readModePlugin } from '../read-mode-plugin.js';
import {
  registerCollabPluginSource,
  unregisterCollabPluginSource,
  setCollabTransactionTagger,
  setCollabCopresenceProvider,
  notifyCollabCopresenceChange,
  setCollabCloseActions,
  setCollabHandoffProvider,
  setCollabSessionCountProvider,
} from './collab-hooks.js';
import { RoomsError } from './room-client.js';
import { getElectronHost } from '../host/index.js';
import { ensureBakedRelay, relayClient } from './collab-relay.js';
import { relayClient as pairingRelayClient } from '../pairing/relay-client.js';
import { resolveStarredTarget } from '../pairing/send-to-starred.js';
import { buildRoomInviteItem, ROOM_INVITE_MIN_VERSION } from '../pairing/room-invite.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import { installCommentsSync, type CommentsSyncHandle } from './collab-comments.js';
import { attachSessionPersistence, type PersistHandle } from './collab-persist.js';
import { installCursorPresence, type CursorsHandle } from './collab-cursors.js';
import { collabRepairPlugin, lowestPeerIsLeader } from './collab-repair.js';
import { loadSessionRecord, loadPrefetch, deletePrefetch } from './collab-store.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { resetSessionCommentIds } from '../comments-plugin.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession } from './collab-session.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  /** The `DocRecord.uid` of the document this session is being started/joined
   *  for — captured at install so the binding plugins only ever attach to that
   *  one doc's view (multi-pane fusion guard). */
  getOwnerUid?(): string | null;
  /** Resolve a doc uid to its live view. A session binds its cursors/comments to
   *  its OWNER's view via this (not the focused view), so in multi-pane each
   *  doc's presence renders in its own pane. Falls back to the focused view. */
  getViewForUid?(uid: string): EditorView | null;
  /** Swap THIS window's editor to a fresh unsaved doc for a joined
   *  session — must never spawn a window (the binding installs into the
   *  current view; a spawned window would never get it — field bug on
   *  desktop, 2026-07-03). Resolves false if the user cancelled out of
   *  overwriting unsaved edits. */
  newSessionDoc(): boolean | Promise<boolean>;
  /** Name the (unsaved) session doc in this window: window title, the
   *  filename chip, and the save-as default. Joiners get the host's
   *  title through the room's meta map — without this the window and
   *  the Sessions list just say "collaboration session" (field bug,
   *  2026-07-03). */
  setDocTitle?(title: string): void;
  /** Desktop multi-window: when the current window has a real doc open (not
   *  the disposable starter), spawn a NEW window to host the joined session
   *  and return true — the caller then aborts, and the spawned window runs
   *  the full join itself (so the session + Loro binding land together,
   *  never stranded). Returns false to join in THIS window (starter open, or
   *  single-window / web). */
  spawnJoinWindow?(shareCode: string): boolean;
}

/** One live co-editing session, owned by a single open doc (the map key). A
 *  multi-pane window can hold several — one per doc. */
interface ActiveSession {
  session: CollabSession;
  shareCode: string;
  ownerUid: string;
  cursors: CursorsHandle;
  commentsSync: CommentsSyncHandle;
  persist: PersistHandle;
  wakeCleanup: () => void;
  /** Latest connection status for THIS session. The shared status-bar chip only
   *  ever reflects the focused doc's session; storing status per session lets
   *  each multi-pane slot footer render its own visible doc's state. */
  lastStatus: { connected: boolean; queuedUpdates: number } | null;
}

const sessions = new Map<string, ActiveSession>();

/** Focused doc's uid — set by the editor host so no-deps UI helpers (chip,
 *  presence, copy-code, invite) can find the session the user is looking at. */
let focusedUidResolver: (() => string | null) | null = null;
export function setCollabFocusResolver(fn: (() => string | null) | null): void {
  focusedUidResolver = fn;
}

/** Resolve a doc uid → its display filename, set by the host so no-deps helpers
 *  (invite, persist label) and the start flow name a session after its OWNER
 *  doc rather than `document.title` — which in multi-pane is every open doc
 *  joined by " · ". */
let docTitleResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocTitleResolver(fn: ((uid: string) => string | null) | null): void {
  docTitleResolver = fn;
}

/** The session owned by `uid`, or null. */
function sessionFor(uid: string | null | undefined): ActiveSession | null {
  return uid != null ? sessions.get(uid) ?? null : null;
}

// Feed the multi-pane shell's per-slot footers: each slot paints the copresence
// of ITS visible doc's session (or nothing when that doc isn't in a session).
setCollabCopresenceProvider((uid) => {
  const sess = sessionFor(uid);
  if (!sess) return null;
  return {
    role: sess.session.role,
    // Before the first onStatus, assume connected (start() flushes immediately);
    // the flows also stamp lastStatus so an offline join/resume reads correctly.
    connected: sess.lastStatus?.connected ?? true,
    queued: sess.lastStatus?.queuedUpdates ?? 0,
    peers: sess.cursors.presence().map((p) => ({ name: p.name, color: p.color, self: p.self })),
  };
});

// Close-time actions for a co-edited doc, called by the always-loaded close
// paths (multi-pane shell + single-doc) via collab-hooks. Registered once here.
setCollabCloseActions({
  keepResumable: (uid) => closeKeepResumableSession(uid),
  endOrLeave: (uid) => closeEndOrLeaveSession(uid),
});

// Mode-switch hand-off: flush every live session's record (so unsynced edits
// survive the toggle's reload) and report {uid, roomId} so the post-reload flow
// can auto-resume each into the doc that reopens under its uid.
setCollabHandoffProvider(async () => {
  const list = [...sessions.values()].map((s) => ({ uid: s.ownerUid, roomId: s.session.roomId }));
  await Promise.all([...sessions.values()].map((s) => s.persist.flush()));
  return list;
});
setCollabSessionCountProvider(() => sessions.size);

/** The session the shared chip / no-deps flows act on: the focused doc's, or —
 *  when focus isn't resolvable (or that doc has no session) — the sole session
 *  if there's exactly one. (A later step adds a per-slot footer so every
 *  session's status shows at once; until then the single chip follows focus.) */
function chipSession(): ActiveSession | null {
  return (
    sessionFor(focusedUidResolver?.() ?? null) ??
    (sessions.size === 1 ? [...sessions.values()][0]! : null)
  );
}

function chipEl(): HTMLElement | null {
  return document.getElementById('collab-chip');
}

function updateChip(status: { connected: boolean; queuedUpdates: number } | null): void {
  const chip = chipEl();
  if (!chip) return;
  if (!status) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  chip.hidden = false;
  const text = status.connected
    ? status.queuedUpdates > 0
      ? `Session: sending ${status.queuedUpdates}…`
      : 'Session: synced'
    : status.queuedUpdates > 0
      ? `Session: offline — ${status.queuedUpdates} queued`
      : 'Session: offline';
  // Chip = a text label + a presence-dots strip (kept as stable children so
  // the dots can refresh on their own timer without rebuilding the label).
  let label = chip.querySelector('.pmd-collab-chip-label');
  let dots = chip.querySelector('.pmd-collab-chip-dots');
  if (!(label instanceof HTMLElement) || !(dots instanceof HTMLElement)) {
    chip.replaceChildren();
    label = document.createElement('span');
    label.className = 'pmd-collab-chip-label';
    chip.appendChild(label);
    dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    chip.appendChild(dots);
  }
  label.textContent = text;
  renderPresenceDots(dots as HTMLElement);
}

/** One colored dot per person in the room, hover for the name. */
function renderPresenceDots(container: HTMLElement): void {
  const peers = chipSession()?.cursors.presence() ?? [];
  container.replaceChildren();
  for (const p of peers) {
    const dot = document.createElement('span');
    dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
    dot.style.background = p.color;
    dot.title = p.self ? `${p.name} (you)` : p.name;
    container.appendChild(dot);
  }
}

/** Re-render just the dots (peers join/leave/expire between chip updates). */
function refreshPresenceDots(): void {
  const dots = chipEl()?.querySelector('.pmd-collab-chip-dots');
  if (dots instanceof HTMLElement) renderPresenceDots(dots);
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;


/** Stamp the Loro binding's own transactions as sync-origin: both the
 *  remote-update imports and the init-time content replace carry the
 *  binding's meta, and neither is a user edit — read mode and the AI
 *  coordinator must admit them (rejection desyncs editor from CRDT). */
function collabTagger(tr: Parameters<typeof markSyncOrigin>[0]): void {
  if (tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined) {
    markSyncOrigin(tr);
  }
}


/** Wake-from-sleep / network-return hooks (M3): a resumed laptop's
 *  stream socket is silently dead until timeouts notice — restart it
 *  the moment the OS tells us. Desktop: powerMonitor via the host
 *  seam; both editions: the browser 'online' event. */
function installWakeHooks(session: CollabSession): () => void {
  const onOnline = (): void => session.restart();
  window.addEventListener('online', onOnline);
  const offResume = getElectronHost()?.onPowerResumed?.(() => session.restart()) ?? null;
  return () => {
    window.removeEventListener('online', onOnline);
    offResume?.();
  };
}

/** Build a session's seams, register it, and return the ActiveSession. The
 *  cursors/comments bind to the OWNER's view (not focus) so each doc's presence
 *  renders in its own pane. Window-level seams (tagger, presence timer, comment-
 *  id mode) are shared across every live session and retired in `teardownSession`
 *  when the last one ends. `ownerUid` is the map key (the focused doc at start). */
/** `ownerUid` is the map key and the doc the seams bind into. It is passed in
 *  (not re-read from `deps.getOwnerUid()` here) because every caller has already
 *  awaited a confirm dialog and/or a relay round-trip by this point: re-reading
 *  focus now would bind the session onto whatever doc the user has since clicked
 *  into. Callers capture it at the moment that fixes the target — start: the
 *  focused doc when Start was chosen; join/resume: the freshly-created session
 *  doc right after newSessionDoc(). */
function installSeams(
  session: CollabSession,
  deps: CollabUiDeps,
  shareCode: string,
  ownerUid: string,
): ActiveSession {
  const ownerView = (): EditorView | null =>
    (ownerUid ? deps.getViewForUid?.(ownerUid) ?? null : null) ?? deps.getView();
  // One shared tagger stamps ANY binding transaction (keyed off the Loro plugin
  // meta), so it serves every session; installed while ≥1 is live.
  setCollabTransactionTagger(collabTagger);
  const wakeCleanup = installWakeHooks(session);
  const commentsSync = installCommentsSync(session.loroDoc, ownerView);
  // M3: crash-surviving session record (home-screen Sessions list resumes it).
  const persist = attachSessionPersistence(session, shareCode, () =>
    sessionDocTitle(ownerUid) || sharedDocTitle(session),
  );
  const cursors = installCursorPresence(session, ownerView);
  // One shared timer refreshes the focused session's chip dots AND every slot
  // footer's copresence (peers join/leave/expire between status updates).
  if (presenceTimer === null)
    presenceTimer = setInterval(() => {
      refreshPresenceDots();
      notifyCollabCopresenceChange();
    }, 3000);
  // Comment-id allocation is per-doc now (the host's resolver tests each doc's
  // session state), so nothing to toggle on here — a co-edited doc's new
  // comments get random ids to avoid two peers colliding on the counter.
  const sess: ActiveSession = {
    session,
    shareCode,
    ownerUid,
    cursors,
    commentsSync,
    persist,
    wakeCleanup,
    lastStatus: null,
  };
  sessions.set(ownerUid, sess);
  // A session just appeared — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  registerCollabPluginSource({
    ownerUid,
    plugins: () => [
      ...session.plugins(),
      LoroUndoPlugin({ doc: session.loroDoc }),
      collabInvariantHealPlugin(),
      collabRepairPlugin(() =>
        lowestPeerIsLeader(session.loroDoc.peerIdStr, cursors.visiblePeers()),
      ),
      commentsSync.plugin,
      ...cursors.plugins(),
    ],
    ownsUndo: () => true,
    // Read-mode clamp (M4): swallow undo/redo entirely while reading — the Loro
    // undo transactions carry the binding meta (→ sync-origin) and would
    // otherwise sail through the read-mode lock and revert real edits.
    undo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroUndo(state, dispatch, view),
    redo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroRedo(state, dispatch, view),
  });
  return sess;
}

/** Dispose one session's seams + drop it from the registry. Window-level shared
 *  seams (tagger / presence timer / comment-id mode) are retired only when the
 *  LAST session ends. `keepRecord` keeps the resumable persisted record (a
 *  cancelled RESUME, or a close-but-keep); terminal paths clear it. Returns the
 *  record-clear promise so terminal callers can await deletion (so a re-read of
 *  the Sessions list doesn't flash a stale row); most callers ignore it. */
function teardownSession(sess: ActiveSession, keepRecord = false): Promise<void> {
  unregisterCollabPluginSource(sess.ownerUid);
  sessions.delete(sess.ownerUid);
  // A session went away — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  sess.wakeCleanup();
  sess.commentsSync.dispose();
  sess.cursors.dispose();
  let cleared: Promise<void> = Promise.resolve();
  if (keepRecord) sess.persist.dispose();
  else cleared = sess.persist.clear();
  if (sessions.size === 0) {
    setCollabTransactionTagger(null);
    // Last session gone — drop the random-id dedup set so it doesn't grow.
    resetSessionCommentIds();
    if (presenceTimer !== null) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }
  return cleared;
}

/** Whether `ownerUid`'s session is the one the shared chip reflects (the focused
 *  doc's, or — with no focus resolver — the sole session). */
function isChipSession(ownerUid: string): boolean {
  const focused = focusedUidResolver?.() ?? null;
  return focused != null ? ownerUid === focused : sessions.size <= 1;
}

// `getSess` resolves THIS session's ActiveSession lazily — for join/resume the
// entry isn't created (and its owning uid isn't known) until after newSessionDoc
// creates the fresh doc, which is after the CollabSession (and these callbacks)
// exist. Returns null before install / after teardown; callbacks then no-op.
function sessionCallbacks(deps: CollabUiDeps, getSess: () => ActiveSession | null) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => {
      const sess = getSess();
      if (!sess) return;
      // Every session records its own status (each slot footer renders its
      // own); the shared chip still reflects only the focused doc's.
      sess.lastStatus = s;
      if (isChipSession(sess.ownerUid)) updateChip(s);
      notifyCollabCopresenceChange();
    },
    onPresence: (bytes: Uint8Array) => getSess()?.cursors.applyRemote(bytes),
    onBacklogMerged: (count: number) => {
      // Merge-visibility (M3): a travel-day backlog just landed — say
      // so, instead of the doc silently reshaping under the user.
      showToast(`Synced ${count} offline updates from the session — recent sections may have moved`);
    },
    onEnded: () => {
      // The explicit end/leave flows clean up themselves before the
      // session's onEnded fires; only a REMOTELY ended session (host
      // ended it, room GC'd) reaches past this guard.
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) return;
      const wasHost = sess.session.role === 'host';
      const wasChip = isChipSession(sess.ownerUid);
      void teardownSession(sess);
      if (wasChip) updateChip(null);
      deps.refreshPlugins();
      showToast(
        wasHost
          ? 'Collaboration session ended'
          : 'Session ended — this copy is now yours alone',
      );
    },
    onFull: () => {
      showToast('That session is full (10 participants)');
    },
  };
}

/** Turn a relay failure into a user-actionable message. A 401 is the
 *  gating/auth signal — for INITIATING a session (send-gated per §5.4:
 *  paid initiates, free joins) that means a subscription is required;
 *  for join/resume it means the relay rejected the credentials. The
 *  401 is inherently ambiguous between "hosted relay, needs a paid
 *  account" and "self-host, wrong token", so the message names both
 *  without asserting which. Any non-401 keeps its raw reason. */
export function relayFailureMessage(err: unknown, opts: { initiating: boolean; verb: string }): string {
  if (err instanceof RoomsError && err.status === 401) {
    return opts.initiating
      ? 'Starting a collaboration session requires a relay. In Settings → ' +
          'Collaboration, connect your Debate Decoded account or set up your own relay.'
      : 'The session relay rejected your credentials. In Settings → Collaboration, ' +
          'connect your Debate Decoded account or set up your own relay.';
  }
  // 410 = the room was ended (host) or expired (idle GC). Not an error the
  // user can retry into — tell them the session is over rather than leaking
  // the raw "rooms request failed: 410".
  if (err instanceof RoomsError && err.status === 410) {
    return 'That co-editing session has ended — ask for a fresh invite to start a new one.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}

/** Start-session gate: a session is started FOR a focused document, so a
 *  live view is required (join/resume create their own doc and do not use
 *  this). The message holds in both modes — single-pane always has a doc;
 *  multi-pane hits this only with every slot empty/unfocused. */
function guardReady(deps: CollabUiDeps): EditorView | null {
  if (!collabEnabled()) return null;
  const view = deps.getView();
  if (!view) {
    showToast('Open and focus a document to start a co-editing session');
    return null;
  }
  return view;
}

export async function startSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  const view = guardReady(deps);
  if (!view) return;
  const ownerUid = deps.getOwnerUid?.() ?? '';
  if (sessionFor(ownerUid)) {
    showToast('This document already has a session — end or leave it first');
    return;
  }
  // Confirm, naming the doc the session will be created for — removes any
  // ambiguity about which doc is being shared (multi-pane: the focused one).
  const startName = sessionDocTitle(ownerUid);
  const startConfirm = await promptForRouteChoice({
    message: `Start a co-editing session for ${startName ? `"${startName}"` : 'this document'}?`,
    choices: [
      {
        value: 'start',
        label: 'Start Session',
        description: 'Anyone you share the code with can edit this document with you in real time.',
      },
    ],
  });
  if (startConfirm !== 'start') return;
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Collaboration first');
    return;
  }
  try {
    // Host on the CURRENT (focused) doc — no doc swap, so its uid is the owner.
    let sessRef: ActiveSession | null = null;
    const { session, shareCode } = await CollabSession.host({
      pmDoc: view.state.doc,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    // ownerUid captured at flow start (line ~427), under the doc that was
    // focused when Start was chosen — host() shared THAT doc's content, so the
    // seams must bind to it even if focus has since moved.
    const sess = installSeams(session, deps, shareCode, ownerUid);
    sessRef = sess;
    // Seed before start(): the first flush then carries the host's
    // existing comment threads alongside the seeded doc — and the doc
    // title, so joiners can name their unsaved copy.
    sess.commentsSync.seedFromView(view);
    session.loroDoc.getMap('meta').set('title', sessionDocTitle(ownerUid));
    session.loroDoc.commit();
    deps.refreshPlugins();
    session.start();
    sess.lastStatus = { connected: true, queuedUpdates: 0 };
    updateChip({ connected: true, queuedUpdates: 0 });
    const copied = await navigator.clipboard?.writeText(shareCode).then(
      () => true,
      () => false,
    );
    showToast(
      copied
        ? 'Session started — share code copied, send it to your partner'
        : 'Session started — use "Copy Session Share Code" to invite',
    );
  } catch (err) {
    showToast(relayFailureMessage(err, { initiating: true, verb: 'start the session' }));
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  const code = await promptForText({
    message: 'Paste the share code from your partner',
    placeholder: 'cmshare1.…',
    okLabel: 'Join',
  });
  if (!code) return;
  await joinSessionWithCode(deps, code);
}

/** Join with a code in hand — the prompt flow above and the Receive
 *  pill's invite Join both land here. Returns true when the join actually
 *  landed (or was handed to a spawned window) — the Receive pill consumes
 *  the invite only then, so a cancelled slot pick or an unreachable relay
 *  doesn't burn the share code. No view is required up front: the flow
 *  creates its own doc via deps.newSessionDoc (multi-pane may be an empty
 *  workspace at this point). */
export async function joinSessionWithCode(deps: CollabUiDeps, code: string): Promise<boolean> {
  if (!collabEnabled()) return false;
  // Don't overwrite the doc you're working in — or bump the session you're
  // already in: unless this window holds the disposable starter, hand the
  // join to a fresh window (which re-enters here with the starter open, so it
  // joins in place). Runs BEFORE the `active` guard and the session creation,
  // so an active-session window opens the new join elsewhere instead of
  // refusing, and the session + binding are born in the window that keeps them.
  // (Single-pane desktop only; the multi-pane deps have no spawnJoinWindow.)
  // Counts as consumed: the join continues in the spawned window.
  if (deps.spawnJoinWindow?.(code.trim())) return true;
  // Don't overwrite a doc that's ITSELF in a session (spawnJoinWindow already
  // redirected windows holding a real doc; this guards the edge case).
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it before joining here');
    return false;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Collaboration first');
    return false;
  }
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a share code');
    return false;
  }
  // Resolved after newSessionDoc/installSeams; callbacks read it lazily.
  let sessRef: ActiveSession | null = null;
  try {
    let session: CollabSession;
    let joinedOffline = false;
    try {
      session = await CollabSession.join({
        ...decoded,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
    } catch (err) {
      // An ENDED/expired room (410) is not an offline condition — the seed
      // would resume a session that no longer exists. Surface it as ended.
      if (err instanceof RoomsError && err.status === 410) throw err;
      // Offline (or relay unreachable): fall back to the invite's
      // prefetched seed (§4.1). Everything in it came FROM the room,
      // so resume() with no sentVersion is exact; start() syncs at the
      // next connectivity window.
      const pre = await loadPrefetch(decoded.roomId);
      if (!pre) throw err;
      const key = await importRoomKey(decoded.keyBytes);
      const blobs = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
      session = await CollabSession.resume({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: 'participant',
        snapshot: blobs[0]!,
        increments: blobs.slice(1),
        lastSeq: pre.lastSeq,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
      joinedOffline = true;
    }
    // Create the fresh unsaved session doc — its uid is the session owner
    // (single-pane swaps this window's doc; multi-pane slot-picks). A false
    // return = the user balked (overwrite prompt / slot picker) — unwind
    // without touching the room AND keep the prefetched seed: the invite
    // stays retryable.
    if (!(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Join cancelled');
      return false;
    }
    // The session owner is the doc newSessionDoc() just created — capture its
    // uid NOW, before any later focus change, so the seams bind into it.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, code.trim(), ownerUid);
    // Add the binding to the fresh doc's view — its init replaces the empty
    // content with the session's CRDT state.
    deps.refreshPlugins();
    // The join snapshot already carries the host's thread map — land it
    // in the fresh pane's plugin state; same for the published title.
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: !joinedOffline, queuedUpdates: 0 };
    updateChip({ connected: !joinedOffline, queuedUpdates: 0 });
    // Only NOW is the seed spent — the join is committed (for the offline
    // path the seed's content lives on in the session + its persist record).
    void deletePrefetch(decoded.roomId);
    showToast(
      joinedOffline
        ? 'Joined from the prefetched copy — will sync when you reconnect'
        : 'Joined the session',
    );
    deps.getView()?.focus();
    return true;
  } catch (err) {
    if (sessRef) void teardownSession(sessRef);
    // A dead room's invite and seed are useless — purge the seed and report
    // consumed so the Receive pill clears the row. Every other failure keeps
    // both, so the user can retry once the network/slot situation changes.
    const ended = err instanceof RoomsError && err.status === 410;
    if (ended) void deletePrefetch(decoded.roomId);
    showToast(relayFailureMessage(err, { initiating: false, verb: 'join' }));
    return ended;
  }
}

/** Resume a persisted session (home-screen Sessions list, M3). The
 *  persisted CRDT carries this peer's full history — including edits
 *  that never reached the relay before the app died — so start()'s
 *  first flush sends exactly the unsent diff and catch-up resumes from
 *  the stored cursor. A tombstoned room degrades through the normal
 *  onEnded path ("this copy is now yours alone") and clears the record. */
export async function resumeSessionFlow(
  deps: CollabUiDeps,
  roomId: string,
  opts?: { existingDoc?: boolean },
): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  // No up-front view requirement: unless resuming into an existing doc, the
  // flow creates its own via deps.newSessionDoc (multi-pane may be an empty
  // workspace reached from the home screen's Sessions list).
  if (opts?.existingDoc && !deps.getView()) return;
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it first');
    return;
  }
  for (const s of sessions.values()) {
    if (s.session.roomId === roomId) {
      showToast('That session is already active in this window');
      return;
    }
  }
  const record = await loadSessionRecord(roomId);
  if (!record) {
    showToast('No saved session to resume');
    return;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Collaboration first');
    return;
  }
  const decoded = decodeShareCode(record.shareCode);
  if (!decoded) {
    showToast('Saved session record is unreadable');
    return;
  }
  let sessRef: ActiveSession | null = null;
  try {
    const session = await CollabSession.resume({
      roomId: record.roomId,
      keyBytes: decoded.keyBytes,
      role: record.role,
      snapshot: record.snapshot,
      increments: record.increments,
      lastSeq: record.lastSeq,
      sentVersion: record.sentVersion,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    // Fresh doc first — its uid owns the session. A false return keeps the
    // record (still resumable) — no seams installed yet, so nothing to unwind.
    // EXCEPT `existingDoc`: bind into an ALREADY-open doc under its uid instead
    // of creating one (the binding replaces its content with the CRDT's —
    // same doc). A capability for resuming in place; no caller today.
    if (!opts?.existingDoc && !(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Resume cancelled');
      return;
    }
    // Owner = the doc that will hold the session: for existingDoc it is the
    // already-open doc under its uid; otherwise the fresh doc newSessionDoc()
    // just made (single-pane swap, or multi-pane slot). Capture past the awaits.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, record.shareCode, ownerUid);
    deps.refreshPlugins();
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: false, queuedUpdates: session.queuedUpdates };
    updateChip({ connected: false, queuedUpdates: session.queuedUpdates });
    showToast('Session resumed — syncing');
    deps.getView()?.focus();
  } catch (err) {
    if (sessRef) void teardownSession(sessRef);
    showToast(relayFailureMessage(err, { initiating: false, verb: 'resume' }));
  }
}

export async function copyShareCodeFlow(): Promise<void> {
  const sess = chipSession();
  if (!sess) {
    showToast('No active session');
    return;
  }
  const ok = await navigator.clipboard?.writeText(sess.shareCode).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Share code copied' : 'Could not copy the share code');
}

/** The host-published doc title from the room's meta map ('' when the
 *  host predates title publishing or hasn't named the doc). */
function sharedDocTitle(session: CollabSession): string {
  const t = session.loroDoc.getMap('meta').get('title');
  return typeof t === 'string' ? t.trim() : '';
}

/** Adopt the shared title in this window (joiner/resume paths). */
function adoptSharedTitle(deps: CollabUiDeps, session: CollabSession): void {
  const title = sharedDocTitle(session);
  if (title) deps.setDocTitle?.(title);
}

/** The name to publish/label a session with: the OWNER doc's own filename (via
 *  the host-set resolver), NOT `document.title` — in multi-pane that's every
 *  open doc joined by " · ", so a joiner would inherit a window title naming all
 *  of the host's open docs. Falls back to parsing the single-doc window title
 *  when no resolver is set (tests / pre-wire) or the uid can't be resolved. */
function sessionDocTitle(ownerUid: string | null | undefined): string {
  const byUid = ownerUid ? docTitleResolver?.(ownerUid) : null;
  if (byUid != null) return byUid.trim();
  const t = document.title;
  const cut = t.lastIndexOf(' — CardMirror');
  if (cut > 0) return t.slice(0, cut);
  return t === 'CardMirror' ? '' : t;
}

/** Shared invite-send tail: sealed pairing message, version-floored so
 *  pre-invite clients get the update-required toast instead of a dead
 *  card row. Assumes an active session. */
async function sendInviteTo(
  target: { codes: string[]; label: string; via?: string },
  shareCode: string,
  ownerUid: string | null | undefined,
): Promise<void> {
  const item = buildRoomInviteItem({
    shareCode,
    title: sessionDocTitle(ownerUid),
  });
  const res = await pairingRelayClient.send(target.codes, item, {
    via: target.via,
    minReceiverVersion: ROOM_INVITE_MIN_VERSION,
  });
  if (res.fail === 0) showToast(`Invited ${target.label} ✓`);
  else if (res.ok === 0) showToast(`Couldn't reach ${target.label}`);
  else showToast(`Invited ${target.label} (${res.fail} failed)`);
}

/** Send a session invite to the starred partner/group. */
export async function inviteStarredFlow(): Promise<void> {
  if (!collabEnabled()) return;
  const sess = chipSession();
  if (!sess) {
    showToast('No active session — start one first');
    return;
  }
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  const target = resolveStarredTarget(
    settings.get('pairingStarred'),
    settings.get('pairingPartners'),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast('Star a partner or group in the Send pill first');
    return;
  }
  if (target.codes.length === 0) {
    showToast('The starred group has no recipients yet');
    return;
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** The Send pill's click-to-invite (§6 picker-first flow): with no
 *  active session, START one on the current doc, then invite the
 *  picked partner/group; with one active, just invite. */
export async function inviteTargetFlow(
  deps: CollabUiDeps,
  target: { codes: string[]; label: string; via?: string },
): Promise<void> {
  if (!collabEnabled()) return;
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  if (target.codes.length === 0) {
    showToast('That group has no recipients yet');
    return;
  }
  let sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    await startSessionFlow(deps);
    sess = sessionFor(deps.getOwnerUid?.());
    if (!sess) return; // start failed/cancelled — its toast explains
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** Terminate/leave a session and clear its resumable record — the shared core
 *  of the explicit End command and the close dialog's End/Leave choice (no
 *  prompt; the caller already confirmed). Host ends for everyone (tombstones the
 *  room); a participant just disconnects. */
async function endOrLeaveSession(sess: ActiveSession): Promise<void> {
  const isHost = sess.session.role === 'host';
  const wasChip = isChipSession(sess.ownerUid);
  // Drop it from the registry first, so the session's own onEnded no-ops.
  const cleared = teardownSession(sess);
  try {
    if (isHost) await sess.session.end();
    else await sess.session.stop();
  } finally {
    if (wasChip) updateChip(null);
  }
  await cleared; // record actually gone before we return
}

/** Close a co-edited doc but KEEP its session resumable: disconnect (a final
 *  drain attempt), persist the CRDT — including edits that never reached the
 *  relay — then drop the live binding while leaving the stored record behind.
 *  The home-screen Sessions list resumes it; unsynced edits flush on rejoin.
 *  Called from the always-loaded close paths via collab-hooks. */
async function closeKeepResumableSession(uid: string): Promise<void> {
  const sess = sessionFor(uid);
  if (!sess) return;
  const wasChip = isChipSession(sess.ownerUid);
  await sess.session.stop(); // disconnect only — the room + record survive
  // Capture the final state (incl. any still-unsynced edits) AFTER the drain so
  // sentVersion is accurate, THEN stop persisting while keeping the record.
  await sess.persist.flush();
  void teardownSession(sess, /* keepRecord */ true);
  if (wasChip) updateChip(null);
}

/** Close a co-edited doc by ending/leaving its session (clears the record). */
async function closeEndOrLeaveSession(uid: string): Promise<void> {
  const sess = sessionFor(uid);
  if (!sess) return;
  await endOrLeaveSession(sess);
}

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  // Ends the FOCUSED doc's session (the one the user is looking at).
  const sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    showToast('No active session');
    return;
  }
  const isHost = sess.session.role === 'host';
  // In-app overlay, NOT window.confirm: Electron's native confirm on
  // Windows/Linux never hands keyboard focus back to the renderer —
  // the editor was untypeable until a reload (field bug, 2026-07-03).
  const choice = await promptForRouteChoice({
    message: isHost ? 'End the session for everyone?' : 'Leave the session?',
    choices: [
      {
        value: 'confirm',
        label: isHost ? 'End Session' : 'Leave Session',
        description: isHost ? 'Participants keep their current copy.' : 'Your copy stays as it is now.',
      },
    ],
  });
  if (choice !== 'confirm') return;
  await endOrLeaveSession(sess);
  deps.refreshPlugins();
  showToast(isHost ? 'Session ended' : 'Left the session');
  deps.getView()?.focus();
}

/** Test seam: the session the user is looking at (focused doc's, or the sole
 *  session), or null. */
export function activeSession(): CollabSession | null {
  return chipSession()?.session ?? null;
}
