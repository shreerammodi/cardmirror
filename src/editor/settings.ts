/**
 * Editor settings — typed user preferences with localStorage persistence
 * and pub/sub for change notifications.
 *
 * Per ARCHITECTURE.md §5 the bigger "display config" (per-node typography,
 * accessibility presets, etc.) is a separate substantial feature. This
 * module is the simpler feature-toggle / numeric-pref store. Display
 * config can layer on later as its own module without colliding.
 */

import { isWordHighlightName, isHex6 } from './color-palette.js';
import type { RibbonCommandId } from './ribbon-commands.js';
import { getHost } from './host/index.js';

/** Dynamic description for the `multiDocWorkspace` (three-pane
 *  workspace) toggle. The OFF state behaves differently on Electron
 *  vs the web edition, so we surface that difference at the point
 *  the user reads the setting. */
function workspaceLayoutDescription(): string {
  const kind = getHost().kind;
  const offBehavior =
    kind === 'electron'
      ? 'each open document gets its own native window. Opening a new file (or making a new document) spawns a new window — recommended when you have screen space and a good window manager.'
      : 'one document at a time in this browser tab. The web edition can\'t spawn its own windows, so to work with multiple documents in this mode, open additional browser tabs and load a doc in each — or turn this setting ON to use three panes inside this tab.';
  return (
    `OFF (default): ${offBehavior} ON: a single window with three side-by-side panes inside it, for working multi-doc with limited screen real estate. Comments are unavailable while ON. Toggling reloads the editor; open documents are restored in the new layout.`
  );
}

const STORAGE_KEY = 'pmd-settings';

/** Keys whose values are per-window/per-session: never written to
 *  localStorage, never synced via storage events, and reset to
 *  defaults on reload. Read mode is the canonical case — Verbatim
 *  exits read mode on document close, and we already treat it as
 *  per-pane in multi-doc mode; making it per-window matches that
 *  intent for the multi-window case. Autosave joins it for the
 *  same reason: a workflow toggle the user wants to control per
 *  doc, not a global preference. */
const TRANSIENT_SETTING_KEYS = new Set<string>([
  'readMode',
  'autosaveEnabled',
  // Nav-pane visibility — the user might want the outline open in
  // one window (a doc they're navigating heavily) and hidden in
  // another (a doc they're reading). Per-window matches that
  // intent; on the web edition there's only one tab so it's
  // effectively a session preference.
  'navPaneVisible',
]);

/** Reader profile for read-time estimates: name + words-per-minute. */
export interface ReaderConfig {
  name: string;
  wpm: number;
}

/**
 * Per-style font sizes (in points). Mirrors Verbatim's Styles tab so
 * users can adjust how each named style renders without touching the
 * underlying doc — the §5 three-layer rendering model in action. Each
 * field becomes a CSS custom property on `#editor` (e.g. `--pmd-size-
 * cite: 13pt`); CSS rules consume the variables.
 *
 * Defaults match Verbatim's defaults for parity with current docs:
 *   pocket=26, hat=22, block=16, tag=13, analytic=13, cite=13,
 *   underline=11, emphasis=11, undertag=12, normal=11.
 */
export interface DisplaySizes {
  normal: number;
  pocket: number;
  hat: number;
  block: number;
  tag: number;
  analytic: number;
  cite: number;
  underline: number;
  emphasis: number;
  undertag: number;
}

export const DISPLAY_SIZE_KEYS: (keyof DisplaySizes)[] = [
  'normal', 'pocket', 'hat', 'block', 'tag',
  'analytic', 'cite', 'underline', 'emphasis', 'undertag',
];

const DEFAULT_DISPLAY_SIZES: DisplaySizes = {
  normal: 11,
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  cite: 13,
  underline: 11,
  emphasis: 11,
  undertag: 12,
};

/**
 * Per-style typography flags. Mirrors the boolean side of Verbatim's
 * Styles tab — whether each named style is bold, italic, underlined,
 * boxed, plus the box thickness. Each flag becomes a class toggle on
 * `#editor` (e.g. `pmd-emphasis-bold`); CSS rules predicated on the
 * class enable the typography. Default values match Verbatim's
 * defaults, except `emphasisBox` (defaulting to true here to match the
 * existing always-on box rendering).
 */
export interface DisplayTypography {
  citeUnderlined: boolean;
  underlineBold: boolean;
  emphasisBold: boolean;
  emphasisItalic: boolean;
  emphasisBox: boolean;
  emphasisBoxSize: number; // pt
  undertagItalic: boolean;
  undertagBold: boolean;
}

const DEFAULT_DISPLAY_TYPOGRAPHY: DisplayTypography = {
  citeUnderlined: false,
  underlineBold: false,
  emphasisBold: true,
  emphasisItalic: false,
  emphasisBox: true,
  emphasisBoxSize: 1,
  undertagItalic: true,
  undertagBold: false,
};

/**
 * Per-style display colors (hex strings, e.g. `"#1F3864"`). Per
 * ARCHITECTURE.md §18 every user-visible color should be reachable
 * through display config — analytic and undertag are the first two
 * surfaced as direct controls. Each becomes a CSS custom property on
 * `:root` (e.g. `--pmd-color-analytic`). Both the editor and the nav
 * pane consume those variables.
 */
export interface DisplayColors {
  analytic: string;
  undertag: string;
}

const DEFAULT_DISPLAY_COLORS: DisplayColors = {
  analytic: '#1F3864',
  undertag: '#385623',
};

export const DISPLAY_COLOR_KEYS: (keyof DisplayColors)[] = ['analytic', 'undertag'];

/** Schema for all editor settings. Add new fields here with sensible defaults. */
export interface Settings {
  /** Width of the navigation pane in pixels. */
  navWidth: number;
  /** Default depth shown in the navigation pane (1–4). */
  navMaxLevel: number;
  /** When true (default), `New document` mounts the CardMirror
   *  welcome / onboarding doc. When false, it mounts a blank
   *  doc — a single empty paragraph. The starter is the same one
   *  every fresh window opens with, so this also governs the
   *  initial content of newly spawned windows. */
  showOnboardingStarter: boolean;
  /** Desktop-only. When set, "New Speech Document" saves into this
   *  directory by default (instead of leaving the doc unsaved until
   *  the user picks a location). Empty string means "no default —
   *  keep the current behavior of waiting for an explicit Save."
   *  Stored as an absolute path. */
  defaultSpeechDocFolder: string;
  /** Format that "New Speech Document" creates the doc in. `docx`
   *  is the Verbatim-compatible default. `cmir` is CardMirror's
   *  native format — the only format that supports autosave (the
   *  background save path skips .docx because `toDocx` is too
   *  expensive to run on a debounce). */
  defaultSpeechDocFormat: 'cmir' | 'docx';
  /** Format the Save-As dialog defaults to for a doc that doesn't
   *  yet have an on-disk handle (new doc, first save). Existing
   *  on-disk files always Save As in their current format — the
   *  handle wins over this default. */
  defaultSaveFormat: 'cmir' | 'docx';
  /** When on, the highlight marks in the doc render in the colors
   *  defined by `overrideHighlightSlots` rather than their stored
   *  colors. Display-only — does NOT mutate the doc, so saving
   *  back to `.cmir` / `.docx` preserves the original per-mark
   *  colors. Useful when cards from many sources have
   *  inconsistent highlight conventions and the user wants a
   *  visually-unified read. */
  overrideHighlightColor: boolean;
  /** 1–3 hex/rgba colors used to remap highlights at display
   *  time. If length 1: every highlight renders as that color.
   *  If length > 1: the most-common source highlight color gets
   *  slot 0, the second-most-common gets slot 1, and everything
   *  else gets the LAST slot (so "third" slot doubles as the
   *  catch-all when length is 3). Frequency ranking is computed
   *  per-doc by the highlight-frequency plugin. */
  overrideHighlightSlots: string[];
  /** Same idea, applied to `shading` marks (the protected
   *  highlight variant Verbatim uses for "remove highlighting"-
   *  resistant emphasis). Default-on color matches the
   *  protected-grey convention. */
  overrideShadingColor: boolean;
  /** 1–3 hex/rgba colors mirroring `overrideHighlightSlots` for
   *  shading marks. */
  overrideShadingSlots: string[];
  /** Theme. `'light'` and `'dark'` force the corresponding
   *  palette. `'system'` (default) follows the OS-level
   *  `prefers-color-scheme` and tracks live changes. Setting
   *  resolves to the `data-theme` attribute on the document
   *  root; CSS rules at `:root[data-theme="dark"]` (in style.css)
   *  swap the `--pmd-c-*` token values. */
  theme: 'light' | 'dark' | 'system';
  /** Whether the active theme applies to the editor document
   *  area too. Default OFF: the chrome (ribbon, nav, status bar)
   *  follows the theme, but the document itself keeps a light /
   *  paper-like surface — the configuration most people want
   *  when running dark mode. Turn on to make the document area
   *  follow the chrome theme as well. */
  themeAppliesToDocument: boolean;
  /** Show a pill in the center of the ribbon displaying the
   *  active doc's filename. Off by default — the OS title bar
   *  carries this info on most platforms. Useful when the
   *  title bar is hidden, unstyled, or non-existent (tiling
   *  window managers without decorations, frameless windows,
   *  embedded web edition). Single-doc only; multi-pane shows
   *  per-pane chips regardless of this setting. */
  showDocNameChip: boolean;
  /** Whether to check for updates on app launch (desktop only).
   *  Off by default in this initial release to keep boot
   *  conservative — opt in via Settings → General → "About this
   *  install." When enabled, the first window of an app session
   *  triggers a silent update check at boot; if a new version is
   *  available, a modal pops with a link to the release page.
   *  Subsequent windows in the same session skip the check.
   *  Manual checks via Help → Check for Updates… or the button
   *  in the About this install panel always work regardless. No
   *  effect on the web edition (no update mechanism). */
  checkForUpdatesOnLaunch: boolean;
  /** Width of the comments column in CSS pixels. User-resizable via
   *  the drag handle on the column's left edge. Clamped to
   *  `COMMENTS_WIDTH_MIN` … `COMMENTS_WIDTH_MAX` (240–560) — below
   *  240 threads get cramped, above 560 the column eats too much
   *  editor space. Default 320 matches the column's original fixed
   *  width before the handle existed. */
  commentsColumnWidth: number;
  /** UI motion preference. `'auto'` (default) follows the OS
   *  `prefers-reduced-motion` media query and gives the user the
   *  motion-reduction state their system advertises. `'on'` always
   *  reduces motion (animations and transitions become instant);
   *  `'off'` always plays full motion even if the OS asked for
   *  reduced. Resolved into a `data-motion` attribute on the
   *  document root; CSS rules in `style.css` consume it. */
  reduceMotion: 'auto' | 'on' | 'off';
  /** Per-token UI color overrides. Keyed by CSS-variable name
   *  WITHOUT the `--` prefix (e.g. `"pmd-c-accent"`); values are
   *  CSS color strings the user picked in the accessibility
   *  panel. Applied as inline styles on documentElement so they
   *  win over the :root defaults AND over any future preset
   *  (high-contrast, colorblind, dark) that sets the variable
   *  via a body class. Empty by default. */
  customColorOverrides: Record<string, string>;
  /** Whether the navigation pane (outline) is visible in THIS
   *  window. Default on. Toggled via the ribbon's nav-pane
   *  button or the left-edge pull-tab that appears when the pane
   *  is hidden. Transient: not persisted to disk, not propagated
   *  to other windows — each window starts with the pane visible
   *  and the user can hide it independently. */
  navPaneVisible: boolean;
  /** Whether the nav pane styles entries by heading level / type
   *  (default on). When on: top-level headings render bold, lower
   *  levels in lighter weight / size, analytic entries in the
   *  analytic-blue accent. When off: every entry renders in the
   *  same weight, size, and color — only indentation conveys
   *  hierarchy. Display-only; doesn't touch the underlying doc.
   *  Symmetric in single-doc and multi-pane layouts. */
  formatNavPaneByType: boolean;
  /** Built-in countdown timer settings. (Panel visibility lives
   *  in `timer-state.ts`, not here — shared via BroadcastChannel
   *  so toggling the timer on in one window opens it in every
   *  other open window too. Settings here are configuration, not
   *  per-window UI state.) */
  /** Currently-active timer profile. All three profiles are
   *  user-customizable (see `timerProfiles`); there's no
   *  separate "custom" — edits go straight to the active
   *  profile's saved slot. */
  timerProfile: 'highSchool' | 'college' | 'pomodoro';
  /** Per-profile saved durations. Picking a profile loads its
   *  speech-preset triple + prep total into the live settings
   *  (`timerSpeechPresets` / `timerPrepMinutes`); editing a
   *  value updates BOTH the live setting AND the active
   *  profile's saved slot here. Defaults match each profile's
   *  conventional values: High school 3/5/8 + 8 prep, College
   *  3/6/9 + 10 prep, Pomodoro 25/15/5 + 0 prep. */
  timerProfiles: Record<'highSchool' | 'college' | 'pomodoro', {
    speechPresets: number[];
    prepMinutes: number;
  }>;
  /** The active profile's speech-preset triple, lifted to the
   *  top level so the timer state + UI read it from one
   *  predictable spot instead of indexing into
   *  `timerProfiles[timerProfile]`. */
  timerSpeechPresets: number[];
  /** Per-side prep total in minutes. Reset refills both prep
   *  clocks to this value. */
  timerPrepMinutes: number;
  /** When the speech timer's remaining time crosses one of the
   *  configured `timerFlashSeconds`, the display flashes red.
   *  Off → no flashing regardless of remaining. */
  timerFlashEnabled: boolean;
  /** Remaining-time thresholds (in seconds) at which the display
   *  flashes red when `timerFlashEnabled` is on. Default 5/3/1. */
  timerFlashSeconds: number[];
  /** Compact layout: drops the 9/6/3 preset column and stacks
   *  Reset under Start/Pause. */
  timerCompact: boolean;
  /** How to label the Aff / Neg prep buttons:
   *    'text'  → "A: 10:00" / "N: 10:00", no special color
   *    'color' → "10:00" / "10:00", blue + red border
   *    'both'  → "A: 10:00" / "N: 10:00", blue + red (default)
   *  Color-blind users can pick 'text'; minimalist users can pick
   *  'color' to drop the redundant A:/N: prefix. */
  timerPrepLabel: 'text' | 'color' | 'both';
  /** When read mode is toggled (either direction), scroll the
   *  editor to the very top of the doc and place the cursor at
   *  the start. Default off — toggling read mode keeps the
   *  viewport / cursor where they were. */
  jumpToDocTopOnReadModeToggle: boolean;
  /** Whether the find bar's "results list" expansion panel (the
   *  scrollable box of matches-in-context below the bar) starts
   *  open on the next find session. Mirrors the user's last
   *  toggle of the chevron button — defaults false so the bar
   *  opens compact unless the user expanded it last. */
  findResultsExpanded: boolean;
  /** Whether the find bar pre-fills its input with the user's
   *  last search query when reopened. When off, the bar opens
   *  empty (or with the current selection, if any, as the seed).
   *  When on (default), a non-empty selection still wins over the
   *  remembered query — matches Word's behavior. */
  findRememberLastQuery: boolean;
  /** The user's last find-bar query — empty string when none has
   *  been entered yet. Persisted only when `findRememberLastQuery`
   *  is on; capped to a sane length so the settings blob doesn't
   *  grow unbounded if a user pastes massive strings. */
  findLastQuery: string;
  /** Priority order for the categorized find sort (Ctrl-F). Each
   *  match falls into one of four categories — `heading` (pocket /
   *  hat / block), `tag`, `cite`, `other` — and the find bar's
   *  Next steps through matches in this order, with cursor-as-top
   *  proximity within each category. Must be a permutation of the
   *  four category names. Alt-F ignores this setting (proximity
   *  only). */
  findCategoryOrder: ('heading' | 'tag' | 'cite' | 'other')[];
  /** Whether "New Speech Document" seeds the doc with a Pocket
   *  heading carrying the speech's name. On (default) matches
   *  Verbatim's `NewSpeech`. Off creates a fully blank doc — one
   *  empty paragraph — for users who'd rather title their speeches
   *  inline. */
  includeSpeechDocPocket: boolean;
  /** Whether to show the cite preview on hover in the nav pane. */
  showCitePreview: boolean;
  /** Browser-level spellcheck on the editor surface. Off by default
   *  because on large debate docs the dictionary tokenization +
   *  underline overlay is a visible per-keystroke cost; debate
   *  evidence (technical jargon, author names) also produces mostly
   *  false-positive squiggles. Users who prefer the safety net can
   *  flip it on. */
  editorSpellcheck: boolean;
  /** Whether autosave is on. When true, doc-changing edits schedule
   *  a background write-back to the file's existing on-disk
   *  location, debounced by ~5s of idle. Only fires for `.cmir`
   *  documents (native format serialization is cheap); `.docx`
   *  files are skipped because `toDocx` is expensive enough that
   *  per-keystroke autosaves would visibly stutter the editor. */
  autosaveEnabled: boolean;
  /** Whether the user can click-and-drag selected text to move it to
   *  another position. On by default (matches PM / browser default).
   *  Turning this off suppresses the browser's `dragstart` on the
   *  editor surface — text selection still works, but the user can't
   *  initiate a text-move drag. Doesn't affect the card / heading
   *  pickup-modifier drag (which is its own pointerdown-driven
   *  system) or paste / typing. */
  enableTextDragDrop: boolean;
  /** Whether read mode is currently active (dims non-read-aloud content,
   *  blocks editing). Persisted across sessions because some users may
   *  want it to be the default state. */
  readMode: boolean;
  /** When true, strip ALL emphasis-mark borders in read mode (not just
   *  the ones around hidden text). Some users prefer the cleanest look
   *  in read mode regardless of what's emphasized. */
  hideEmphasisBordersInReadMode: boolean;
  /** Editor zoom level as a percentage (50–200, step 10). */
  zoomPct: number;
  /** Chrome (page) zoom for the whole window, as a percentage
   *  (50–200, step 10). Wired to Chromium's `webFrame.setZoom-
   *  Factor` on Electron, which reflows the page exactly the
   *  way the browser's built-in Ctrl-+ chord does — chrome AND
   *  doc content both scale uniformly. Stacks multiplicatively
   *  with `zoomPct`: if the doc looks too big at a higher
   *  chromeScalePct, dial `zoomPct` down to compensate. No-op
   *  on the web edition (use the browser's own page-zoom). */
  chromeScalePct: number;
  /**
   * Readers used for read-time estimates. The full list shows up in the
   * Word Count Selection function (Ctrl+F11). The first two readers are
   * also displayed in the bottom status bar live.
   */
  readers: ReaderConfig[];
  /**
   * Per-style font sizes (in points). See DisplaySizes for details.
   * Each field becomes a CSS custom property on `#editor`.
   */
  displaySizes: DisplaySizes;
  /**
   * Per-style typography flags (bold/italic/underlined/box). See
   * DisplayTypography. Each becomes a class toggle on `#editor`.
   */
  displayTypography: DisplayTypography;
  /**
   * Per-style display colors. See DisplayColors. Each becomes a CSS
   * custom property on `:root`.
   */
  displayColors: DisplayColors;
  /**
   * Body font family. Mirrors Verbatim's NormalFont. Applied as a CSS
   * custom property on `#editor`; rendered with sans-serif fallback.
   */
  bodyFont: string;
  /**
   * What to show in ribbon tooltips. Four modes:
   *   - `none`      — no tooltips on any ribbon button.
   *   - `tooltip`   — label only (e.g., "Apply Tag Style"). Dropdown
   *                   menu items get NO tooltip (the menu item label
   *                   already states what it does).
   *   - `shortcut`  — only the current keyboard shortcut (e.g., "F7").
   *                   Buttons / items without a shortcut get no tooltip.
   *   - `both`      — label + shortcut (e.g., "Apply Tag Style (F7)").
   *                   Dropdown items still show shortcut-only because
   *                   their label is already in the menu.
   */
  ribbonTooltipMode: 'none' | 'tooltip' | 'shortcut' | 'both';
  /** Whether the cross-window dropzone pill (the floating shelf at
   *  the bottom of the nav pane) is visible. The shelf state still
   *  works when off (Ctrl+\` sends, content is reachable from the
   *  next window opened); the pill is just hidden from the chrome. */
  showDropzonePill: boolean;
  /**
   * User-interface font family. Applied as `--pmd-ui-font` on
   * documentElement; flows into every UI surface (ribbon, dialogs,
   * nav pane, comments column, etc.). Empty string keeps the
   * stylesheet's system-UI default — distinct from `bodyFont`,
   * which is the editor-content font.
   */
  uiFont: string;
  /**
   * Per-paragraph-type line-height multipliers. Each maps to a CSS
   * variable on `#editor` (--pmd-line-height, --pmd-line-height-cite,
   * etc.). `lineHeight` is the body knob — it also scales shrunken-
   * paragraph line-heights via the font-size-class plugin's ramp.
   * Each is unitless; range 1.0–2.0.
   */
  lineHeight: number;
  lineHeightCite: number;
  lineHeightTag: number;
  lineHeightAnalytic: number;
  lineHeightHeading: number;
  lineHeightUndertag: number;
  /**
   * Display mode for the ribbon's formatting panel (Pocket / Hat /
   * Block / Tag / Analytic buttons). 'labels' shows the style name on
   * each button, 'shortcuts' shows the keyboard binding, 'hidden'
   * removes the panel entirely.
   */
  formattingPanelMode: FormattingPanelMode;
  /**
   * When true, the formatting-panel buttons preview the visual
   * treatment of the style they apply (Pocket boxed, Hat double-
   * underlined, Tag bold, etc.). When false, buttons are rendered as
   * plain text. Has no effect when formattingPanelMode is 'hidden'.
   */
  formattingPanelPreview: boolean;
  /**
   * When true (default), the cite/underline/emphasis "character
   * styles" sub-panel is shown in the ribbon. When false, just that
   * sub-panel is hidden (the rest of the formatting panel, color
   * controls, etc. stay visible). Independent of formattingPanelMode:
   * setting the mode to "Hidden" hides everything regardless.
   */
  showCharacterStyles: boolean;
  /**
   * Last highlight color picked from the ribbon dropdown. One of the
   * 15 Word named highlight colors (`yellow`, `green`, `darkRed`, …).
   * Used as the active color when F11 toggles highlight on; persisted
   * so the editor remembers each user's preferred color.
   */
  lastHighlightColor: string;
  /**
   * Last shading color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`). Default is Verbatim's D2D2D2 protected-highlight
   * grey. Used as the active color when Ctrl-F11 toggles shading on.
   */
  lastShadingColor: string;
  /**
   * Last font color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`), or null for "Automatic" (no font_color mark).
   * When null, the Automatic option in the dropdown is the active
   * selection; applying font color removes the mark entirely instead
   * of writing a black explicitly.
   */
  lastFontColor: string | null;
  /**
   * Condense settings — drive the behavior of the default condense
   * hotkey (F3) and modify selection-based condense semantics. See
   * ARCHITECTURE.md §15 condense for the full rule table.
   *
   * `paragraphIntegrity`:
   *   - true  → F3 keeps paragraphs separate (Branch C); only intra-
   *             paragraph whitespace is cleaned.
   *   - false → F3 merges collapsible paragraph runs (Branch A or B
   *             depending on `usePilcrows`).
   *   Toggled from the ribbon (paragraph-integrity button) and the
   *   settings panel.
   *
   * `usePilcrows`:
   *   - false → merging joins paragraphs with spaces (Branch A).
   *   - true  → merging inserts a 6-pt ¶ at each original boundary
   *             (Branch B), so paragraph splits are recoverable via
   *             Uncondense. Only consulted when `paragraphIntegrity`
   *             is false (no boundaries to mark otherwise).
   *
   * `headingMode`:
   *   - 'strict'   → selection-based condense **no-ops** if the
   *                  selection touches any structural element
   *                  (heading / cite_paragraph / undertag). Safest
   *                  mode — won't accidentally cross a structural
   *                  boundary. Body-only selections behave like
   *                  'respect'.
   *   - 'respect'  → selection keeps headings + cite_paragraphs +
   *                  undertags as their own paragraphs; only
   *                  consecutive runs of card_body / doc-level
   *                  paragraph merge.
   *   - 'demolish' → selection demolishes everything in its range;
   *                  the collapsed textblock's type = type of the
   *                  first touched paragraph; cards / analytic_units
   *                  whose head was touched dissolve and orphan body
   *                  slots absorb into the receiving container.
   */
  paragraphIntegrity: boolean;
  usePilcrows: boolean;
  headingMode: HeadingMode;
  /**
   * When true, F2 (Paste Text) runs the default condense pass on the
   * card after pasting. Mirrors Verbatim's `CondenseOnPaste` flag —
   * off by default; useful for users who almost always paste a long
   * blob of text that needs to be tightened up. The condense it runs
   * is the same one F3 invokes (respects `paragraphIntegrity` /
   * `usePilcrows` / `headingMode`).
   */
  condenseOnPaste: boolean;
  /**
   * When true, removing a named-style mark (F8 Emphasis / F9 Underline /
   * F10 Cite) via the apply key ALSO strips direct formatting (font
   * size / color / family, bold, italic, strikethrough, highlight,
   * shading, direct underline) from the same range. Mirrors Verbatim's
   * "press F9 twice to clear formatting" workflow. When off, toggling
   * the named-style off leaves any direct formatting the user manually
   * added intact.
   *
   * Always applies on the apply direction (adding the named-style mark
   * strips direct formatting unconditionally — the user can manually
   * re-apply direct formatting after).
   */
  clearFormattingOnNamedStyleToggleOff: boolean;
  /** When true, "Create Reference" (Card menu) emits its body text
   *  in Gray-50% (#808080) instead of black. Heading line stays
   *  black either way. */
  forReferenceUseGray50: boolean;
  /** When true, Shrink (Mod-8) treats bracketed "Omitted" spans AND
   *  the `[PARAGRAPH INTEGRITY PAUSES/RESUMES]` markers emitted by
   *  "Condense with warning" specially: their existing size is
   *  excluded from the cycle decision, and after the size pass they're
   *  restored to Normal so they remain visible in the shrunken output.
   *  When off, both are shrunk along with the surrounding text. */
  shrinkRestoresOmissionsToNormal: boolean;
  /**
   * Delimiter family for "Condense with warning". One of the six
   * bracket pairs (which produce `<open>PARAGRAPH INTEGRITY
   * PAUSES<close>` / `…RESUMES<close>`) or `'custom'` (which uses
   * the user-typed marker strings below in place of the entire
   * marker text). Default `[` matches the most common convention in
   * user docs.
   */
  condenseWarningDelimiter: CondenseWarningDelimiter;
  /** When `condenseWarningDelimiter` is `'custom'`, this string is
   *  inserted verbatim as the pause-marker paragraph (replacing the
   *  entire `[PARAGRAPH INTEGRITY PAUSES]` text). Empty string
   *  disables the command (it no-ops with a console warn). */
  condenseWarningCustomPauseMarker: string;
  /** Companion to `condenseWarningCustomPauseMarker` — inserted as
   *  the resume-marker paragraph. */
  condenseWarningCustomResumeMarker: string;
  /**
   * User-supplied strings (or regexes) that Shrink should treat as
   * protected — same pipeline as the built-in bracketed-Omitted
   * patterns and the PARAGRAPH INTEGRITY PAUSES/RESUMES markers. The
   * whole list is gated by `shrinkRestoresOmissionsToNormal`. Each
   * entry: a string and an `isRegex` flag. When false, the string is
   * regex-escaped and matched case-insensitively. When true, it's
   * compiled as a regex source verbatim (still with `gi` flags).
   * Invalid regex sources are silently dropped at compile time.
   */
  shrinkCustomProtections: ShrinkProtection[];
  /**
   * User-supplied overrides for ribbon-command key bindings. Each
   * entry maps a `RibbonCommandId` to its custom key spec — either a
   * single key string (e.g. `'F8'`, `'Mod-Shift-7'`) or an array for
   * multi-binding commands (e.g. `['F9', 'Mod-u']`). An empty string
   * or empty array means "explicitly unbound" (the command exists in
   * the menu / ribbon but has no key). Commands not present in this
   * map fall back to `DEFAULT_RIBBON_KEYS`.
   */
  ribbonKeyOverrides: Partial<Record<RibbonCommandId, string | string[]>>;
  /** Display name attached to new comments authored locally. */
  commentAuthor: string;
  /** Initials attached to new comments authored locally (Word shows
   *  these in the margin badge). Auto-derived from `commentAuthor`
   *  if left empty. */
  commentAuthorInitials: string;
  /** Whether the right-side comments column is currently visible.
   *  Toggled by the comments-show-hide ribbon button; persisted so
   *  the editor remembers the last state. */
  commentsVisible: boolean;
  /** Anthropic API key for AI features. Empty until the user sets
   *  one. Stored locally; never sent anywhere except direct calls
   *  to the Anthropic API. */
  anthropicApiKey: string;
  /** Master switch for AI features (the explainer comment shortcut,
   *  @AI mentions inside comments, etc.). When false, no UI for
   *  AI shows up and no API calls happen even if a key is set. */
  aiFeaturesEnabled: boolean;
  /** Friendlier "Clod" persona for the AI in-flight indicator —
   *  while the model is composing a reply, the placeholder cycles
   *  through time-of-day Clod activities ("Clod is making toast…").
   *  Off by default; the easter-egg configurator (shift+right-click
   *  on the toggle in Settings) opens a dialog to customize the
   *  activity pools per time period. */
  clodEnabled: boolean;
  /** Per-time-period activity override pools. Empty arrays fall
   *  back to the built-in lists in `src/editor/ai/clod.ts`. */
  clodActivitiesByTime: {
    morning: string[];
    day: string[];
    evening: string[];
    night: string[];
  };
  /** Hour boundaries (0-23) for each Clod time period. Periods may
   *  cross midnight (start > end), which is normal for "night". */
  clodTimePeriods: {
    morning: { start: number; end: number };
    day: { start: number; end: number };
    evening: { start: number; end: number };
    night: { start: number; end: number };
  };
  /** Display name for the AI persona — drives the comment author
   *  name (when Clod mode is on), the in-flight activity text
   *  (substituted into the built-in "Clod is …" templates), and the
   *  AI button tooltip. Default: "Clod". */
  aiPersonaName: string;
  /** Pronoun set used to template the built-in Clod activities.
   *  `'custom'` reads from `aiPersonaCustomPronouns`. */
  aiPersonaPronouns: 'he' | 'she' | 'they' | 'it' | 'custom';
  /** Used only when `aiPersonaPronouns === 'custom'`. */
  aiPersonaCustomPronouns: {
    subject: string;
    object: string;
    possessive: string;
    reflexive: string;
  };
  /** System prompt for the AI cite creator. Editable via the
   *  Settings dialog's "Edit prompt" modal — long enough that a
   *  full textarea makes more sense than an inline input. Empty
   *  string falls back to `DEFAULT_AI_CITE_PROMPT`. */
  aiCitePrompt: string;
  /** Master switch for the multi-doc workspace shell — three slots,
   *  each holding a stack of 0+ docs. Toggling this requires a
   *  page reload to (re)build the editor shell. Comments are
   *  unavailable while this is on. See SPEC-multi-pane.md. */
  multiDocWorkspace: boolean;
  /** When `multiDocWorkspace` is on and three slots are populated:
   *  `compact` shows all three panes side by side; `wide` widens
   *  each pane and lets the user paged-scroll between them
   *  (2 full + edge of 3rd visible). With 1 or 2 active slots the
   *  two modes render identically. */
  multiDocLayoutMode: 'compact' | 'wide';
}

/** Open-delimiter options for "Condense with warning" markers. The
 *  six built-ins use mirror-pair closers via `condenseWarningCloseFor`;
 *  `'custom'` reads the close string from `condenseWarningCustomClose`. */
export type CondenseWarningDelimiter =
  | '[' | '[[' | '<' | '<<' | '{' | '{{' | 'custom';
const CONDENSE_WARNING_DELIMITERS: CondenseWarningDelimiter[] = [
  '[', '[[', '<', '<<', '{', '{{', 'custom',
];

/** Return the mirror close for a built-in open. Throws on 'custom'
 *  (callers should branch on the enum first and read the user-typed
 *  close string from settings instead). */
export function condenseWarningCloseFor(d: CondenseWarningDelimiter): string {
  switch (d) {
    case '[': return ']';
    case '[[': return ']]';
    case '<': return '>';
    case '<<': return '>>';
    case '{': return '}';
    case '{{': return '}}';
    case 'custom':
      throw new Error("condenseWarningCloseFor: 'custom' has no mirror — read from settings");
  }
}

/** User-supplied shrink protection rule. `pattern` is treated as a
 *  literal string by default (escaped, matched case-insensitively
 *  with `i` flag, like the built-in omission patterns) or as a raw
 *  regex source when `isRegex` is true. Invalid regex sources are
 *  silently dropped at compile time. */
export interface ShrinkProtection {
  pattern: string;
  isRegex: boolean;
}

export type HeadingMode = 'strict' | 'respect' | 'demolish';
const HEADING_MODES: HeadingMode[] = ['strict', 'respect', 'demolish'];

export type FormattingPanelMode = 'labels' | 'shortcuts' | 'both' | 'hidden';
const FORMATTING_PANEL_MODES: FormattingPanelMode[] = ['labels', 'shortcuts', 'both', 'hidden'];

const DEFAULTS: Settings = {
  navWidth: 300,
  navMaxLevel: 3,
  showOnboardingStarter: true,
  defaultSpeechDocFolder: '',
  defaultSpeechDocFormat: 'docx',
  defaultSaveFormat: 'docx',
  theme: 'system',
  themeAppliesToDocument: false,
  showDocNameChip: false,
  checkForUpdatesOnLaunch: false,
  commentsColumnWidth: 320,
  reduceMotion: 'auto',
  overrideHighlightColor: false,
  overrideHighlightSlots: ['#ffff00'],
  overrideShadingColor: false,
  overrideShadingSlots: ['#d2d2d2'],
  customColorOverrides: {},
  navPaneVisible: true,
  formatNavPaneByType: true,
  timerProfile: 'college',
  timerProfiles: {
    highSchool: { speechPresets: [3, 5, 8], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5], prepMinutes: 0 },
  },
  timerSpeechPresets: [3, 6, 9],
  timerPrepMinutes: 10,
  timerFlashEnabled: true,
  timerFlashSeconds: [5, 3, 1],
  timerCompact: false,
  timerPrepLabel: 'both',
  jumpToDocTopOnReadModeToggle: false,
  findResultsExpanded: false,
  findRememberLastQuery: false,
  findLastQuery: '',
  findCategoryOrder: ['heading', 'tag', 'cite', 'other'],
  includeSpeechDocPocket: true,
  showCitePreview: true,
  editorSpellcheck: false,
  // Default OFF — autosave is meaningful only when the user has
  // saved at least once (so we have a handle) AND the doc is in
  // .cmir format. We let the user opt in via the ribbon toggle
  // rather than silently saving in the background.
  autosaveEnabled: false,
  // Default OFF — the user reported that PM's native click-and-drag
  // of arbitrary selected text sometimes produces a doc edit that
  // can't be cleanly undone, and they'd rather lose the feature
  // than wrestle with the inconsistency. Flip on in Settings if
  // you want the drag behavior back.
  enableTextDragDrop: false,
  readMode: false,
  hideEmphasisBordersInReadMode: false,
  zoomPct: 100,
  chromeScalePct: 100,
  readers: [
    { name: 'Reader 1', wpm: 200 },
    { name: 'Reader 2', wpm: 250 },
  ],
  displaySizes: { ...DEFAULT_DISPLAY_SIZES },
  displayTypography: { ...DEFAULT_DISPLAY_TYPOGRAPHY },
  displayColors: { ...DEFAULT_DISPLAY_COLORS },
  bodyFont: 'Times New Roman',
  uiFont: '',
  ribbonTooltipMode: 'both',
  showDropzonePill: true,
  lineHeight: 1.3,
  lineHeightCite: 1.2,
  lineHeightTag: 1.2,
  lineHeightAnalytic: 1.2,
  lineHeightHeading: 1.2,
  lineHeightUndertag: 1.2,
  formattingPanelMode: 'labels',
  formattingPanelPreview: true,
  showCharacterStyles: true,
  lastHighlightColor: 'yellow',
  lastShadingColor: 'C0C0C0',
  lastFontColor: null,
  paragraphIntegrity: true,
  usePilcrows: true,
  headingMode: 'respect',
  condenseOnPaste: false,
  clearFormattingOnNamedStyleToggleOff: true,
  forReferenceUseGray50: false,
  shrinkRestoresOmissionsToNormal: false,
  condenseWarningDelimiter: '[',
  condenseWarningCustomPauseMarker: '',
  condenseWarningCustomResumeMarker: '',
  shrinkCustomProtections: [],
  ribbonKeyOverrides: {},
  commentAuthor: 'You',
  commentAuthorInitials: '',
  commentsVisible: false,
  anthropicApiKey: '',
  aiFeaturesEnabled: false,
  clodEnabled: false,
  clodActivitiesByTime: { morning: [], day: [], evening: [], night: [] },
  clodTimePeriods: {
    morning: { start: 5, end: 9 },
    day: { start: 9, end: 20 },
    evening: { start: 20, end: 23 },
    night: { start: 23, end: 5 },
  },
  aiPersonaName: 'Clod',
  aiPersonaPronouns: 'he',
  aiPersonaCustomPronouns: {
    subject: 'they',
    object: 'them',
    possessive: 'their',
    reflexive: 'themself',
  },
  aiCitePrompt: '',
  multiDocWorkspace: false,
  multiDocLayoutMode: 'compact',
};

/** Public read-only view of the built-in defaults — handy for any UI
 *  that wants a "Restore defaults" button. */
export const SETTINGS_DEFAULTS: Readonly<Settings> = DEFAULTS;

/**
 * Tabs in the settings dialog. Each setting carries a `category`
 * and is rendered under the matching tab. Order here is the tab
 * order in the dialog.
 */
export type SettingsCategory =
  | 'general'
  | 'appearance'
  | 'accessibility'
  | 'editing'
  | 'shortcuts'
  | 'comments-ai';

/**
 * Human-readable metadata for each setting, used by the settings UI.
 * Add new entries when introducing new settings.
 */
export interface SettingMeta {
  key: keyof Settings;
  label: string;
  description?: string;
  /** Optional dynamic description that takes precedence over
   *  `description` at render time. Used by entries whose copy needs
   *  to vary by host capability (e.g. the workspace-layout entry,
   *  which describes window-spawning differently on Electron vs
   *  web). */
  descriptionFn?: () => string;
  /** Settings UI hint: how should this be rendered? */
  kind:
    | 'toggle'
    | 'number'
    | 'level'
    | 'readers'
    | 'displaySizes'
    | 'displayTypography'
    | 'displayColors'
    | 'bodyFont'
    | 'uiFont'
    | 'ribbonTooltipMode'
    | 'lineHeights'
    | 'formattingPanelMode'
    | 'headingMode'
    | 'condenseWarningDelimiter'
    | 'shrinkCustomProtections'
    | 'keybindings'
    | 'text'
    | 'folder'
    | 'speechDocFormat'
    | 'saveFormat'
    | 'findCategoryOrder'
    | 'color'
    | 'colorSlots'
    | 'colorOverrides'
    | 'theme'
    | 'reduceMotion'
    | 'timerProfile'
    | 'timerProfileDurations'
    | 'timerPrepLabel'
    | 'password'
    | 'clod'
    | 'aiCitePrompt'
    | 'multiDocLayoutMode';
  /** Which tab this setting lives under in the settings dialog. */
  category: SettingsCategory;
  /** When set, this row is greyed out and its controls disabled
   *  unless the named boolean setting evaluates to true. Used for
   *  e.g. greying out the multi-doc layout picker when multi-doc is
   *  off, or AI-key rows when AI features are disabled. */
  dependsOn?: keyof Settings;
  /** When true, this setting is only relevant on Electron-style
   *  hosts (real file paths, native dialogs). The settings UI
   *  hides the row entirely on the web edition. */
  electronOnly?: boolean;
}

export const SETTING_METADATA: SettingMeta[] = [
  // ─── General ────────────────────────────────────────────────────
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate. The first two are displayed live in the bottom bar; all show up in the Word Count Selection dialog.',
    kind: 'readers',
    category: 'general',
  },
  {
    key: 'multiDocWorkspace',
    label: 'Three-pane workspace',
    descriptionFn: workspaceLayoutDescription,
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'multiDocLayoutMode',
    label: 'Multi-doc layout',
    description:
      'When three docs are open, choose compact (all three visible at once, narrow) or wide-scroll (two full panes + edge of third; click the peek to snap). With 1 or 2 docs open, both modes render identically.',
    kind: 'multiDocLayoutMode',
    category: 'general',
    dependsOn: 'multiDocWorkspace',
  },
  {
    key: 'showOnboardingStarter',
    label: 'Onboarding doc for new documents',
    description:
      'When on (default), New Document opens the CardMirror welcome doc — the same starter you get the first time you launch. When off, New opens a blank doc with a single empty paragraph. Affects every freshly created doc, including newly spawned windows.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'defaultSpeechDocFolder',
    label: 'Default folder for new speech documents',
    description:
      'When set, "New Speech Document" saves the new doc into this folder by default. Leave empty (the default) to keep the current behavior of leaving the doc unsaved until you explicitly Save / Save As.',
    kind: 'folder',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'defaultSpeechDocFormat',
    label: 'Default format for new speech documents',
    description:
      'Docx is the Verbatim-compatible default — best when you\'re sharing speech docs with teammates who use Verbatim. Picking .cmir enables autosave on the new doc (autosave only fires for .cmir files; the Docx serializer is too expensive to run on a debounce).',
    kind: 'speechDocFormat',
    category: 'general',
  },
  {
    key: 'defaultSaveFormat',
    label: 'Default file format for new documents',
    description:
      'Sets the format the Save-As dialog defaults to for a doc you haven\'t saved before. .docx is the default — Word- and Verbatim-compatible. Pick .cmir to make every new doc save in CardMirror\'s native format (lossless, and the only format that supports autosave). Doesn\'t affect existing files on disk — those always re-save in whatever format they were opened from.',
    kind: 'saveFormat',
    category: 'general',
  },
  {
    key: 'includeSpeechDocPocket',
    label: 'Seed new speech docs with a Pocket heading',
    description:
      'When on (default), New Speech Document opens with a Pocket carrying the speech\'s name (e.g. "Speech 1NC 5-15 9-30AM") at the top. Turn off to start with a fully blank doc — one empty paragraph.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'editorSpellcheck',
    label: 'Editor spellcheck',
    description:
      "Show browser spell-check red underlines under typed text. Off by default — on large docs the dictionary lookups + underline overlay add visible per-keystroke cost, and debate evidence (technical jargon, author names, citations) generates a lot of false-positive squiggles.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'enableTextDragDrop',
    label: 'Text drag-and-drop',
    description:
      "Allow click-and-drag of selected text to move it to another position. On by default. Disabling stops you (and the browser) from initiating a text-move drag — useful if you keep accidentally dragging selections. Doesn't affect the card / heading pickup-modifier drag.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'jumpToDocTopOnReadModeToggle',
    label: 'Jump to doc top when read mode toggles',
    description:
      'When on, toggling read mode (in either direction) scrolls to the top of the doc and places the cursor at the start. Off by default — the viewport stays where it was.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'findRememberLastQuery',
    label: 'Find: remember the last search query',
    description:
      "When on, reopening the find bar (Ctrl-F / Ctrl-H / Alt-F) pre-fills the input with whatever you last searched for. Off by default — the bar opens empty so each search is a clean slate.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'findCategoryOrder',
    label: 'Find: category priority order',
    description:
      'Ctrl-F groups search results by which kind of paragraph they appear in, and Next steps through groups in this order. Within each group, the first match is whichever is closest to your cursor (the cursor counts as the top — matches AFTER it come first, then matches before, like wrap-around). Reorder via the up / down buttons. Alt-F ignores this and goes purely by proximity.',
    kind: 'findCategoryOrder',
    category: 'general',
  },

  // ─── Appearance ─────────────────────────────────────────────────
  {
    key: 'theme',
    label: 'Theme',
    description:
      "Light, dark, or follow the operating system's preference. System mode tracks OS-level changes live.",
    kind: 'theme',
    category: 'appearance',
  },
  {
    key: 'themeAppliesToDocument',
    label: 'Apply theme to the document area',
    description:
      "Off by default: when the theme is dark (or system-resolved dark), only the chrome — ribbon, nav, status bar — goes dark. The document area stays light, so cards still read like paper. Turn on to make the document itself follow the theme.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'showDocNameChip',
    label: 'Show doc name in ribbon',
    description:
      "Off by default. When on, the active document's filename appears as a pill in the center of the ribbon — useful when the OS title bar is hidden, unstyled, or non-existent (tiling window managers, frameless windows, web embeds). Hidden in multi-pane mode because each per-pane chip already shows its slot's filename.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'formatNavPaneByType',
    label: 'Format nav pane entries by type',
    description:
      "On by default. When on, top-level headings render bold, lower levels in lighter weight and size, and analytic entries in the analytic-blue accent. Turn off for a uniform list where only indentation conveys hierarchy.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here.",
    kind: 'displaySizes',
    category: 'appearance',
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    kind: 'displayTypography',
    category: 'appearance',
  },
  {
    key: 'displayColors',
    label: 'Style colors',
    description:
      'Pick the color used for Analytic and Undertag text.',
    kind: 'displayColors',
    category: 'appearance',
  },
  {
    key: 'timerProfile',
    label: 'Timer profile',
    description:
      "Picks which set of durations the timer is currently running on. Each profile remembers its own customizations, so changing values below saves to the active profile (no separate 'custom' option). Defaults: High school = 3/5/8 + 8 min prep, College = 3/6/9 + 10 min prep, Pomodoro = 25/15/5 + 0 prep.",
    kind: 'timerProfile',
    category: 'appearance',
  },
  {
    key: 'timerProfiles',
    label: 'Timer durations',
    description:
      "Edit the active profile's three preset durations (in minutes, biggest first — these become the top-right 9 / 6 / 3 buttons on the panel) and the per-side prep total. Changes save into the currently-selected profile only.",
    kind: 'timerProfileDurations',
    category: 'appearance',
  },
  {
    key: 'timerPrepLabel',
    label: 'Prep button label style',
    description:
      "How the Aff / Neg prep buttons identify which side they belong to. 'Text' uses A: / N: prefixes with no special color. 'Color' uses blue / red without the prefix. 'Both' (default) uses prefix and color together.",
    kind: 'timerPrepLabel',
    category: 'appearance',
  },
  {
    key: 'timerCompact',
    label: 'Compact timer layout',
    description:
      "Drops the 9 / 6 / 3 speech-preset buttons and tucks Reset under Start / Pause. Useful when the ribbon is tight.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'timerFlashEnabled',
    label: 'Flash timer when countdown is low',
    description:
      "Flash the speech-timer display red when remaining time crosses one of the configured thresholds (5 / 3 / 1 seconds by default).",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'reduceMotion',
    label: 'Reduce motion',
    description:
      "Disable UI animations and transitions (drag-pickup vacuum, popover slides, etc.). 'System' follows your OS preference; 'On' always reduces motion; 'Off' overrides the OS and plays full motion.",
    kind: 'reduceMotion',
    category: 'accessibility',
  },
  {
    key: 'overrideHighlightColor',
    label: 'Override highlight color in display',
    description:
      "When on, highlights in the doc render in the override colors below regardless of what's stored on the mark. Display-only — the doc itself is untouched, so re-saving preserves the original per-mark colors. Useful when cards from many sources have inconsistent highlight conventions and you want a unified read.",
    kind: 'toggle',
    category: 'accessibility',
  },
  {
    key: 'overrideHighlightSlots',
    label: 'Highlight override colors',
    description:
      "Up to 3 ordered colors. With one slot, every highlight renders in that color. With two or three, the most-common highlight color in the doc gets slot 1, the second-most-common gets slot 2, and everything else gets the last slot. The ranking re-computes automatically as the doc changes.",
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideHighlightColor',
  },
  {
    key: 'overrideShadingColor',
    label: 'Override shading color in display',
    description:
      "Same idea, applied to shading marks (Verbatim's protected-grey emphasis variant). Doc data is untouched.",
    kind: 'toggle',
    category: 'accessibility',
  },
  {
    key: 'overrideShadingSlots',
    label: 'Shading override colors',
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideShadingColor',
  },
  {
    key: 'customColorOverrides',
    label: 'Color overrides',
    description:
      "Override any color in the interface. Explicit overrides here always win over the defaults and over future accessibility presets (high-contrast, dark mode, colorblind-friendly, etc.) — pick a color to override it; reset a row to fall back to whichever preset is active.",
    kind: 'colorOverrides',
    category: 'accessibility',
  },
  {
    key: 'uiFont',
    label: 'Interface font',
    description:
      'Font family for the user interface — ribbon, dialogs, navigation pane, comments column, etc. Distinct from the body font (the editor content font). "System default" uses the platform\'s native UI font stack.',
    kind: 'uiFont',
    category: 'accessibility',
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      'Font family for body text.',
    kind: 'bodyFont',
    category: 'appearance',
  },
  {
    key: 'lineHeight',
    label: 'Line spacing',
    description:
      'Line-spacing multiplier per paragraph type (unitless × font-size).',
    kind: 'lineHeights',
    category: 'appearance',
  },
  {
    key: 'ribbonTooltipMode',
    label: 'Ribbon tooltips',
    description:
      'What hovering a ribbon button reveals. "Both" shows the action label and its current keyboard shortcut. "Label only" hides the shortcut. "Shortcut only" hides the label and is recommended for users who already know what each button does but still want a key reminder. "None" disables ribbon tooltips entirely. Dropdown menu items (Doc / Card / Table menus, etc.) always show shortcut-only — the menu label already says what the action does.',
    kind: 'ribbonTooltipMode',
    category: 'appearance',
  },
  {
    key: 'formattingPanelMode',
    label: 'Formatting panel',
    description:
      'How the Pocket / Hat / Block / Tag / Analytic buttons in the ribbon are displayed. "Labels" shows the style name, "Shortcuts" shows the keyboard binding, "Both" shows name · shortcut, "Hidden" removes the panel.',
    kind: 'formattingPanelMode',
    category: 'appearance',
  },
  {
    key: 'showDropzonePill',
    label: 'Show dropzone shelf in nav pane',
    description:
      'When on, the cross-window dropzone pill sits at the bottom of the navigation pane. Turning it off hides the pill from the chrome; the shelf state and the Send to Dropzone shortcut still work — items pile up in the store and can be retrieved from any window that has the pill visible.',
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'formattingPanelPreview',
    label: 'Preview styles in formatting panel',
    description:
      'When on, formatting-panel buttons preview the visual treatment of the style they apply.',
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'showCharacterStyles',
    label: 'Show character styles',
    description:
      'Show the cite / underline / emphasis character-style buttons in the ribbon. When off, just that sub-panel is hidden; the rest of the formatting panel stays visible.',
    kind: 'toggle',
    category: 'appearance',
  },

  // ─── Editing ────────────────────────────────────────────────────
  {
    key: 'paragraphIntegrity',
    label: 'F3 condense: preserve paragraph integrity',
    description:
      'When on, F3 only removes intra-paragraph whitespace — paragraphs stay separate. When off, F3 merges consecutive collapsible paragraphs.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'usePilcrows',
    label: 'F3 condense: use pilcrow markers',
    description:
      'When paragraph integrity is off and this is on, F3 inserts a 6-pt ¶ at each original paragraph boundary in the merged result, so that the split can be reversed via Ctrl/Cmd+Alt+Shift+F3 (Uncondense).',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'condenseOnPaste',
    label: 'Condense after Paste Text (F2)',
    description:
      'When on, text that you paste will be condensed using your default "condense" settings.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'headingMode',
    label: 'Condense: heading handling',
    description:
      'How selection-based condense without paragraph integrity treats structural elements (headings, cites, undertags) inside the selection. "Strict" blocks attempts to condense that include structural elements. "Respect" (default) keeps structural paragraphs unmerged and merges everything else in the selection. "Demolish" merges everything in the selection.',
    kind: 'headingMode',
    category: 'editing',
  },
  {
    key: 'condenseWarningDelimiter',
    label: 'Condense with warning: marker delimiter',
    description:
      'Which bracket style wraps the PARAGRAPH INTEGRITY PAUSES / RESUMES markers added by "Condense with warning" (Card menu).',
    kind: 'condenseWarningDelimiter',
    category: 'editing',
  },
  {
    key: 'shrinkRestoresOmissionsToNormal',
    label: 'Shrink keeps protected text at Normal size',
    description:
      'When on, Shrink (Mod-8) leaves bracketed "Omitted" spans, the PARAGRAPH INTEGRITY PAUSES/RESUMES markers from "Condense with warning", and any custom protections (below) at Normal size so they stay visible in the shrunken output. When off, all of these are shrunk along with the rest of the text.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'shrinkCustomProtections',
    label: 'Custom shrink protections',
    description:
      'Strings (or regex sources, if the box is checked) that Shrink should leave at Normal size whenever protection is on. Literal entries are matched case-insensitively after escaping; regex entries are compiled with `gi` flags. Invalid regex entries are skipped.',
    kind: 'shrinkCustomProtections',
    category: 'editing',
  },
  {
    key: 'clearFormattingOnNamedStyleToggleOff',
    label: 'F9 toggle-off also clears direct formatting',
    description:
      'When on, pressing F9 to toggle underlining off also strips direct formatting in the range. When off, only the underline style mark is removed; direct formatting applied to the underlined text is preserved.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'forReferenceUseGray50',
    label: 'Create Reference uses Gray-50% text',
    description:
      'When on, the body text of a "Create Reference" excerpt is rendered in Gray-50% (#808080) instead of black. The heading line stays black either way.',
    kind: 'toggle',
    category: 'editing',
  },

  // ─── Keyboard shortcuts ─────────────────────────────────────────
  {
    key: 'ribbonKeyOverrides',
    label: 'Keyboard shortcuts',
    description:
      'Rebind any ribbon / menu command to your own keys. Click + on a row to add a binding; click × on a chip to remove one; click ↺ to restore that row\'s defaults.',
    kind: 'keybindings',
    category: 'shortcuts',
  },

  // ─── Comments & AI ──────────────────────────────────────────────
  {
    key: 'commentAuthor',
    label: 'Comment author name',
    description: 'Display name attached to comments you create. Stored locally.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'commentAuthorInitials',
    label: 'Comment author initials',
    description: 'Short badge shown on your comments. Auto-derived from the name if left empty.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'aiFeaturesEnabled',
    label: 'Enable AI features',
    description:
      'Master switch for AI-powered comment features (in-comment "Explain" prompts, @AI mentions). Requires an Anthropic API key below.',
    kind: 'toggle',
    category: 'comments-ai',
  },
  {
    key: 'anthropicApiKey',
    label: 'Anthropic API key',
    description:
      'Used only when AI features are enabled. Stored locally in browser settings; sent only to api.anthropic.com.',
    kind: 'password',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
  },
  {
    key: 'clodEnabled',
    label: 'Enable Clod mode',
    description:
      'When the AI is composing a reply, the in-flight placeholder cycles through time-of-day Clod activities ("Clod is making toast…") instead of plain "Thinking…".',
    kind: 'clod',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
  },
  {
    key: 'aiCitePrompt',
    label: 'AI cite-creator prompt',
    description:
      'System prompt the cite-creator hands to the model. Click "Edit prompt" to open a full-size editor. Leave blank to use the built-in default.',
    kind: 'aiCitePrompt',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
  },
];

type Listener = (s: Readonly<Settings>) => void;

export class SettingsStore {
  private values: Settings;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.values = this.load();
    // Cross-window propagation. The browser `storage` event fires on
    // every window that shares the origin EXCEPT the one that wrote
    // the change — so this won't infinite-loop. Electron's
    // BrowserWindows follow the same Web standard, which means
    // settings changes in any window flow to all other live windows
    // without explicit IPC. We reload the full snapshot rather than
    // patching by key: localStorage holds the whole settings object
    // under one key, so the simplest correct behavior is "reapply
    // what's now on disk."
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.storageArea !== localStorage) return;
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const incoming = this.load();
        // Transient keys (e.g., read mode) stay window-local: don't
        // let another window's persisted state override what THIS
        // window has chosen. The originating window persists only
        // the non-transient keys, but a fresh load() would still
        // hydrate transients from DEFAULTS — which would erase
        // this window's current value if we didn't pin it.
        for (const key of TRANSIENT_SETTING_KEYS) {
          (incoming as unknown as Record<string, unknown>)[key] = (
            this.values as unknown as Record<string, unknown>
          )[key];
        }
        this.values = incoming;
        this.notify();
      });
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    if (!TRANSIENT_SETTING_KEYS.has(key as string)) this.persist();
    this.notify();
  }

  all(): Readonly<Settings> {
    return { ...this.values };
  }

  /** Subscribe to any settings change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Strip transient keys before merging — they're per-
          // session/per-window. If an earlier version of the app
          // happened to persist `readMode`, we don't want this
          // window to boot into it.
          for (const key of TRANSIENT_SETTING_KEYS) {
            delete (parsed as Record<string, unknown>)[key];
          }
          return sanitize({ ...DEFAULTS, ...parsed });
        }
      }
      // Migrate legacy individual keys, if any.
      const legacy: Partial<Settings> = {};
      const navWidth = localStorage.getItem('pmd-nav-width');
      if (navWidth != null) {
        const n = parseInt(navWidth, 10);
        if (Number.isFinite(n)) legacy.navWidth = n;
      }
      const navMaxLevel = localStorage.getItem('pmd-nav-max-level');
      if (navMaxLevel != null) {
        const n = parseInt(navMaxLevel, 10);
        if (Number.isFinite(n)) legacy.navMaxLevel = n;
      }
      return sanitize({ ...DEFAULTS, ...legacy });
    } catch {
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    try {
      // Strip transient keys before serializing so they neither
      // survive a reload nor (more importantly) trigger a storage
      // event with a stale read-mode flag for other windows.
      const toStore: Record<string, unknown> = { ...this.values };
      for (const key of TRANSIENT_SETTING_KEYS) delete toStore[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch {
      /* localStorage full / disabled — ignore */
    }
  }

  private notify(): void {
    const snapshot = { ...this.values };
    for (const listener of this.listeners) listener(snapshot);
  }
}

function sanitize(s: Settings): Settings {
  return {
    navWidth: clamp(s.navWidth, 150, 800),
    navMaxLevel: clamp(Math.round(s.navMaxLevel), 1, 4),
    // Default-on: preserve `false` only when explicitly set so the
    // onboarding shows up for new installs and survives upgrades
    // from before this setting existed.
    showOnboardingStarter: s.showOnboardingStarter === false ? false : true,
    defaultSpeechDocFolder:
      typeof s.defaultSpeechDocFolder === 'string'
        ? s.defaultSpeechDocFolder
        : '',
    defaultSpeechDocFormat:
      s.defaultSpeechDocFormat === 'cmir' ? 'cmir' : 'docx',
    defaultSaveFormat:
      s.defaultSaveFormat === 'cmir' ? 'cmir' : 'docx',
    theme:
      s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
    themeAppliesToDocument: !!s.themeAppliesToDocument,
    showDocNameChip: !!s.showDocNameChip,
    checkForUpdatesOnLaunch: !!s.checkForUpdatesOnLaunch,
    commentsColumnWidth:
      typeof s.commentsColumnWidth === 'number' && Number.isFinite(s.commentsColumnWidth)
        ? Math.max(240, Math.min(560, s.commentsColumnWidth))
        : 320,
    reduceMotion:
      s.reduceMotion === 'on' || s.reduceMotion === 'off' ? s.reduceMotion : 'auto',
    overrideHighlightColor: !!s.overrideHighlightColor,
    overrideHighlightSlots: sanitizeColorSlots(
      s.overrideHighlightSlots,
      (s as { overrideHighlightColorValue?: unknown }).overrideHighlightColorValue,
      '#ffff00',
    ),
    overrideShadingColor: !!s.overrideShadingColor,
    overrideShadingSlots: sanitizeColorSlots(
      s.overrideShadingSlots,
      (s as { overrideShadingColorValue?: unknown }).overrideShadingColorValue,
      '#d2d2d2',
    ),
    customColorOverrides: sanitizeCustomColorOverrides(s.customColorOverrides),
    // navPaneVisible defaults to TRUE when missing — the user
    // opens to an outline-visible window unless they've already
    // dismissed it during the session (transient — see
    // TRANSIENT_SETTING_KEYS).
    navPaneVisible: s.navPaneVisible === false ? false : true,
    // formatNavPaneByType defaults to TRUE — current behavior.
    formatNavPaneByType: s.formatNavPaneByType === false ? false : true,
    timerProfile:
      s.timerProfile === 'highSchool' || s.timerProfile === 'pomodoro'
        ? s.timerProfile
        : 'college',
    timerProfiles: sanitizeTimerProfiles(s.timerProfiles),
    timerSpeechPresets: sanitizeNumberTriple(s.timerSpeechPresets, [3, 6, 9]),
    timerPrepMinutes:
      typeof s.timerPrepMinutes === 'number' && s.timerPrepMinutes > 0 && s.timerPrepMinutes <= 999
        ? Math.floor(s.timerPrepMinutes)
        : 10,
    timerFlashEnabled: s.timerFlashEnabled === false ? false : true,
    timerFlashSeconds: sanitizeFlashSeconds(s.timerFlashSeconds),
    timerCompact: !!s.timerCompact,
    timerPrepLabel:
      s.timerPrepLabel === 'text' || s.timerPrepLabel === 'color'
        ? s.timerPrepLabel
        : 'both',
    jumpToDocTopOnReadModeToggle: !!s.jumpToDocTopOnReadModeToggle,
    findResultsExpanded: !!s.findResultsExpanded,
    findRememberLastQuery:
      s.findRememberLastQuery === true ? true : false,
    findLastQuery:
      typeof s.findLastQuery === 'string'
        ? s.findLastQuery.slice(0, 1024)
        : '',
    findCategoryOrder: sanitizeFindCategoryOrder(s.findCategoryOrder),
    includeSpeechDocPocket:
      s.includeSpeechDocPocket === false ? false : true,
    showCitePreview: !!s.showCitePreview,
    editorSpellcheck: !!s.editorSpellcheck,
    autosaveEnabled: !!s.autosaveEnabled,
    // Default to `false` when missing — matches the persisted
    // default. Saved settings from before this option existed
    // explicitly opt out of text drag, since the inconsistent-undo
    // behavior the option works around predates the option itself.
    enableTextDragDrop: s.enableTextDragDrop === true,
    readMode: !!s.readMode,
    hideEmphasisBordersInReadMode: !!s.hideEmphasisBordersInReadMode,
    zoomPct: clamp(Math.round(s.zoomPct / 10) * 10, 50, 200),
    chromeScalePct: clamp(Math.round(s.chromeScalePct / 10) * 10, 50, 200),
    readers: sanitizeReaders(s.readers),
    displaySizes: sanitizeDisplaySizes(s.displaySizes),
    displayTypography: sanitizeDisplayTypography(s.displayTypography),
    displayColors: sanitizeDisplayColors(s.displayColors),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    uiFont: sanitizeUiFont(s.uiFont),
    ribbonTooltipMode: sanitizeRibbonTooltipMode(s.ribbonTooltipMode),
    showDropzonePill: s.showDropzonePill !== false,
    lineHeight: sanitizeLineHeight(s.lineHeight, DEFAULTS.lineHeight),
    lineHeightCite: sanitizeLineHeight(s.lineHeightCite, DEFAULTS.lineHeightCite),
    lineHeightTag: sanitizeLineHeight(s.lineHeightTag, DEFAULTS.lineHeightTag),
    lineHeightAnalytic: sanitizeLineHeight(s.lineHeightAnalytic, DEFAULTS.lineHeightAnalytic),
    lineHeightHeading: sanitizeLineHeight(s.lineHeightHeading, DEFAULTS.lineHeightHeading),
    lineHeightUndertag: sanitizeLineHeight(s.lineHeightUndertag, DEFAULTS.lineHeightUndertag),
    formattingPanelMode: FORMATTING_PANEL_MODES.includes(s.formattingPanelMode as FormattingPanelMode)
      ? (s.formattingPanelMode as FormattingPanelMode)
      : DEFAULTS.formattingPanelMode,
    formattingPanelPreview:
      s.formattingPanelPreview === undefined
        ? DEFAULTS.formattingPanelPreview
        : !!s.formattingPanelPreview,
    showCharacterStyles:
      s.showCharacterStyles === undefined
        ? DEFAULTS.showCharacterStyles
        : !!s.showCharacterStyles,
    lastHighlightColor: isWordHighlightName(String(s.lastHighlightColor ?? ''))
      ? String(s.lastHighlightColor)
      : DEFAULTS.lastHighlightColor,
    lastShadingColor: isHex6(s.lastShadingColor)
      ? String(s.lastShadingColor).toUpperCase()
      : DEFAULTS.lastShadingColor,
    lastFontColor:
      s.lastFontColor === null || s.lastFontColor === undefined
        ? DEFAULTS.lastFontColor
        : isHex6(s.lastFontColor)
        ? String(s.lastFontColor).toUpperCase()
        : DEFAULTS.lastFontColor,
    paragraphIntegrity:
      s.paragraphIntegrity === undefined
        ? DEFAULTS.paragraphIntegrity
        : !!s.paragraphIntegrity,
    usePilcrows:
      s.usePilcrows === undefined
        ? DEFAULTS.usePilcrows
        : !!s.usePilcrows,
    headingMode: HEADING_MODES.includes(s.headingMode as HeadingMode)
      ? (s.headingMode as HeadingMode)
      : DEFAULTS.headingMode,
    condenseOnPaste:
      s.condenseOnPaste === undefined
        ? DEFAULTS.condenseOnPaste
        : !!s.condenseOnPaste,
    clearFormattingOnNamedStyleToggleOff:
      s.clearFormattingOnNamedStyleToggleOff === undefined
        ? DEFAULTS.clearFormattingOnNamedStyleToggleOff
        : !!s.clearFormattingOnNamedStyleToggleOff,
    forReferenceUseGray50:
      s.forReferenceUseGray50 === undefined
        ? DEFAULTS.forReferenceUseGray50
        : !!s.forReferenceUseGray50,
    shrinkRestoresOmissionsToNormal:
      s.shrinkRestoresOmissionsToNormal === undefined
        ? DEFAULTS.shrinkRestoresOmissionsToNormal
        : !!s.shrinkRestoresOmissionsToNormal,
    condenseWarningDelimiter: CONDENSE_WARNING_DELIMITERS.includes(
      s.condenseWarningDelimiter as CondenseWarningDelimiter,
    )
      ? (s.condenseWarningDelimiter as CondenseWarningDelimiter)
      : DEFAULTS.condenseWarningDelimiter,
    condenseWarningCustomPauseMarker:
      typeof s.condenseWarningCustomPauseMarker === 'string'
        ? s.condenseWarningCustomPauseMarker
        : DEFAULTS.condenseWarningCustomPauseMarker,
    condenseWarningCustomResumeMarker:
      typeof s.condenseWarningCustomResumeMarker === 'string'
        ? s.condenseWarningCustomResumeMarker
        : DEFAULTS.condenseWarningCustomResumeMarker,
    shrinkCustomProtections: sanitizeShrinkProtections(s.shrinkCustomProtections),
    ribbonKeyOverrides: sanitizeRibbonKeyOverrides(s.ribbonKeyOverrides),
    commentAuthor:
      typeof s.commentAuthor === 'string' && s.commentAuthor.length > 0
        ? s.commentAuthor
        : DEFAULTS.commentAuthor,
    commentAuthorInitials:
      typeof s.commentAuthorInitials === 'string'
        ? s.commentAuthorInitials
        : DEFAULTS.commentAuthorInitials,
    commentsVisible: !!s.commentsVisible,
    anthropicApiKey:
      typeof s.anthropicApiKey === 'string'
        ? s.anthropicApiKey
        : DEFAULTS.anthropicApiKey,
    aiFeaturesEnabled: !!s.aiFeaturesEnabled,
    clodEnabled: !!s.clodEnabled,
    clodActivitiesByTime: sanitizeClodActivitiesByTime(s.clodActivitiesByTime),
    clodTimePeriods: sanitizeClodTimePeriods(s.clodTimePeriods),
    aiPersonaName:
      typeof s.aiPersonaName === 'string' && s.aiPersonaName.trim()
        ? s.aiPersonaName.trim()
        : DEFAULTS.aiPersonaName,
    aiPersonaPronouns: ['he', 'she', 'they', 'it', 'custom'].includes(s.aiPersonaPronouns as string)
      ? (s.aiPersonaPronouns as Settings['aiPersonaPronouns'])
      : DEFAULTS.aiPersonaPronouns,
    aiPersonaCustomPronouns: sanitizeCustomPronouns(s.aiPersonaCustomPronouns),
    aiCitePrompt:
      typeof s.aiCitePrompt === 'string' ? s.aiCitePrompt : DEFAULTS.aiCitePrompt,
    multiDocWorkspace: !!s.multiDocWorkspace,
    multiDocLayoutMode:
      s.multiDocLayoutMode === 'wide' || s.multiDocLayoutMode === 'compact'
        ? s.multiDocLayoutMode
        : DEFAULTS.multiDocLayoutMode,
  };
}

/** Accept a hex color string (`#rrggbb`, case-insensitive); fall
 *  back to `defaultValue` otherwise. Used by the highlight /
 *  shading display-override settings. */
function sanitizeHexColor(raw: unknown, defaultValue: string): string {
  if (typeof raw !== 'string') return defaultValue;
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return defaultValue;
}

/** Validate + clamp the 1–3-color slots arrays used by the
 *  highlight / shading display overrides. Accepts hex or
 *  rgba/rgb strings. Migrates from the previous single-color
 *  field (`overrideHighlightColorValue` / `overrideShadingColorValue`)
 *  when the new array is absent. Always returns at least one
 *  entry — `defaultValue` if everything else is missing. */
function sanitizeColorSlots(
  raw: unknown,
  legacy: unknown,
  defaultValue: string,
): string[] {
  const isColor = (v: unknown): v is string =>
    typeof v === 'string' &&
    (
      /^#[0-9a-fA-F]{6}$/.test(v.trim()) ||
      /^rgba?\(/.test(v.trim())
    );
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (isColor(v)) out.push(v.trim());
      if (out.length >= 3) break;
    }
    if (out.length > 0) return out;
  }
  // Migration: pre-multi-slot installs had a single color stored
  // in `overrideHighlightColorValue` / `overrideShadingColorValue`.
  // Copy it into slot 0 if present.
  if (isColor(legacy)) return [legacy.trim()];
  return [defaultValue];
}

/** Filter a Record<string, string> against the registered list of
 *  customizable color tokens. Keeps entries whose key matches a
 *  known token AND whose value parses as a CSS color (we accept
 *  any non-empty string here; CSS will reject malformed values
 *  silently when applied). Used to scrub the persisted
 *  `customColorOverrides` blob. */
function sanitizeCustomColorOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const known = new Set(CUSTOMIZABLE_COLOR_TOKENS.map((t) => t.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    if (typeof v !== 'string' || v.trim() === '') continue;
    out[k] = v.trim();
  }
  return out;
}

/** Manifest of color tokens the user can override via the
 *  accessibility panel. Keys are CSS-variable names without the
 *  `--` prefix; labels are human-readable; groups cluster the UI
 *  into sections. Defaults come from the cascade at runtime
 *  (`getComputedStyle`) so the manifest stays in sync with
 *  style.css without duplicating values here.
 *
 *  To add a new override, append an entry; to remove one, just
 *  delete the entry (existing user overrides for that token will
 *  be dropped by `sanitizeCustomColorOverrides` on next load). */
export interface CustomizableColorToken {
  name: string;
  label: string;
  group: string;
}
export const CUSTOMIZABLE_COLOR_TOKENS: readonly CustomizableColorToken[] = [
  // Surface
  { group: 'Surface', name: 'pmd-c-bg', label: 'Background (page / panels / buttons)' },
  { group: 'Surface', name: 'pmd-c-bg-soft', label: 'Off-white row background' },
  { group: 'Surface', name: 'pmd-c-surface', label: 'Chrome surface (ribbon / status bar)' },
  { group: 'Surface', name: 'pmd-c-surface-soft', label: 'Soft surface (nav header)' },
  { group: 'Surface', name: 'pmd-c-surface-alt', label: 'Alt surface (editor viewport / code)' },
  { group: 'Surface', name: 'pmd-c-overlay', label: 'Modal scrim' },

  // Borders
  { group: 'Borders', name: 'pmd-c-border', label: 'Button border' },
  { group: 'Borders', name: 'pmd-c-border-soft', label: 'Chrome border (ribbon, nav)' },
  { group: 'Borders', name: 'pmd-c-divider', label: 'Divider' },
  { group: 'Borders', name: 'pmd-c-divider-faint', label: 'Faint divider' },

  // Text
  { group: 'Text', name: 'pmd-c-text', label: 'Body text' },
  { group: 'Text', name: 'pmd-c-text-strong', label: 'Strong text (max contrast)' },
  { group: 'Text', name: 'pmd-c-text-secondary', label: 'Secondary text' },
  { group: 'Text', name: 'pmd-c-text-muted', label: 'Muted text' },
  { group: 'Text', name: 'pmd-c-text-faint', label: 'Faint text' },
  { group: 'Text', name: 'pmd-c-text-on-accent', label: 'Text on accent surface' },

  // Hover / press
  { group: 'Interaction', name: 'pmd-c-hover', label: 'Hover background' },
  { group: 'Interaction', name: 'pmd-c-hover-strong', label: 'Selected / pressed background' },

  // Accent
  { group: 'Accent', name: 'pmd-c-accent', label: 'Accent (primary)' },
  { group: 'Accent', name: 'pmd-c-accent-hover', label: 'Accent hover' },
  { group: 'Accent', name: 'pmd-c-accent-soft', label: 'Accent tint' },
  { group: 'Accent', name: 'pmd-c-focus', label: 'Focus ring' },

  // Status
  { group: 'Status', name: 'pmd-c-success', label: 'Success' },
  { group: 'Status', name: 'pmd-c-warning', label: 'Warning' },
  { group: 'Status', name: 'pmd-c-error', label: 'Error' },
  { group: 'Status', name: 'pmd-c-danger', label: 'Danger (close)' },

  // Drop / drag
  { group: 'Drag affordances', name: 'pmd-c-drop', label: 'Drop indicator' },
  { group: 'Drag affordances', name: 'pmd-c-drop-soft', label: 'Drop indicator (soft)' },
  { group: 'Drag affordances', name: 'pmd-c-drop-mid', label: 'Drop indicator (mid)' },

  // Speech-doc
  { group: 'Speech doc', name: 'pmd-c-speech-bg', label: 'Speech-doc band background' },
  { group: 'Speech doc', name: 'pmd-c-speech-border', label: 'Speech-doc band border' },
  { group: 'Speech doc', name: 'pmd-c-speech-text', label: 'Speech-doc band text' },

  // Editor decorations
  { group: 'Editor', name: 'pmd-c-card-hover', label: 'Card hover indicator' },
  { group: 'Editor', name: 'pmd-c-emphasis-box', label: 'Emphasis box border' },
  { group: 'Editor', name: 'pmd-c-highlight-default', label: 'New-highlight default color' },

  // Per-style document colors (these duplicate displayColors but
  // are reachable via this panel too for advanced users).
  { group: 'Document text', name: 'pmd-color-analytic', label: 'Analytic text' },
  { group: 'Document text', name: 'pmd-color-undertag', label: 'Undertag text' },
];

/** Validate a 3-tuple of positive integer minutes for the
 *  timer's speech presets. Fills missing / invalid entries with
 *  the fallback. */
function sanitizeNumberTriple(raw: unknown, fallback: number[]): number[] {
  const out = [...fallback];
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < 3; i++) {
    const v = raw[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 999) {
      out[i] = Math.floor(v);
    }
  }
  return out;
}

/** Validate the per-profile saved-config map. Each profile id
 *  gets a `{ speechPresets, prepMinutes }` object back; missing
 *  / malformed slots fall back to the profile's conventional
 *  defaults. */
function sanitizeTimerProfiles(
  raw: unknown,
): Settings['timerProfiles'] {
  const defaults: Settings['timerProfiles'] = {
    highSchool: { speechPresets: [3, 5, 8], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5], prepMinutes: 0 },
  };
  if (!raw || typeof raw !== 'object') return defaults;
  const src = raw as Record<string, unknown>;
  const out: Settings['timerProfiles'] = {
    highSchool: defaults.highSchool,
    college: defaults.college,
    pomodoro: defaults.pomodoro,
  };
  for (const id of ['highSchool', 'college', 'pomodoro'] as const) {
    const entry = src[id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    out[id] = {
      speechPresets: sanitizeNumberTriple(e['speechPresets'], defaults[id].speechPresets),
      prepMinutes:
        typeof e['prepMinutes'] === 'number' &&
        e['prepMinutes'] >= 0 &&
        e['prepMinutes'] <= 999
          ? Math.floor(e['prepMinutes'])
          : defaults[id].prepMinutes,
    };
  }
  return out;
}

/** Validate a list of flash-threshold seconds. Filters to positive
 *  integers ≤ 3600 (1 hour); falls back to [5, 3, 1] if empty. */
function sanitizeFlashSeconds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [5, 3, 1];
  const cleaned = raw
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600)
    .map((v) => Math.floor(v));
  return cleaned.length > 0 ? cleaned : [5, 3, 1];
}

function sanitizeFindCategoryOrder(
  raw: unknown,
): Settings['findCategoryOrder'] {
  const valid: Settings['findCategoryOrder'] = ['heading', 'tag', 'cite', 'other'];
  if (!Array.isArray(raw)) return valid;
  const seen = new Set<string>();
  const out: Settings['findCategoryOrder'] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    if (!valid.includes(v as Settings['findCategoryOrder'][number])) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v as Settings['findCategoryOrder'][number]);
  }
  // Append any categories missing from `raw` (so legacy / partial
  // saves still produce a complete permutation).
  for (const c of valid) {
    if (!seen.has(c)) out.push(c);
  }
  return out;
}

function sanitizeCustomPronouns(raw: unknown): Settings['aiPersonaCustomPronouns'] {
  const out = { ...DEFAULTS.aiPersonaCustomPronouns };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Settings['aiPersonaCustomPronouns']>;
  for (const k of ['subject', 'object', 'possessive', 'reflexive'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function sanitizeClodActivitiesByTime(raw: unknown): Settings['clodActivitiesByTime'] {
  const out = {
    morning: [] as string[],
    day: [] as string[],
    evening: [] as string[],
    night: [] as string[],
  };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  }
  return out;
}

function sanitizeClodTimePeriods(raw: unknown): Settings['clodTimePeriods'] {
  const out = { ...DEFAULTS.clodTimePeriods };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (!v || typeof v !== 'object') continue;
    const obj = v as { start?: unknown; end?: unknown };
    const start = Number(obj.start);
    const end = Number(obj.end);
    if (
      Number.isInteger(start) && start >= 0 && start <= 23 &&
      Number.isInteger(end) && end >= 0 && end <= 23
    ) {
      out[k] = { start, end };
    }
  }
  return out;
}

function sanitizeShrinkProtections(raw: unknown): ShrinkProtection[] {
  if (!Array.isArray(raw)) return [];
  const out: ShrinkProtection[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const pattern = (r as ShrinkProtection).pattern;
    if (typeof pattern !== 'string') continue;
    out.push({ pattern, isRegex: !!(r as ShrinkProtection).isRegex });
  }
  return out;
}

/** Keep only string / string[] entries, coercing arrays to plain arrays
 *  of strings. Unknown keys pass through — we don't import the
 *  ribbon-command ID list here (it would create an import cycle), so
 *  any obsolete IDs from a future schema change will simply have no
 *  effect at lookup time. */
function sanitizeRibbonKeyOverrides(
  raw: unknown,
): Partial<Record<RibbonCommandId, string | string[]>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<string, string | string[]>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === 'string');
      out[k] = cleaned;
    }
  }
  return out as Partial<Record<RibbonCommandId, string | string[]>>;
}

function sanitizeLineHeight(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  // Round to 0.05 steps; clamp to [1.0, 2.0] — the input UI uses the
  // same step / range.
  return clamp(Math.round(n * 20) / 20, 1.0, 2.0);
}

function sanitizeBodyFont(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULTS.bodyFont;
  // Strip any quotes or commas — bodyFont must be a single font-family
  // name. A previous iteration accepted free-form input, so a stale
  // persisted value might contain `"Calibri", sans-serif` or similar.
  const cleaned = raw.replace(/["',]/g, '').trim();
  return cleaned || DEFAULTS.bodyFont;
}

function sanitizeUiFont(raw: unknown): string {
  // uiFont is `''` by default (= use the stylesheet's system-UI
  // default). Any other value must be a single family name; same
  // quote / comma stripping as `sanitizeBodyFont`.
  if (typeof raw !== 'string') return DEFAULTS.uiFont;
  return raw.replace(/["',]/g, '').trim();
}

function sanitizeRibbonTooltipMode(
  raw: unknown,
): 'none' | 'tooltip' | 'shortcut' | 'both' {
  if (raw === 'none' || raw === 'tooltip' || raw === 'shortcut' || raw === 'both') {
    return raw;
  }
  return DEFAULTS.ribbonTooltipMode;
}

function sanitizeDisplayTypography(raw: unknown): DisplayTypography {
  const out = { ...DEFAULT_DISPLAY_TYPOGRAPHY };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplayTypography, unknown>>;
  out.citeUnderlined = !!r.citeUnderlined;
  out.underlineBold = !!r.underlineBold;
  out.emphasisBold = r.emphasisBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBold : !!r.emphasisBold;
  out.emphasisItalic = !!r.emphasisItalic;
  out.emphasisBox = r.emphasisBox === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBox : !!r.emphasisBox;
  out.undertagItalic = r.undertagItalic === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagItalic : !!r.undertagItalic;
  out.undertagBold = r.undertagBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagBold : !!r.undertagBold;
  const bs = Number(r.emphasisBoxSize);
  if (Number.isFinite(bs) && bs > 0 && bs <= 12) {
    out.emphasisBoxSize = Math.round(bs * 4) / 4; // quarter-pt precision
  }
  return out;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  // Accept #abc and #abcdef; normalize to 6-digit lowercase.
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

function sanitizeDisplayColors(raw: unknown): DisplayColors {
  const out = { ...DEFAULT_DISPLAY_COLORS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplayColors, unknown>>;
  for (const key of DISPLAY_COLOR_KEYS) {
    out[key] = sanitizeColor(r[key], DEFAULT_DISPLAY_COLORS[key]);
  }
  return out;
}

function sanitizeDisplaySizes(raw: unknown): DisplaySizes {
  const out = { ...DEFAULT_DISPLAY_SIZES };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplaySizes, unknown>>;
  for (const key of DISPLAY_SIZE_KEYS) {
    const v = Number(r[key]);
    if (Number.isFinite(v) && v >= 1 && v <= 144) {
      out[key] = Math.round(v * 2) / 2; // half-point precision
    }
  }
  return out;
}

function sanitizeReaders(raw: unknown): ReaderConfig[] {
  if (!Array.isArray(raw)) return [...DEFAULTS.readers];
  const out: ReaderConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const name = String((r as ReaderConfig).name ?? '').trim();
    const wpm = Number((r as ReaderConfig).wpm);
    if (!name || !Number.isFinite(wpm) || wpm <= 0) continue;
    out.push({ name, wpm: Math.round(wpm) });
  }
  return out.length > 0 ? out : [...DEFAULTS.readers];
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Singleton store. */
export const settings = new SettingsStore();
