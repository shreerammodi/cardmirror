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

const STORAGE_KEY = 'pmd-settings';

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
  /** Whether to show the cite preview on hover in the nav pane. */
  showCitePreview: boolean;
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
   * Global line-height multiplier (unitless). Mirrors Verbatim's
   * Spacing setting (Wide=1.4ish, Narrow=1.15ish). Range 1.0–2.0.
   */
  lineHeight: number;
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
}

export type HeadingMode = 'strict' | 'respect' | 'demolish';
const HEADING_MODES: HeadingMode[] = ['strict', 'respect', 'demolish'];

export type FormattingPanelMode = 'labels' | 'shortcuts' | 'both' | 'hidden';
const FORMATTING_PANEL_MODES: FormattingPanelMode[] = ['labels', 'shortcuts', 'both', 'hidden'];

const DEFAULTS: Settings = {
  navWidth: 300,
  navMaxLevel: 3,
  showCitePreview: true,
  readMode: false,
  hideEmphasisBordersInReadMode: false,
  zoomPct: 100,
  readers: [
    { name: 'Reader 1', wpm: 200 },
    { name: 'Reader 2', wpm: 250 },
  ],
  displaySizes: { ...DEFAULT_DISPLAY_SIZES },
  displayTypography: { ...DEFAULT_DISPLAY_TYPOGRAPHY },
  displayColors: { ...DEFAULT_DISPLAY_COLORS },
  bodyFont: 'Calibri',
  lineHeight: 1.2,
  formattingPanelMode: 'labels',
  formattingPanelPreview: true,
  lastHighlightColor: 'yellow',
  lastShadingColor: 'C0C0C0',
  lastFontColor: null,
  paragraphIntegrity: true,
  usePilcrows: false,
  headingMode: 'respect',
  condenseOnPaste: false,
};

/**
 * Human-readable metadata for each setting, used by the settings UI.
 * Add new entries when introducing new settings.
 */
export interface SettingMeta {
  key: keyof Settings;
  label: string;
  description?: string;
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
    | 'lineHeight'
    | 'formattingPanelMode'
    | 'headingMode';
}

export const SETTING_METADATA: SettingMeta[] = [
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover. Some users find this useful; others find it busy.',
    kind: 'toggle',
  },
  {
    key: 'hideEmphasisBordersInReadMode',
    label: 'Hide all emphasis borders in read mode',
    description:
      'By default, emphasis borders are removed only when the emphasized text is hidden (so empty boxes don’t appear next to highlighted content). Turn this on to strip every emphasis border in read mode, including around highlighted text.',
    kind: 'toggle',
  },
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate. The first two are displayed live in the bottom bar; all show up in the Word Count Selection dialog. Add as many as you need.',
    kind: 'readers',
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here. Verbatim's defaults: Pocket 26, Hat 22, Block 16, Tag 13, Cite 13, Underline 11, Emphasis 11.",
    kind: 'displaySizes',
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    description:
      'Bold / italic / underline / box decorations for the named styles, plus the box thickness for Emphasis. Mirrors Verbatim\'s Styles tab toggles.',
    kind: 'displayTypography',
  },
  {
    key: 'displayColors',
    label: 'Style colors',
    description:
      'Pick the color used for Analytic and Undertag text. Defaults match Verbatim\'s canonical hues. These propagate to both the editor and the navigation pane.',
    kind: 'displayColors',
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      "Font family for body text. Pick the font your team's docs use — Calibri matches Verbatim's default.",
    kind: 'bodyFont',
  },
  {
    key: 'formattingPanelMode',
    label: 'Formatting panel',
    description:
      'How the Pocket / Hat / Block / Tag / Analytic buttons in the ribbon are displayed. "Labels" shows the style name, "Shortcuts" shows the keyboard binding, "Both" shows name · shortcut, "Hidden" removes the panel.',
    kind: 'formattingPanelMode',
  },
  {
    key: 'formattingPanelPreview',
    label: 'Preview styles in formatting panel',
    description:
      'When on, formatting-panel buttons preview the visual treatment of the style they apply (Pocket boxed, Hat double-underlined, Tag bold, Analytic colored). Applies to both Labels and Shortcuts modes.',
    kind: 'toggle',
  },
  {
    key: 'paragraphIntegrity',
    label: 'F3 condense: preserve paragraph integrity',
    description:
      'When on (default), F3 only cleans intra-paragraph whitespace — paragraphs stay separate. When off, F3 merges consecutive collapsible paragraphs (card_body and doc-level paragraphs) into one. Also toggleable from the ribbon\'s ¶ button.',
    kind: 'toggle',
  },
  {
    key: 'usePilcrows',
    label: 'F3 condense: use pilcrow markers',
    description:
      'Only consulted when paragraph integrity is off. When on, F3 inserts a 6-pt ¶ at each original paragraph boundary in the merged result, so the split can be reversed via Ctrl+Alt+Shift+F3 (Uncondense). Off by default.',
    kind: 'toggle',
  },
  {
    key: 'condenseOnPaste',
    label: 'Condense after Paste Text (F2)',
    description:
      'When on, F2 (Paste Text) runs the default condense pass immediately after pasting. Useful if you almost always paste long blobs that need to be tightened. Off by default — matches Verbatim. The condense it runs is the same one F3 invokes (respects Paragraph Integrity, Use Pilcrows, and the heading-handling setting).',
    kind: 'toggle',
  },
  {
    key: 'headingMode',
    label: 'Condense: heading handling',
    description:
      'How selection-based condense (Alt-F3 / Mod-Alt-F3 / F3 when integrity is off) treats structural elements (headings, cite paragraphs, undertags) inside the selection. "Strict" no-ops when the selection touches structural elements — safest. "Respect" (default) keeps structural elements as their own paragraphs and merges only the body runs between them. "Demolish" treats the selection as sovereign — everything merges into one textblock; cards / analytic_units whose head was touched dissolve and their body slots absorb into the receiving container.',
    kind: 'headingMode',
  },
  // Note: `lineHeight` is wired through (defaults to 1.2, applied to
  // #editor via --pmd-line-height) but isn't exposed in the settings
  // UI — the configurable version had a known interaction bug. Once
  // that's fixed, add a `kind: 'lineHeight'` metadata entry here to
  // surface it.
];

type Listener = (s: Readonly<Settings>) => void;

export class SettingsStore {
  private values: Settings;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.values = this.load();
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.persist();
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
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
    showCitePreview: !!s.showCitePreview,
    readMode: !!s.readMode,
    hideEmphasisBordersInReadMode: !!s.hideEmphasisBordersInReadMode,
    zoomPct: clamp(Math.round(s.zoomPct / 10) * 10, 50, 200),
    readers: sanitizeReaders(s.readers),
    displaySizes: sanitizeDisplaySizes(s.displaySizes),
    displayTypography: sanitizeDisplayTypography(s.displayTypography),
    displayColors: sanitizeDisplayColors(s.displayColors),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    lineHeight: clamp(
      Number.isFinite(s.lineHeight) ? Math.round(s.lineHeight * 20) / 20 : 1.2,
      1.0,
      2.0,
    ),
    formattingPanelMode: FORMATTING_PANEL_MODES.includes(s.formattingPanelMode as FormattingPanelMode)
      ? (s.formattingPanelMode as FormattingPanelMode)
      : DEFAULTS.formattingPanelMode,
    formattingPanelPreview:
      s.formattingPanelPreview === undefined
        ? DEFAULTS.formattingPanelPreview
        : !!s.formattingPanelPreview,
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
  };
}

function sanitizeBodyFont(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULTS.bodyFont;
  // Strip any quotes or commas — bodyFont must be a single font-family
  // name. A previous iteration accepted free-form input, so a stale
  // persisted value might contain `"Calibri", sans-serif` or similar.
  const cleaned = raw.replace(/["',]/g, '').trim();
  return cleaned || DEFAULTS.bodyFont;
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
