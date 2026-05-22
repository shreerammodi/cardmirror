/**
 * Keybindings editor — one row per `RibbonCommandId`. Each row shows
 * the command label, its current bindings (overrides win over
 * defaults) as removable chips, a "+" button to capture a new
 * binding, and a "↺" reset that drops any override for that command
 * so the defaults take over again.
 *
 * Bindings are persisted via the `ribbonKeyOverrides` setting. When
 * that map changes, `index.ts` reconfigures the editor's plugin stack
 * so new bindings take effect immediately — no reload needed.
 *
 * Capture mode: clicking "+" replaces the button with a "Press a
 * key…" pill that listens for the next keydown. Pressing Escape
 * cancels. Keys that are just bare modifiers, or alpha keys without
 * any modifier (would intercept ordinary typing), are rejected.
 *
 * Conflict handling: if the captured key is already bound to another
 * command (via that command's override OR its built-in default), it
 * gets removed from that other command's binding set first — so a
 * single key can only ever fire one command, and the editor's last-
 * touched command wins. The displaced command is left without that
 * key (its default array is materialized into an override that omits
 * the displaced key), and a small inline note flashes briefly on the
 * editor to surface the change.
 */

import {
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  DEFAULT_RIBBON_KEYS,
  ribbonKeyStringFor,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { RIBBON_GROUPS } from './ribbon-groups.js';
import { settings } from './settings.js';

function getOverrides(): Partial<Record<RibbonCommandId, string | string[]>> {
  return settings.get('ribbonKeyOverrides');
}

/** Resolved key list for a command — overrides win over defaults, and
 *  single-string specs are normalized to arrays. Empty strings stay
 *  in the array (they're meaningless for display but the override
 *  map uses them to signal "explicitly unbound" — we filter those
 *  out at the chip-rendering level). */
function resolvedKeys(id: RibbonCommandId): string[] {
  const overrides = getOverrides();
  const spec = id in overrides ? overrides[id]! : DEFAULT_RIBBON_KEYS[id];
  const arr = Array.isArray(spec) ? spec : [spec];
  return arr.filter((k) => typeof k === 'string') as string[];
}

/** Mutator: write a normalized key list back to the override map for
 *  a single command. Always overwrites (so once a row has been
 *  touched, defaults stop applying — explicit list wins). */
function setOverrideKeys(id: RibbonCommandId, keys: string[]): void {
  const next = { ...getOverrides() };
  // Normalize: store strings as strings when there's exactly one
  // non-empty entry, arrays otherwise. Keeps the JSON-persisted shape
  // compact for the common single-key case.
  const filtered = keys.filter((k) => k.length > 0);
  if (filtered.length === 1) {
    next[id] = filtered[0]!;
  } else if (filtered.length === 0) {
    // Explicitly unbound — store empty array so it overrides defaults.
    next[id] = [];
  } else {
    next[id] = filtered;
  }
  settings.set('ribbonKeyOverrides', next);
}

/** Drop any override entry for `id`, falling back to defaults. */
function clearOverride(id: RibbonCommandId): void {
  const next = { ...getOverrides() };
  delete next[id];
  settings.set('ribbonKeyOverrides', next);
}

/**
 * Find any command that currently has `key` in its resolved bindings.
 * Returns the first hit (callers use it to dislodge a conflicting
 * binding before installing the new one).
 */
function findConflict(
  key: string,
  excludeId: RibbonCommandId,
): RibbonCommandId | null {
  for (const id of RIBBON_COMMAND_IDS) {
    if (id === excludeId) continue;
    if (resolvedKeys(id).includes(key)) return id;
  }
  return null;
}

/** Remove `key` from `id`'s binding set. If the result equals the
 *  default exactly, the override is dropped; otherwise the trimmed
 *  list becomes the new override. */
function removeKeyFromCommand(id: RibbonCommandId, key: string): void {
  const current = resolvedKeys(id).filter((k) => k !== key);
  setOverrideKeys(id, current);
}

/**
 * Validate a candidate key string. Returns an error message or
 * `null` if the key is acceptable.
 */
function validateKey(key: string, raw: KeyboardEvent): string | null {
  if (!key) return 'No key detected.';
  // Bare modifier press — `Mod-Control` etc. — has no actual key.
  // ribbonKeyStringFor returns just modifiers in that case.
  const segments = key.split('-');
  const final = segments[segments.length - 1] ?? '';
  if (['Mod', 'Alt', 'Shift', 'Control', 'Meta'].includes(final)) {
    return 'Press a key together with the modifier.';
  }
  // Reject Escape / Tab / Enter / Space / arrows / etc. that we don't
  // want to claim. Anything single-character without a modifier is
  // also rejected (would intercept regular typing).
  if (
    final === 'Escape' ||
    final === 'Tab' ||
    final === 'Enter' ||
    final === ' '
  ) {
    return 'That key is reserved.';
  }
  if (
    final.length === 1 &&
    !raw.ctrlKey &&
    !raw.metaKey &&
    !raw.altKey
  ) {
    return 'Single-character keys must include Ctrl/Cmd/Alt.';
  }
  return null;
}

export function buildKeybindingsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-keybindings-editor';

  // Group order + within-group order both come from RIBBON_GROUPS
  // — same taxonomy + ordering the Keyboard Shortcuts reference
  // modal uses, so the rebinding editor and the cheat sheet stay
  // visually aligned. The drift guard in `ribbon-groups.ts`
  // guarantees every `RibbonCommandId` is in exactly one group.

  let activeCapture: { row: HTMLElement; cleanup: () => void } | null = null;

  function exitCapture(): void {
    if (!activeCapture) return;
    activeCapture.cleanup();
    activeCapture = null;
  }

  function flashConflict(row: HTMLElement, msg: string): void {
    const note = row.querySelector<HTMLElement>('.pmd-keybinding-note');
    if (!note) return;
    note.textContent = msg;
    note.classList.add('pmd-keybinding-note-visible');
    window.setTimeout(() => {
      note.classList.remove('pmd-keybinding-note-visible');
    }, 2400);
  }

  function startCapture(id: RibbonCommandId, row: HTMLElement): void {
    if (activeCapture) exitCapture();
    const addBtn = row.querySelector<HTMLButtonElement>('.pmd-keybinding-add');
    const capturePill =
      row.querySelector<HTMLElement>('.pmd-keybinding-capture');
    if (!addBtn || !capturePill) return;
    addBtn.style.display = 'none';
    capturePill.style.display = '';
    capturePill.textContent = 'Press a key… (Esc cancels)';
    row.classList.add('pmd-keybinding-row-capturing');

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitCapture();
        return;
      }
      // Ignore bare modifier keydowns; wait for the real key.
      if (
        e.key === 'Control' ||
        e.key === 'Shift' ||
        e.key === 'Alt' ||
        e.key === 'Meta'
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const key = ribbonKeyStringFor(e);
      const err = validateKey(key, e);
      if (err) {
        flashConflict(row, err);
        return;
      }
      // Drop the same key from any other command that has it.
      const conflict = findConflict(key, id);
      if (conflict) {
        removeKeyFromCommand(conflict, key);
        flashConflict(
          row,
          `Removed ${formatKeyForDisplay(key)} from "${RIBBON_COMMAND_LABELS[conflict]}".`,
        );
      }
      const next = [...resolvedKeys(id)];
      if (!next.includes(key)) next.push(key);
      setOverrideKeys(id, next);
      exitCapture();
    };
    document.addEventListener('keydown', onKey, true);
    activeCapture = {
      row,
      cleanup: () => {
        document.removeEventListener('keydown', onKey, true);
        addBtn.style.display = '';
        capturePill.style.display = 'none';
        row.classList.remove('pmd-keybinding-row-capturing');
      },
    };
  }

  function renderRow(id: RibbonCommandId): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-keybinding-row';

    const label = document.createElement('span');
    label.className = 'pmd-keybinding-label';
    label.textContent = RIBBON_COMMAND_LABELS[id];
    row.appendChild(label);

    const chips = document.createElement('span');
    chips.className = 'pmd-keybinding-chips';
    row.appendChild(chips);

    const keys = resolvedKeys(id).filter((k) => k.length > 0);
    if (keys.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'pmd-keybinding-empty';
      empty.textContent = '—';
      chips.appendChild(empty);
    } else {
      for (const key of keys) {
        const chip = document.createElement('span');
        chip.className = 'pmd-keybinding-chip';
        const txt = document.createElement('span');
        txt.textContent = formatKeyForDisplay(key);
        chip.appendChild(txt);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'pmd-keybinding-chip-remove';
        remove.textContent = '×';
        remove.title = 'Remove this binding';
        remove.addEventListener('click', () => {
          removeKeyFromCommand(id, key);
        });
        chip.appendChild(remove);
        chips.appendChild(chip);
      }
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pmd-keybinding-add';
    addBtn.textContent = '+';
    addBtn.title = 'Add a binding';
    addBtn.addEventListener('click', () => startCapture(id, row));
    row.appendChild(addBtn);

    const capturePill = document.createElement('span');
    capturePill.className = 'pmd-keybinding-capture';
    capturePill.style.display = 'none';
    row.appendChild(capturePill);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pmd-keybinding-reset';
    resetBtn.textContent = '↺';
    resetBtn.title = 'Restore defaults for this command';
    resetBtn.addEventListener('click', () => clearOverride(id));
    row.appendChild(resetBtn);

    const note = document.createElement('span');
    note.className = 'pmd-keybinding-note';
    row.appendChild(note);

    return row;
  }

  function render(): void {
    exitCapture();
    wrap.innerHTML = '';

    const help = document.createElement('p');
    help.className = 'pmd-keybindings-help';
    help.textContent =
      'A key bound here only fires one command at a time — if you reuse a key, the previous command loses that binding.';
    wrap.appendChild(help);

    const list = document.createElement('div');
    list.className = 'pmd-keybindings-list';
    for (const group of RIBBON_GROUPS) {
      const section = document.createElement('section');
      section.className = 'pmd-keybindings-group';
      const heading = document.createElement('h3');
      heading.className = 'pmd-keybindings-group-title';
      heading.textContent = group.title;
      section.appendChild(heading);
      for (const id of group.commands) section.appendChild(renderRow(id));
      list.appendChild(section);
    }
    wrap.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'pmd-keybindings-footer';
    const restoreAll = document.createElement('button');
    restoreAll.type = 'button';
    restoreAll.className = 'pmd-keybindings-restore-all';
    restoreAll.textContent = 'Restore all defaults';
    restoreAll.addEventListener('click', () => {
      settings.set('ribbonKeyOverrides', {});
    });
    footer.appendChild(restoreAll);
    wrap.appendChild(footer);
  }

  // Re-render on any override change (writes from chip × / + / ↺ /
  // capture all flow through settings.set, which fires this subscriber).
  let lastOverrides = getOverrides();
  const unsubscribe = settings.subscribe((s) => {
    if (s.ribbonKeyOverrides !== lastOverrides) {
      lastOverrides = s.ribbonKeyOverrides;
      render();
    }
  });
  // Cancel the settings subscription when the editor leaves the
  // DOM (e.g., the settings modal closes). MutationObserver
  // replacement for the deprecated DOMNodeRemoved event.
  const obs = new MutationObserver(() => {
    if (!wrap.isConnected) {
      unsubscribe();
      obs.disconnect();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  render();
  return wrap;
}
