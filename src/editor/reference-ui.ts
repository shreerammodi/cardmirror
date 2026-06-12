/**
 * Keyboard-shortcut reference modal. A read-only "cheat sheet" view
 * of the ribbon's bound F-keys / Mod-keys, grouped conceptually.
 *
 * The thematic grouping is now shared with the Settings →
 * Keybindings editor — see `ribbon-groups.ts`. The drift-guard
 * assertion lives there too, so both surfaces stay in sync.
 */

import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_LABELS,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { RIBBON_GROUPS } from './ribbon-groups.js';
import { isRibbonCommandAvailable } from './ribbon-availability.js';
import { settings } from './settings.js';
import { setIcon } from './icons';


class ReferenceModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  /** Live filter query for the searchbar — kept on the instance
   *  so reopening the modal preserves the last search. */
  private searchQuery = '';

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-reference-overlay';
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-reference-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (this.overlay.style.display !== 'none' && e.key === 'Escape') {
        this.close();
      }
    });

    document.body.appendChild(this.overlay);
  }

  open(): void {
    this.render();
    this.overlay.style.display = '';
  }

  close(): void {
    this.overlay.style.display = 'none';
  }

  private render(): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-reference-header';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-reference-close';
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const searchRow = document.createElement('div');
    searchRow.className = 'pmd-reference-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'pmd-reference-search-input';
    searchInput.placeholder = 'Search shortcuts…';
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.applyFilter();
    });
    searchRow.appendChild(searchInput);
    this.dialog.appendChild(searchRow);

    const body = document.createElement('div');
    body.className = 'pmd-reference-body';

    for (const group of RIBBON_GROUPS) {
      // Hide commands that don't apply here (Flow off Windows, voice off
      // desktop, the cutter while disabled), and skip a group entirely
      // when none of its commands are available.
      const ids = group.commands.filter(isRibbonCommandAvailable);
      if (ids.length === 0) continue;

      const section = document.createElement('section');
      section.className = 'pmd-reference-group';

      const heading = document.createElement('h3');
      heading.className = 'pmd-reference-group-title';
      heading.textContent = group.title;
      section.appendChild(heading);

      const rows = document.createElement('div');
      rows.className = 'pmd-reference-group-rows';

      for (const id of ids) {
        const row = document.createElement('div');
        row.className = 'pmd-reference-row';

        // Live overrides from settings take precedence over defaults
        // so the cheat sheet always reflects the user's current
        // bindings (including unbound / freshly-customized commands).
        const overrides = settings.get('ribbonKeyOverrides');
        const keySpec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
        const keys = Array.isArray(keySpec) ? keySpec : [keySpec];
        const keyText = keys
          .map((k) => formatKeyForDisplay(k))
          .filter((s) => s.length > 0)
          .join(' / ');

        const keyEl = document.createElement('span');
        keyEl.className = 'pmd-reference-key';
        keyEl.textContent = keyText || '—';
        row.appendChild(keyEl);

        const labelEl = document.createElement('span');
        labelEl.className = 'pmd-reference-label';
        labelEl.textContent = RIBBON_COMMAND_LABELS[id];
        row.appendChild(labelEl);

        rows.appendChild(row);
      }

      section.appendChild(rows);
      body.appendChild(section);
    }

    this.dialog.appendChild(body);

    // Apply the persisted search (if the modal was reopened with a
    // query already typed) so the rebuilt rows reflect it without
    // requiring the user to re-type.
    this.applyFilter();
  }

  /** Show / hide rows + group sections per `searchQuery`. Match is
   *  case-insensitive substring against each row's label OR its
   *  current keybinding text. Empty groups collapse so a stranded
   *  section heading doesn't sit alone. */
  private applyFilter(): void {
    const q = this.searchQuery.trim().toLowerCase();
    const sections = this.dialog.querySelectorAll<HTMLElement>(
      '.pmd-reference-group',
    );
    for (const section of sections) {
      let anyVisible = false;
      for (const row of section.querySelectorAll<HTMLElement>(
        '.pmd-reference-row',
      )) {
        const label = (
          row.querySelector('.pmd-reference-label')?.textContent ?? ''
        ).toLowerCase();
        const keyText = (
          row.querySelector('.pmd-reference-key')?.textContent ?? ''
        ).toLowerCase();
        const hit = !q || label.includes(q) || keyText.includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) anyVisible = true;
      }
      section.style.display = anyVisible ? '' : 'none';
    }
  }
}

let modal: ReferenceModal | null = null;

export function openReference(): void {
  if (!modal) modal = new ReferenceModal();
  modal.open();
}
