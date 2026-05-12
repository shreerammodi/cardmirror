/**
 * Minimal browser editor — v0.
 *
 * Mounts a ProseMirror EditorView with our schema. Lets the user drop a
 * .docx, see it rendered, and export it back. This exists as a visual
 * sanity check while we build the foundation; full editor UX (read mode,
 * navigation panel, send-to-speech, drag-and-drop, etc.) is later work.
 */

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocx, toDocx } from '../index.js';
import { NavigationPanel } from './nav-panel.js';
import { openSettings } from './settings-ui.js';
import {
  settings,
  DISPLAY_SIZE_KEYS,
  DISPLAY_COLOR_KEYS,
  type DisplaySizes,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
} from './settings.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from './read-mode-plugin.js';
import { absorbPlugin } from './absorb-plugin.js';
import { citeClassifierPlugin } from './cite-classifier-plugin.js';
import { namedStyleNormalizerPlugin } from './named-style-normalizer-plugin.js';
import { fontSizeClassPlugin } from './font-size-class-plugin.js';
import { buildPastePlugin, togglePlainPaste } from './paste-plugin.js';
import { editorDragSurface } from './drag-editor-surface.js';
import {
  backspaceAtTagStart,
  backspaceAtFirstBodyStart,
  deleteAtTagEnd,
  deleteAtContainerEnd,
  enterMidTag,
  enterAtTagEnd,
  enterInHeading,
} from './tag-keymap.js';
import {
  buildRibbonKeymap,
  getRibbonCommand,
  formatKeyForDisplay,
  primaryKeyFor,
  ribbonKeyStringFor,
  ribbonCommandForKey,
  RIBBON_COMMAND_LABELS,
  type StructuralRibbonCommandId,
  type RibbonContext,
} from './ribbon-commands.js';
import { openWordCount } from './word-count-ui.js';
import { wireColorPanel } from './color-panel.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';

const editorEl = document.getElementById('editor')!;
const navEl = document.getElementById('nav-panel')!;
const dropzone = document.getElementById('dropzone') as HTMLInputElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;
const wordCountBtn = document.getElementById('word-count-btn') as HTMLButtonElement;
const wordCountText = document.getElementById('word-count-text')!;
const plainPasteToggleBtn = document.getElementById('plain-paste-toggle-btn') as HTMLButtonElement | null;

function updatePlainPasteIndicator(armed: boolean): void {
  if (!plainPasteToggleBtn) return;
  plainPasteToggleBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
}
const zoomOutBtn = document.getElementById('zoom-out-btn') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in-btn') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoom-reset-btn') as HTMLButtonElement;
const zoomPct = document.getElementById('zoom-pct')!;

// Module-level state. Declared before the settings subscriber registers
// so that `applyReadMode` can read `view` without a temporal-dead-zone
// ReferenceError on initial call.
let view: EditorView | null = null;
let currentDoc: PMNode = makeStarterDoc();

// Live context for ribbon commands that read settings at keypress
// time — active highlight / shading color for F11 / Mod-F11; condense
// behavior flags for F3 / Alt-F3 / Mod-Alt-F3.
const ribbonContext: RibbonContext = {
  highlightColor: () => settings.get('lastHighlightColor'),
  shadingColor: () => settings.get('lastShadingColor'),
  paragraphIntegrity: () => settings.get('paragraphIntegrity'),
  usePilcrows: () => settings.get('usePilcrows'),
  headingMode: () => settings.get('headingMode'),
  condenseOnPaste: () => settings.get('condenseOnPaste'),
};

openBtn.addEventListener('click', () => dropzone.click());
settingsBtn.addEventListener('click', () => openSettings());
readModeBtn.addEventListener('click', () => settings.set('readMode', !settings.get('readMode')));
wordCountBtn.addEventListener('click', () => { if (view) openWordCount(view); });

// Zoom controls.
zoomOutBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') - 10));
zoomInBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') + 10));
zoomResetBtn.addEventListener('click', () => setZoom(100));

// Formatting panel — Verbatim-style ribbon buttons that dispatch the
// same commands as the F4–F7 / Mod-F7 keymap. Display mode and visual
// preview are both driven by settings (formattingPanelMode and
// formattingPanelPreview).
type FormattingPanelId =
  | StructuralRibbonCommandId
  | 'applyCite'
  | 'applyUnderline'
  | 'applyEmphasis';
const FORMATTING_PANEL_BUTTONS: Record<FormattingPanelId, string> = {
  setPocket: 'style-pocket-btn',
  setHat: 'style-hat-btn',
  setBlock: 'style-block-btn',
  setTag: 'style-tag-btn',
  setAnalytic: 'style-analytic-btn',
  setUndertag: 'style-undertag-btn',
  applyCite: 'cite-btn',
  applyUnderline: 'underline-btn',
  applyEmphasis: 'emphasis-btn',
};
const FORMATTING_PANEL_SHORT_LABEL: Record<FormattingPanelId, string> = {
  setPocket: 'Pocket',
  setHat: 'Hat',
  setBlock: 'Block',
  setTag: 'Tag',
  setAnalytic: 'Analytic',
  setUndertag: 'Undertag',
  applyCite: 'Cite',
  applyUnderline: 'Underline',
  applyEmphasis: 'Emphasis',
};
const formattingPanelEl = document.getElementById('formatting-panel') as HTMLElement | null;
const citePanelEl = document.getElementById('cite-panel') as HTMLElement | null;
const colorPanelEl = document.getElementById('color-panel') as HTMLElement | null;
const docOpsPanelEl = document.getElementById('doc-ops-panel') as HTMLElement | null;
const paragraphIntegrityBtn = document.getElementById('paragraph-integrity-btn') as HTMLButtonElement | null;
const formattingPanelBtnRefs: { id: FormattingPanelId; btn: HTMLButtonElement }[] = [];
for (const [id, btnId] of Object.entries(FORMATTING_PANEL_BUTTONS) as [FormattingPanelId, string][]) {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) continue;
  const label = RIBBON_COMMAND_LABELS[id];
  btn.setAttribute('aria-label', label);
  btn.addEventListener('mousedown', (e) => {
    // Don't steal focus from the editor — the command needs to act on
    // the paragraph that holds the live cursor.
    e.preventDefault();
  });
  btn.addEventListener('click', () => {
    if (!view) return;
    const cmd = getRibbonCommand(id);
    cmd(view.state, view.dispatch.bind(view));
    view.focus();
  });
  formattingPanelBtnRefs.push({ id, btn });
}

function applyFormattingPanel(mode: FormattingPanelMode, preview: boolean): void {
  if (!formattingPanelEl) return;
  formattingPanelEl.classList.toggle('hidden', mode === 'hidden');
  formattingPanelEl.classList.toggle('style-preview', preview);
  if (citePanelEl) {
    citePanelEl.classList.toggle('hidden', mode === 'hidden');
    citePanelEl.classList.toggle('style-preview', preview);
  }
  if (colorPanelEl) {
    colorPanelEl.classList.toggle('hidden', mode === 'hidden');
  }
  if (docOpsPanelEl) {
    docOpsPanelEl.classList.toggle('hidden', mode === 'hidden');
  }
  for (const { id, btn } of formattingPanelBtnRefs) {
    const keyDisplay = formatKeyForDisplay(primaryKeyFor(id));
    const shortLabel = FORMATTING_PANEL_SHORT_LABEL[id];
    const fullLabel = RIBBON_COMMAND_LABELS[id];
    // ' · ' matches the separator used in the status-bar read-time
    // display, so the visual rhythm is consistent across the chrome.
    btn.textContent =
      mode === 'shortcuts'
        ? (keyDisplay || shortLabel)
        : mode === 'both' && keyDisplay
        ? `${shortLabel} · ${keyDisplay}`
        : shortLabel;
    btn.title = keyDisplay ? `${fullLabel} (${keyDisplay})` : fullLabel;
  }
}

function setZoom(pct: number): void {
  const clamped = Math.max(50, Math.min(200, Math.round(pct / 10) * 10));
  settings.set('zoomPct', clamped);
}

function applyZoom(pct: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(pct / 100));
  zoomPct.textContent = `${pct}%`;
  zoomResetBtn.disabled = pct === 100;
}

/**
 * Push displaySizes into CSS custom properties on `#editor`. CSS rules
 * for each named style use `font-size: var(--pmd-size-<name>)`, so
 * updating these variables retypes the whole editor.
 */
function applyDisplaySizes(sizes: DisplaySizes): void {
  for (const key of DISPLAY_SIZE_KEYS) {
    editorEl.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
  }
}

/**
 * Push typography flags onto `#editor` as classes (predicated CSS) and
 * as a CSS custom property for the box thickness. Each boolean either
 * adds or removes a class; CSS rules selector-gated on those classes
 * apply the corresponding decoration.
 */
function applyDisplayTypography(t: DisplayTypography): void {
  editorEl.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  editorEl.classList.toggle('pmd-underline-bold', t.underlineBold);
  editorEl.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  editorEl.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  editorEl.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  editorEl.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  editorEl.classList.toggle('pmd-undertag-bold', t.undertagBold);
  editorEl.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
  // Mirror the undertag/cite/emphasis flags to documentElement so the
  // ribbon's formatting-panel preview (which lives outside #editor)
  // can react to the same settings.
  document.documentElement.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  document.documentElement.classList.toggle('pmd-undertag-bold', t.undertagBold);
  document.documentElement.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  document.documentElement.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  document.documentElement.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  document.documentElement.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  document.documentElement.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
}

/**
 * Push displayColors into CSS custom properties on the document root
 * so both the editor and the nav pane (which lives outside #editor)
 * inherit the same values. CSS rules consume `var(--pmd-color-*)`.
 */
function applyDisplayColors(c: DisplayColors): void {
  for (const key of DISPLAY_COLOR_KEYS) {
    document.documentElement.style.setProperty(`--pmd-color-${key}`, c[key]);
  }
}

/** CSS generic font categories — always available, picked by the
 *  browser per system. Don't quote these; quotes would turn them into
 *  literal font names that don't exist. */
const GENERIC_FONT_KEYWORDS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
]);

function applyBodyFont(font: string): void {
  // Set font-family as an inline style directly. Quoted form for named
  // fonts (handles spaces and avoids ambiguity with CSS keywords);
  // unquoted form for generic categories. Inline style on #editor wins
  // over the stylesheet rule and inherits to all descendants.
  const head = GENERIC_FONT_KEYWORDS.has(font) ? font : `"${font}"`;
  editorEl.style.fontFamily = `${head}, 'Helvetica Neue', sans-serif`;
}

function applyLineHeight(multiplier: number): void {
  editorEl.style.setProperty('--pmd-line-height', String(multiplier));
}

// Apply read-mode visual state and editing lockdown whenever the
// setting changes (and once now to handle the persisted value).
settings.subscribe((s) => {
  applyReadMode(s.readMode);
  applyZoom(s.zoomPct);
  applyDisplaySizes(s.displaySizes);
  applyDisplayTypography(s.displayTypography);
  applyDisplayColors(s.displayColors);
  applyBodyFont(s.bodyFont);
  applyLineHeight(s.lineHeight);
  applyFormattingPanel(s.formattingPanelMode, s.formattingPanelPreview);
  syncParagraphIntegrityBtn();
  refreshWordCount();
});
applyReadMode(settings.get('readMode'));
applyZoom(settings.get('zoomPct'));
applyDisplaySizes(settings.get('displaySizes'));
applyDisplayTypography(settings.get('displayTypography'));
applyDisplayColors(settings.get('displayColors'));
applyBodyFont(settings.get('bodyFont'));
applyLineHeight(settings.get('lineHeight'));
applyFormattingPanel(settings.get('formattingPanelMode'), settings.get('formattingPanelPreview'));

// Claim browser shortcuts for every ribbon binding. F3 (Find), F5
// (Reload), F7 (Caret Browse), F11 (Fullscreen), Mod-U (View Source),
// and others normally trigger browser UI. We listen in the BUBBLE
// phase (no `{ capture: true }`) so the editor's PM keymap on
// `view.dom` gets first crack at the event — PM bails out via
// `eventBelongsToView` if `event.defaultPrevented` is already set,
// so a capture-phase preventDefault would silently disable our own
// keymap. By the time this handler fires:
//   - If PM matched a binding it already called preventDefault, and
//     we skip (avoids double-firing the command).
//   - If PM didn't match (binding absent OR editor unfocused), we
//     preventDefault to block the browser's built-in action and, if
//     the editor exists, dispatch the matching ribbon command
//     manually.
// We look up the key string against the ribbon registry up-front and
// only preventDefault when it's actually bound — so plain typing,
// Mod-Z, and other PM/browser defaults that we don't claim pass
// through untouched.
// Some keys are un-preventable in some browsers (F11 in Firefox; F5 /
// F12 in some Chromium builds) — those are an OS/browser issue our
// future Electron build will sidestep entirely.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // Cheap early bail for typing: no modifier and not an F-key means
  // it can't be one of ours.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
  const keyString = ribbonKeyStringFor(e);
  const cmdId = ribbonCommandForKey(keyString);
  if (!cmdId) return;
  e.preventDefault();
  if (!view) return;
  const cmd = getRibbonCommand(cmdId, ribbonContext);
  cmd(view.state, view.dispatch.bind(view), view);
});

// Wire the color panel (split buttons + swatch pickers). Pass a ref
// object so the panel reads the live view through `view.view` even
// when the EditorView gets re-mounted (e.g. on docx import).
wireColorPanel({ get view() { return view; } });

// Paragraph Integrity toggle — clicking flips the setting; the
// settings subscriber below mirrors the live value into the
// aria-pressed attribute so the CSS reflects state.
if (paragraphIntegrityBtn) {
  paragraphIntegrityBtn.addEventListener('mousedown', (e) => e.preventDefault());
  paragraphIntegrityBtn.addEventListener('click', () => {
    settings.set('paragraphIntegrity', !settings.get('paragraphIntegrity'));
  });
}
function syncParagraphIntegrityBtn(): void {
  if (!paragraphIntegrityBtn) return;
  const on = settings.get('paragraphIntegrity');
  paragraphIntegrityBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
syncParagraphIntegrityBtn();

// Plain Paste toggle — clicking flips the paste-plugin's armed flag,
// same as pressing F2. The plugin's `onArmedChange` callback mirrors
// the new state back into `aria-pressed` (via updatePlainPasteIndicator).
if (plainPasteToggleBtn) {
  plainPasteToggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
  plainPasteToggleBtn.addEventListener('click', () => {
    if (!view) return;
    togglePlainPaste()(view.state, view.dispatch.bind(view));
  });
}

function refreshWordCount(): void {
  if (!view) {
    wordCountText.textContent = '—';
    return;
  }
  const sel = view.state.selection;
  const hasSelection = !sel.empty;
  const words = hasSelection
    ? countReadAloudWords(view.state.doc, sel.from, sel.to)
    : countReadAloudWords(view.state.doc);

  const readers = settings.get('readers').slice(0, 2);
  const head = hasSelection
    ? `Selection: ${formatNumber(words)}`
    : formatNumber(words);
  const parts = [head];
  for (const r of readers) {
    parts.push(`${r.name}: ${formatReadTime(words, r.wpm)}`);
  }
  wordCountText.textContent = parts.join(' · ');
}

function applyReadMode(on: boolean): void {
  editorEl.classList.toggle('pmd-read-mode', on);
  editorEl.classList.toggle(
    'pmd-rm-no-emphasis-borders',
    on && settings.get('hideEmphasisBordersInReadMode'),
  );
  readModeBtn.classList.toggle('pmd-active', on);
  if (view) {
    view.setProps({ editable: () => !on });
    // Force the read-mode plugin to (re)compute decorations. With the
    // optimization that skips decoration work while read mode is off,
    // toggling on/off needs an explicit trigger since the plugin
    // otherwise only reacts to doc changes.
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  }
}

const navPanel = new NavigationPanel(navEl);

function makeStarterDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('prosemirror-debate playground')),
    schema.nodes['paragraph']!.create(null, [
      schema.text('Drop a .docx in the input above to load it. The schema renders here as the canonical Verbatim layout (Pocket = box, Hat = centered double underline, Block = centered single underline, Tag = inline-bold).'),
    ]),
    schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Example structures')),
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('A block containing a card and an analytic')),
    schema.nodes['paragraph']!.create(null, schema.text('Loose paragraphs are first-class — they can sit between a heading and the cards beneath it. Paragraphs typed after a card auto-absorb as card_body; insert a heading to bound a region of loose text.')),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Climate action delays catastrophic — IPCC')),
      // Undertags belong to the tag — they sit inside the card, not after it.
      schema.nodes['undertag']!.create(null, schema.text('Sub-tag note that explains the tag.')),
      schema.nodes['cite_paragraph']!.create(null, [
        schema.text('IPCC AR6 ', [schema.marks['cite_mark']!.create()]),
        schema.text('2023, '),
        schema.text('Synthesis Report', [schema.marks['italic']!.create()]),
        schema.text(', '),
        schema.text('https://ipcc.ch', [schema.marks['link']!.create({ href: 'https://www.ipcc.ch' })]),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('Plain context. '),
        schema.text('Underlined evidence claim ', [schema.marks['underline_mark']!.create()]),
        schema.text('plus highlighted ', [
          schema.marks['underline_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
        schema.text('and emphasized.', [
          schema.marks['emphasis_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
      ]),
    ]),
    schema.nodes['analytic_unit']!.create(null, [
      schema.nodes['analytic']!.create(
        { id: newHeadingId() },
        schema.text('A standalone analytic between cards.'),
      ),
      schema.nodes['card_body']!.create(null, [
        schema.text('Body paragraphs after the analytic are absorbed into the unit, so the whole thing drags as one. Hover to see the gray bar — same boundary indicator as cards.'),
      ]),
    ]),
  ]);
}

function mountView(doc: PMNode): void {
  if (view) {
    editorDragSurface.detach();
    view.destroy();
  }
  const state = EditorState.create({
    doc,
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      // Tag/analytic boundary editing rules (ARCHITECTURE.md §14.3).
      // These run before baseKeymap so they get first crack at
      // Backspace / Delete / Enter when the cursor is in a tag.
      keymap({
        Backspace: (state, dispatch, view) =>
          backspaceAtTagStart(state, dispatch, view) ||
          backspaceAtFirstBodyStart(state, dispatch, view),
        Delete: (state, dispatch, view) =>
          deleteAtTagEnd(state, dispatch, view) ||
          deleteAtContainerEnd(state, dispatch, view),
        Enter: (state, dispatch, view) =>
          enterAtTagEnd(state, dispatch, view) ||
          enterMidTag(state, dispatch, view) ||
          enterInHeading(state, dispatch, view),
      }),
      // Ribbon commands — structural style hotkeys (F4–F7 / Mod-F7)
      // plus inline mark toggles (Mod-B / Mod-I) and the color-aware
      // toggles (F11 / Mod-F11). buildRibbonKeymap() accepts user
      // overrides keyed by RibbonCommandId and a context that supplies
      // the live "current color" for highlight/shading from settings.
      keymap(buildRibbonKeymap({}, ribbonContext)),
      keymap(baseKeymap),
      readModePlugin,
      absorbPlugin,
      citeClassifierPlugin,
      namedStyleNormalizerPlugin,
      fontSizeClassPlugin,
      buildPastePlugin({
        condenseOnPaste: () => settings.get('condenseOnPaste'),
        paragraphIntegrity: () => settings.get('paragraphIntegrity'),
        usePilcrows: () => settings.get('usePilcrows'),
        headingMode: () => settings.get('headingMode'),
        onArmedChange: (armed) => updatePlainPasteIndicator(armed),
      }),
    ],
  });
  view = new EditorView(editorEl, {
    state,
    editable: () => !settings.get('readMode'),
    dispatchTransaction(tx) {
      if (!view) return;
      const next = view.state.apply(tx);
      view.updateState(next);
      if (tx.docChanged) {
        currentDoc = next.doc;
      }
      // Walking the doc to rebuild the nav pane and tally read-aloud
      // word count is the dominant per-keystroke cost on big docs.
      // Debounce so we only do it after typing pauses.
      scheduleHeavyUpdate();
    },
  });
  currentDoc = doc;
  navPanel.attach(view);
  // Editor drop surface — renders drop indicators in the editor when
  // a nav-pane drag is active, and exposes a hit-test the nav drag
  // handler queries during pointermove. (Phase 3a.)
  editorDragSurface.attach(view, editorEl);
  exportBtn.disabled = false;
  // Initial paint: do the heavy update synchronously so the user sees
  // the right thing immediately on doc load.
  navPanel.update(doc);
  refreshWordCount();
}

let pendingHeavyUpdate: ReturnType<typeof setTimeout> | null = null;
const HEAVY_UPDATE_DELAY_MS = 200;

function scheduleHeavyUpdate(): void {
  if (pendingHeavyUpdate !== null) clearTimeout(pendingHeavyUpdate);
  pendingHeavyUpdate = setTimeout(() => {
    pendingHeavyUpdate = null;
    if (!view) return;
    navPanel.update(view.state.doc);
    refreshWordCount();
  }, HEAVY_UPDATE_DELAY_MS);
}

dropzone.addEventListener('change', async () => {
  const file = dropzone.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  try {
    const doc = await fromDocx(new Uint8Array(buf));
    mountView(doc);
    console.log(`Loaded ${file.name}: ${countSummary(doc)}`);
  } catch (err) {
    console.error('Failed to load docx:', err);
    alert(`Failed to load: ${err instanceof Error ? err.message : err}`);
  }
});

exportBtn.addEventListener('click', async () => {
  try {
    const bytes = await toDocx(currentDoc);
    // Copy into a regular ArrayBuffer for Blob's BlobPart contract.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'exported.docx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
    alert(`Export failed: ${err instanceof Error ? err.message : err}`);
  }
});

function countSummary(doc: PMNode): string {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
  });
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

mountView(currentDoc);
