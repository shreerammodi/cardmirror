/**
 * App home / start screen.
 *
 * A full-window view shown when the app launches without a
 * document, when the last open doc is closed, or via the Home
 * affordance in the chrome. Offers the primary entry points —
 * New document, New speech document, Open — plus recently opened
 * files, utility groups (Clean / Convert / Compress / Quick
 * Cards), and the Learn section (spaced-repetition review).
 *
 * Visibility is driven by the `pmd-home-active` class on
 * `documentElement`: CSS hides the ribbon / nav pane / editor /
 * status bar while it's set, and reveals `.pmd-home-screen`.
 * The screen itself is mounted once and toggled.
 *
 * All actions are host-agnostic callbacks supplied by the
 * renderer (index.ts), which owns the actual new-doc / open /
 * load-in-place logic.
 */

import {
  listRecents,
  subscribeRecents,
  clearRecents,
  type RecentFile,
} from './recents-store.js';
import { learnStore, localToday } from './learn-store-host.js';
import { getElectronHost } from './host/index.js';
import { openLearnSession } from './learn-session-ui.js';
import { openLearnManage } from './learn-manage-ui.js';
import type { Scope } from './learn-store.js';
import { isAnyOverlayOpen } from './overlay-stack.js';
import { isEditableTarget } from './editable-target.js';
import { collabEnabled } from './collab/collab-gate.js';
import {
  listSessionRecords,
  deleteSessionRecord,
  subscribeSessionRecords,
  type PersistedSessionRecord,
} from './collab/collab-store.js';

export interface HomeScreenCallbacks {
  newDoc: () => void;
  newSpeechDoc: () => void;
  open: () => void;
  /** Reopen a recent file in-place. The renderer reads the
   *  handle, mounts the doc, and prunes the entry on failure. */
  openRecent: (recent: RecentFile) => void;
  /** Open the Quick Cards manage overlay. */
  manageQuickCards: () => void;
  /** Open the .docx style cleaner. Electron-only (recursive folder I/O +
   *  write-to-path), like bulkConvert; omitted on the web edition. */
  clean?: () => void;
  /** Open the bulk .docx↔.cmir converter. Omitted (undefined) on
   *  hosts that can't do recursive folder I/O (the web edition), in
   *  which case the button isn't shown. */
  bulkConvert?: () => void;
  /** Open the (temporary) bulk-compress migration tool. Electron-only,
   *  same as bulkConvert. */
  bulkCompress?: () => void;
  /** Resume a persisted collaboration session in this window (M3).
   *  Only consulted while the collab gate is open. */
  resumeSession?: (roomId: string) => void;
}

class HomeScreen {
  private root!: HTMLDivElement;
  private recentsEl!: HTMLDivElement;
  private sessionsSection!: HTMLElement;
  private sessionsEl!: HTMLDivElement;
  private learnEl!: HTMLDivElement;
  private backBtn!: HTMLButtonElement;
  private callbacks: HomeScreenCallbacks | null = null;
  private unsubscribe: (() => void) | null = null;
  private visible = false;
  /** Whether the current showing was opened over a live document
   *  (Home button) vs. over a blank starter (launch / close-doc).
   *  Drives the "Back to document" affordance + Esc dismissal. */
  private canReturnToDoc = false;
  /** Index-aligned action runners for the 1 / 2 / 3 shortcuts. */
  private actionRunners: Array<() => void> = [];

  mount(parent: HTMLElement, callbacks: HomeScreenCallbacks): void {
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.className = 'pmd-home-screen';
    this.root.hidden = true;

    const inner = document.createElement('div');
    inner.className = 'pmd-home-inner';
    this.root.appendChild(inner);

    const header = document.createElement('header');
    header.className = 'pmd-home-header';
    // "Back to document" — only meaningful when home was opened
    // over a live doc (Home button). Hidden otherwise.
    this.backBtn = document.createElement('button');
    this.backBtn.type = 'button';
    this.backBtn.className = 'pmd-home-back';
    this.backBtn.textContent = '← Back to document';
    this.backBtn.hidden = true;
    this.backBtn.addEventListener('click', () => this.hide());
    header.appendChild(this.backBtn);
    const title = document.createElement('h1');
    title.className = 'pmd-home-title';
    title.textContent = 'CardMirror';
    header.appendChild(title);
    const tagline = document.createElement('p');
    tagline.className = 'pmd-home-tagline';
    tagline.textContent = 'Open a document to start, or pick up where you left off.';
    header.appendChild(tagline);
    inner.appendChild(header);

    // Number-key actions: index 0..8 map to the 1..9 shortcuts (see
    // onKeyDown), in reading order down the page — 1-3 primary action
    // cards, 4 Clean, 5 Bulk convert, 6 Bulk compress, 7 Manage quick
    // cards, 8 Review all, 9 Manage flashcards. Runners guard on the
    // same conditions that show their card, so a key only fires when
    // its button is on screen.
    this.actionRunners = [
      () => this.callbacks?.newDoc(),
      () => this.callbacks?.newSpeechDoc(),
      () => this.callbacks?.open(),
      () => this.callbacks?.clean?.(),
      () => this.callbacks?.bulkConvert?.(),
      () => this.callbacks?.bulkCompress?.(),
      () => this.callbacks?.manageQuickCards(),
      () => {
        if (learnStore.totalCount({ kind: 'all' }) > 0) {
          openLearnSession({ kind: 'all' }, { title: 'Review — all' });
        }
      },
      // Manage is always reachable — even with zero cards, the user
      // may want to import flashcards from a file.
      () => openLearnManage(),
    ];
    const actions = document.createElement('div');
    actions.className = 'pmd-home-actions';
    actions.appendChild(
      this.actionCard('New document', 'Create a new document.', this.actionRunners[0]!),
    );
    actions.appendChild(
      this.actionCard(
        'New speech document',
        'Create a new document and designate it as the speech doc.',
        this.actionRunners[1]!,
      ),
    );
    actions.appendChild(
      this.actionCard('Open…', 'Browse for a .cmir or .docx file.', this.actionRunners[2]!),
    );
    inner.appendChild(actions);

    // Recent files.
    const recentsSection = document.createElement('section');
    recentsSection.className = 'pmd-home-recents-section';
    const recentsHeader = document.createElement('div');
    recentsHeader.className = 'pmd-home-recents-header';
    const recentsTitle = document.createElement('h2');
    recentsTitle.className = 'pmd-home-section-title';
    recentsTitle.textContent = 'Recent';
    recentsHeader.appendChild(recentsTitle);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pmd-home-recents-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear the recent-files list';
    clearBtn.addEventListener('click', () => clearRecents());
    recentsHeader.appendChild(clearBtn);
    recentsSection.appendChild(recentsHeader);

    this.recentsEl = document.createElement('div');
    this.recentsEl.className = 'pmd-home-recents';
    recentsSection.appendChild(this.recentsEl);
    inner.appendChild(recentsSection);

    // Collaboration sessions — a DEDICATED section right below Recent,
    // deliberately NOT merged into the recents list: normal doc churn
    // caps recents at 6 and would displace a shared session, and a
    // session someone shared with you must never get lost. The list
    // scrolls when long (CSS max-height). Hidden entirely when the
    // collab gate is closed or no session records exist.
    this.sessionsSection = document.createElement('section');
    this.sessionsSection.className = 'pmd-home-sessions-section';
    this.sessionsSection.hidden = true;
    const sessionsTitle = document.createElement('h2');
    sessionsTitle.className = 'pmd-home-section-title';
    sessionsTitle.textContent = 'Sessions';
    this.sessionsSection.appendChild(sessionsTitle);
    this.sessionsEl = document.createElement('div');
    this.sessionsEl.className = 'pmd-home-sessions';
    this.sessionsSection.appendChild(this.sessionsEl);
    inner.appendChild(this.sessionsSection);

    // Utilities — below Recent. Each is its own labeled group (heading
    // + button) sitting side by side in a card-width grid. Order:
    // Clean, Convert, Compress, Quick Cards (matching the number-key
    // order: Clean 4, Convert 5, Compress 6, Quick Cards 7).
    const qcSection = document.createElement('section');
    qcSection.className = 'pmd-home-qc-section';
    const qcGrid = document.createElement('div');
    qcGrid.className = 'pmd-home-qc-actions';
    // Electron does folder-recursive batches; the web edition does one file at a
    // time, so the copy differs. Both surfaces share the same card.
    const desktop = getElectronHost() !== null;
    // Clean — .docx style cleaner.
    if (callbacks.clean) {
      qcGrid.appendChild(
        labeledGroup(
          'Clean',
          this.actionCard(
            'Clean styles',
            desktop
              ? 'Clean a .docx file or folder’s styles to the Verbatim standard.'
              : 'Clean a .docx file’s styles to the Verbatim standard.',
            () => this.callbacks?.clean?.(),
          ),
        ),
      );
    }
    // Bulk convert — its own labeled group.
    if (callbacks.bulkConvert) {
      qcGrid.appendChild(
        labeledGroup(
          'Convert',
          this.actionCard(
            desktop ? 'Bulk convert' : 'Convert',
            desktop
              ? 'Batch-convert a file or folder between .docx and .cmir.'
              : 'Convert a file between .docx and .cmir.',
            () => this.callbacks?.bulkConvert?.(),
          ),
        ),
      );
    }
    // Bulk compress — temporary migration tool.
    if (callbacks.bulkCompress) {
      qcGrid.appendChild(
        labeledGroup(
          'Compress',
          this.actionCard(
            desktop ? 'Bulk compress' : 'Compress',
            desktop
              ? 'Shrink every .cmir in a folder (~10× smaller), in place.'
              : 'Shrink a .cmir file (~10× smaller).',
            () => this.callbacks?.bulkCompress?.(),
          ),
        ),
      );
    }
    qcGrid.appendChild(
      labeledGroup(
        'Quick Cards',
        this.actionCard(
          'Manage quick cards',
          'Browse, edit, import, and export your reusable snippets.',
          () => this.callbacks?.manageQuickCards(),
        ),
      ),
    );
    // Learn — spaced-repetition review, a two-column group to the right
    // of Quick Cards so the utilities fill two rows: Clean / Convert /
    // Compress, then Quick Cards / Learn. Content is rebuilt from the
    // learn store (due counts per scope) on store changes + each show.
    this.learnEl = document.createElement('div');
    this.learnEl.className = 'pmd-home-learn';
    const learnGroup = labeledGroup('Learn', this.learnEl);
    learnGroup.classList.add('pmd-home-labeled-learn');
    qcGrid.appendChild(learnGroup);
    qcSection.appendChild(qcGrid);
    inner.appendChild(qcSection);

    parent.appendChild(this.root);

    this.unsubscribe = subscribeRecents(() => this.renderRecents());
    learnStore.subscribe(() => this.renderLearn());
    subscribeSessionRecords(() => void this.renderSessions());
    this.renderRecents();
    void this.renderSessions();
    this.renderLearn();
  }

  /** Show the home screen. `canReturnToDoc` (default false) is set
   *  when invoked over a live document (the Home button) so the
   *  user can dismiss back to that doc via the Back button or Esc.
   *  On launch / close-doc there's nothing behind home, so it's
   *  left false and home is the only way forward. */
  show(opts: { canReturnToDoc?: boolean } = {}): void {
    // No-op when never mounted (multi-pane mode doesn't mount the
    // home screen). Lets the goHome ribbon command be a safe
    // no-op there rather than throwing on an undefined root.
    if (!this.root) return;
    this.canReturnToDoc = !!opts.canReturnToDoc;
    this.backBtn.hidden = !this.canReturnToDoc;
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    document.documentElement.classList.add('pmd-home-active');
    document.addEventListener('keydown', this.onKeyDown);
    // Recents may have changed since last shown (another window
    // opened a file); re-read. Same for the learn counts (cards may
    // have been created while a doc was open).
    this.renderRecents();
    void this.renderSessions();
    this.renderLearn();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    document.documentElement.classList.remove('pmd-home-active');
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Stand down when a modal is layered over the home screen (the shared
    // overlay stack) or focus is in a text field (the command bar, a dialog
    // input). Otherwise the Esc / 1-9 shortcuts fire over the modal and swallow
    // number input the user meant for it.
    if (isAnyOverlayOpen() || isEditableTarget(e.target)) return;
    // Esc dismisses back to the document only when there's one to
    // return to. Otherwise Esc does nothing (home is the hub).
    if (e.key === 'Escape' && this.canReturnToDoc) {
      e.preventDefault();
      this.hide();
      return;
    }
    // 1-9 trigger New / New speech / Open / Clean / Bulk convert / Bulk
    // compress / Manage quick cards / Review all / Manage flashcards,
    // mirroring the number-key button panels elsewhere. Bare keys only — the
    // home screen has no text inputs to conflict with, but still ignore the
    // chord variants so a stray modifier doesn't fire an action unexpectedly.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8 }[e.key];
    if (idx === undefined) return;
    const run = this.actionRunners[idx];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  isVisible(): boolean {
    return this.visible;
  }

  // ---- Rendering ----------------------------------------------------

  private actionCard(
    title: string,
    sub: string,
    onClick: () => void,
    opts?: { disabled?: boolean },
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-home-action';
    const t = document.createElement('span');
    t.className = 'pmd-home-action-title';
    t.textContent = title;
    btn.appendChild(t);
    const s = document.createElement('span');
    s.className = 'pmd-home-action-sub';
    s.textContent = sub;
    btn.appendChild(s);
    if (opts?.disabled) {
      btn.classList.add('pmd-home-action-disabled');
      btn.disabled = true;
    } else {
      btn.addEventListener('click', onClick);
    }
    return btn;
  }

  private renderRecents(): void {
    const recents = listRecents();
    this.recentsEl.innerHTML = '';
    if (recents.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-home-recents-empty';
      empty.textContent = 'No recent files yet.';
      this.recentsEl.appendChild(empty);
      return;
    }
    for (const r of recents) {
      this.recentsEl.appendChild(this.recentRow(r));
    }
  }

  /** Rebuild the Sessions section from the collab store. Hidden when
   *  the gate is closed or no records exist; otherwise one row per
   *  persisted session, newest first (the list scrolls via CSS). */
  private async renderSessions(): Promise<void> {
    if (!this.sessionsSection) return;
    if (!collabEnabled()) {
      this.sessionsSection.hidden = true;
      return;
    }
    const records = await listSessionRecords();
    this.sessionsSection.hidden = records.length === 0;
    this.sessionsEl.innerHTML = '';
    for (const r of records) {
      this.sessionsEl.appendChild(this.sessionRow(r));
    }
  }

  private sessionRow(record: PersistedSessionRecord): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-home-session';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pmd-home-session-open';
    row.title = 'Resume this collaboration session';

    const chip = document.createElement('span');
    chip.className = 'pmd-home-recent-format pmd-home-session-role';
    chip.textContent = record.role === 'host' ? 'HOST' : 'JOINED';
    row.appendChild(chip);

    const name = document.createElement('span');
    name.className = 'pmd-home-recent-name';
    name.textContent = record.docTitle || 'Collaboration session';
    name.title = name.textContent;
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'pmd-home-recent-path';
    meta.textContent = `last synced ${relativeTime(record.updatedAt)}`;
    row.appendChild(meta);

    row.addEventListener('click', () => this.callbacks?.resumeSession?.(record.roomId));
    wrap.appendChild(row);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'pmd-home-session-forget';
    forget.textContent = '✕';
    forget.title = 'Forget this session (your partner is unaffected)';
    forget.setAttribute('aria-label', 'Forget this session');
    forget.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteSessionRecord(record.roomId);
    });
    wrap.appendChild(forget);

    return wrap;
  }

  /** Rebuild the Learn section from the local store: an "all due"
   *  action card plus a per-file / per-deck breakdown of anything with
   *  cards due today. Empty when no flashcards exist yet. */
  private renderLearn(): void {
    if (!this.learnEl) return;
    const today = localToday();
    this.learnEl.innerHTML = '';

    const totalAll = learnStore.totalCount({ kind: 'all' });
    if (totalAll === 0) {
      // No cards yet: there's nothing to review, but Manage is still
      // reachable so the user can import flashcards from a file. Grey
      // out Review all only — keep Manage live.
      const actions = document.createElement('div');
      actions.className = 'pmd-home-learn-actions';
      actions.appendChild(
        this.actionCard(
          'Review all',
          'No flashcards yet — select text in a document and choose Create Flashcard.',
          () => {},
          { disabled: true },
        ),
      );
      actions.appendChild(
        this.actionCard(
          'Manage flashcards',
          'Import flashcards from a file, or browse once you have some.',
          () => openLearnManage(),
        ),
      );
      this.learnEl.appendChild(actions);
      return;
    }

    const dueAll = learnStore.dueCount({ kind: 'all' }, today);
    const actions = document.createElement('div');
    actions.className = 'pmd-home-learn-actions';
    actions.appendChild(
      this.actionCard(
        dueAll > 0 ? `Review all due (${dueAll})` : 'Review all',
        dueAll > 0
          ? `${dueAll} due · ${totalAll} total`
          : `All caught up · ${totalAll} total`,
        () => openLearnSession({ kind: 'all' }, { title: 'Review — all' }),
      ),
    );
    actions.appendChild(
      this.actionCard(
        'Manage flashcards',
        'Browse, edit, suspend, and delete your flashcards by file.',
        () => openLearnManage(),
      ),
    );
    this.learnEl.appendChild(actions);

    // Per-scope breakdown — only scopes with something due today, to
    // keep the list short and actionable.
    const rows: Array<{ label: string; due: number; scope: Scope }> = [];
    for (const doc of learnStore.listDocs()) {
      const due = learnStore.dueCount({ kind: 'file', docId: doc.docId }, today);
      if (due > 0) rows.push({ label: doc.lastName, due, scope: { kind: 'file', docId: doc.docId } });
    }
    for (const deck of learnStore.listDecks()) {
      const due = learnStore.dueCount({ kind: 'deck', deckId: deck.deckId }, today);
      if (due > 0) rows.push({ label: deck.name, due, scope: { kind: 'deck', deckId: deck.deckId } });
    }
    if (rows.length > 0) {
      rows.sort((a, b) => b.due - a.due);
      const list = document.createElement('div');
      list.className = 'pmd-home-learn-rows';
      for (const r of rows) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pmd-home-learn-row';
        const badge = document.createElement('span');
        badge.className = 'pmd-home-learn-badge';
        badge.textContent = String(r.due);
        const name = document.createElement('span');
        name.className = 'pmd-home-learn-name';
        name.textContent = stripKnownExt(r.label);
        name.title = r.label;
        row.append(badge, name);
        row.addEventListener('click', () => openLearnSession(r.scope, { title: `Review — ${stripKnownExt(r.label)}` }));
        list.appendChild(row);
      }
      this.learnEl.appendChild(list);
    }
  }

  private recentRow(recent: RecentFile): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pmd-home-recent';
    // Web entries (handle === null) can't be reopened directly —
    // dim them and disable the click.
    const reopenable = recent.handle != null;
    if (!reopenable) {
      row.classList.add('pmd-home-recent-unavailable');
      row.disabled = true;
      row.title = 'This file was opened in the browser edition and can\'t be reopened from here.';
    } else {
      row.title = recent.handle ?? recent.filename;
    }

    const fmt = document.createElement('span');
    fmt.className = `pmd-home-recent-format pmd-home-recent-format-${recent.format ?? 'unknown'}`;
    fmt.textContent = (recent.format ?? '?').toUpperCase();
    row.appendChild(fmt);

    const name = document.createElement('span');
    name.className = 'pmd-home-recent-name';
    // The format chip already shows .cmir / .docx, so drop the
    // extension from the displayed name to reduce redundancy.
    name.textContent = stripKnownExt(recent.filename);
    name.title = recent.filename;
    row.appendChild(name);

    const path = document.createElement('span');
    path.className = 'pmd-home-recent-path';
    path.textContent = recent.handle ?? '';
    row.appendChild(path);

    if (reopenable) {
      row.addEventListener('click', () => this.callbacks?.openRecent(recent));
    }
    return row;
  }
}

/** Compact "3m ago" / "2h ago" / "5d ago" for session rows. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A heading stacked above a single action card — used for the
 *  side-by-side Quick Cards / Convert groups so each gets its own
 *  label (like the Quick Cards heading above its button). */
function labeledGroup(title: string, card: HTMLElement): HTMLDivElement {
  const group = document.createElement('div');
  group.className = 'pmd-home-labeled';
  const h = document.createElement('h2');
  h.className = 'pmd-home-section-title';
  h.textContent = title;
  group.append(h, card);
  return group;
}

/** Drop a trailing `.cmir` / `.docx` extension for display. */
function stripKnownExt(name: string): string {
  return name.replace(/\.(cmir|docx)$/i, '');
}

export const homeScreen = new HomeScreen();
