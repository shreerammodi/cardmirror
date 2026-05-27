/**
 * App home / start screen.
 *
 * A full-window view shown when the app launches without a
 * document, when the last open doc is closed, or via the Home
 * affordance in the chrome. Offers the primary entry points —
 * New document, New speech document, Open — plus a list of
 * recently opened files. A Study entry point is stubbed for a
 * later phase (the spaced-repetition practice interface).
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

export interface HomeScreenCallbacks {
  newDoc: () => void;
  newSpeechDoc: () => void;
  open: () => void;
  /** Reopen a recent file in-place. The renderer reads the
   *  handle, mounts the doc, and prunes the entry on failure. */
  openRecent: (recent: RecentFile) => void;
  /** Open the Quick Cards manage overlay. */
  manageQuickCards: () => void;
  /** Open the bulk .docx↔.cmir converter. Omitted (undefined) on
   *  hosts that can't do recursive folder I/O (the web edition), in
   *  which case the button isn't shown. */
  bulkConvert?: () => void;
}

class HomeScreen {
  private root!: HTMLDivElement;
  private recentsEl!: HTMLDivElement;
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

    // Number-key actions. Order matters: index 0/1/2/3 map to the
    // 1 / 2 / 3 / 4 keyboard shortcuts (handled in onKeyDown),
    // mirroring the number-key panels elsewhere in the UI. The first
    // three are the primary action cards; 4 is Manage quick cards
    // (its card is built further down).
    this.actionRunners = [
      () => this.callbacks?.newDoc(),
      () => this.callbacks?.newSpeechDoc(),
      () => this.callbacks?.open(),
      () => this.callbacks?.manageQuickCards(),
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

    // Quick Cards + Convert — below Recent, above the (forthcoming)
    // Learn section. Each is its own labeled group (heading + button)
    // sitting side by side in a card-width grid.
    const qcSection = document.createElement('section');
    qcSection.className = 'pmd-home-qc-section';
    const qcGrid = document.createElement('div');
    qcGrid.className = 'pmd-home-qc-actions';
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
    // Bulk convert — its own labeled group, to the right (Electron only).
    if (callbacks.bulkConvert) {
      qcGrid.appendChild(
        labeledGroup(
          'Convert',
          this.actionCard(
            'Bulk convert',
            'Batch-convert a file or folder between .docx and .cmir.',
            () => this.callbacks?.bulkConvert?.(),
          ),
        ),
      );
    }
    qcSection.appendChild(qcGrid);
    inner.appendChild(qcSection);

    // Learn — placeholder for the forthcoming spaced-repetition study
    // section. Non-interactive; here only to preview the layout.
    const learnSection = document.createElement('section');
    learnSection.className = 'pmd-home-learn-section';
    const learnTitle = document.createElement('h2');
    learnTitle.className = 'pmd-home-section-title';
    learnTitle.textContent = 'Learn';
    learnSection.appendChild(learnTitle);
    const learnActions = document.createElement('div');
    learnActions.className = 'pmd-home-qc-actions';
    const learnCard = document.createElement('div');
    learnCard.className = 'pmd-home-action pmd-home-action-placeholder';
    learnCard.setAttribute('aria-disabled', 'true');
    const learnT = document.createElement('span');
    learnT.className = 'pmd-home-action-title';
    learnT.textContent = 'Review flashcards';
    const learnS = document.createElement('span');
    learnS.className = 'pmd-home-action-sub';
    learnS.textContent = 'Spaced-repetition study — coming soon.';
    learnCard.append(learnT, learnS);
    learnActions.appendChild(learnCard);
    learnSection.appendChild(learnActions);
    inner.appendChild(learnSection);

    parent.appendChild(this.root);

    this.unsubscribe = subscribeRecents(() => this.renderRecents());
    this.renderRecents();
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
    // opened a file); re-read.
    this.renderRecents();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    document.documentElement.classList.remove('pmd-home-active');
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Esc dismisses back to the document only when there's one to
    // return to. Otherwise Esc does nothing (home is the hub).
    if (e.key === 'Escape' && this.canReturnToDoc) {
      e.preventDefault();
      this.hide();
      return;
    }
    // 1 / 2 / 3 / 4 trigger New / New speech / Open / Manage quick
    // cards, mirroring the number-key button panels elsewhere. Bare
    // keys only — the home screen has no text inputs to conflict with,
    // but still ignore the chord variants so a stray modifier doesn't
    // fire an action unexpectedly.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = { '1': 0, '2': 1, '3': 2, '4': 3 }[e.key];
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

  private actionCard(title: string, sub: string, onClick: () => void): HTMLButtonElement {
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
    btn.addEventListener('click', onClick);
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
