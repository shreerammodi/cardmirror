/**
 * Card-cutter PORT — the only place the app talks to the experimental
 * card-cutting engine. The engine itself lives in the separately-
 * versioned `@cardmirror/card-cutter` package and is NOT bundled. It
 * registers with us at runtime via `window.__registerCardCutter`; if
 * nothing registers (package absent), the feature stays inert.
 *
 * Responsibilities, all app-side:
 *  - hold whatever engine registered (registry),
 *  - inject an LlmCaller wrapping the app's browser-direct callLlm,
 *  - extract tag / cite / body text from the focused card,
 *  - translate the engine's returned mark spans into ONE ProseMirror
 *    transaction (underline / emphasis / highlight), with the highlight
 *    color resolved per the doc/ribbon rule.
 *
 * The engine is pure (no DOM, no PM, no network of its own), so the
 * boundary is: app gives it text + an llm, it returns spans.
 */

import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { settings } from './settings.js';
import { compileShrinkProtections, findProtectedRanges } from './ribbon-commands.js';
import { callLlm, activeApiKey } from './ai/llm.js';
import { resolveAiModel } from './ai/llm.js';
import { showToast } from './toast.js';
import { AiActivity } from './ai/ai-activity.js';
import { claimRegion, type EditLease } from './ai/edit-coordinator.js';
import { setCardCutterPreview } from './card-cutter-preview-plugin.js';
import { getElectronHost } from './host/index.js';

// ─── Engine contract (structural — no import of the package) ──────

type Layer = 'u' | 'em' | 'hl';
interface MarkSpan {
  layer: Layer;
  p: number;
  start: number;
  end: number;
}
interface PlainCard {
  id: string;
  doc: string;
  section: string;
  tag: string;
  cite: string;
  paras: string[];
}
type CutStage =
  | 'initial'
  | 'highlight'
  | 'prune'
  | 'skeletonize'
  | 'budget'
  | 'add'
  | 'tighten';
interface CutOptions {
  /** Optional de-highlight cap; the primary cut is budget-free. */
  targetWords?: number;
  emphasisStyle: 'voice' | 'independent' | 'minimal';
  role: 'shell' | 'block' | 'at' | 'ext' | 'impact';
  underlineGenerosity?: 'lean' | 'standard' | 'generous';
  model?: string;
  terminalImpact?: boolean;
  onStage?: (stage: CutStage) => void;
}

/** Stage → gerund phrase shown in the pill ("…", or "Clod is …"). */
const STAGE_LABEL: Record<CutStage, string> = {
  initial: 'making the first pass',
  highlight: 'highlighting',
  prune: 'pruning for redundancy',
  skeletonize: 'skeletonizing',
  budget: 'highlighting down',
  add: 'adding highlighting',
  tighten: 'tightening',
};
interface BudgetShortfall {
  targetWords: number;
  words: number;
  reason?: string;
}
interface CutResult {
  spans: MarkSpan[];
  stats: unknown;
  readWords?: number;
  shortfall?: BudgetShortfall;
  warnings: string[];
  raw: unknown;
}
type LlmCaller = (system: string, user: string, model: string) => Promise<string>;
/** A contiguous, optional slice of the read the user can drop — counts
 *  are engine-counted (deterministic), not model estimates. */
export interface OmissionSection {
  id: number;
  label: string;
  description: string;
  words: number;
  spans: MarkSpan[];
}
interface CardCutterApi {
  readonly version: string;
  cutCard(card: PlainCard, opts: CutOptions, llm: LlmCaller): Promise<CutResult>;
  highlightCard(
    card: PlainCard,
    seed: MarkSpan[],
    opts: CutOptions,
    llm: LlmCaller,
  ): Promise<CutResult>;
  proposeOmissions(
    card: PlainCard,
    map: MarkMap,
    llm: LlmCaller,
    model?: string,
  ): Promise<OmissionSection[]>;
  highlightDown(
    card: PlainCard,
    map: MarkMap,
    targetWords: number,
    llm: LlmCaller,
    model?: string,
    onStage?: (stage: CutStage) => void,
    feedback?: string,
  ): Promise<{ map: MarkMap; words: number; raw: string; shortfall?: BudgetShortfall }>;
  refineHighlight(
    card: PlainCard,
    map: MarkMap,
    opts: {
      dropRedundancy?: boolean;
      skeletonize?: boolean;
      targetWords?: number;
      feedback?: string;
      allowAdd?: boolean;
      model?: string;
      onStage?: (stage: CutStage) => void;
    },
    llm: LlmCaller,
  ): Promise<{ map: MarkMap; words: number; warnings: string[]; shortfall?: BudgetShortfall }>;
  addHighlight(
    card: PlainCard,
    existing: MarkSpan[],
    opts: CutOptions,
    llm: LlmCaller,
    scope?: { p: number; start: number; end: number }[],
  ): Promise<CutResult>;
  detectTerminalImpact(tag: string): boolean;
}

interface MarkMap {
  u: Uint8Array[];
  em: Uint8Array[];
  hl: Uint8Array[];
}

declare global {
  interface Window {
    __registerCardCutter?: (api: CardCutterApi) => void;
    /** Console entry point (see card-cutter-gate.ts). */
    __cardcutter?: (cmd: 'on' | 'off' | 'status') => string;
  }
}

let engine: CardCutterApi | null = null;

/** The engine package calls this on load (dev-only). Installed once. */
export function installCardCutterRegistry(): void {
  window.__registerCardCutter = (api) => {
    engine = api;
    console.log(`[cardcutter] engine registered (v${api.version})`);
  };
}

export function cardCutterEngineLoaded(): boolean {
  return engine !== null;
}

/** Dev convenience: pull the sibling package in so it can register.
 *  `@vite-ignore` keeps the bundler from resolving the specifier at
 *  build time, so production (where the sibling isn't present) builds
 *  fine and the import simply throws at runtime → caught, feature
 *  stays inert. The `@cardcutter` alias resolves only in dev. */
export async function tryLoadCardCutterEngine(): Promise<boolean> {
  if (engine) return true;
  try {
    // Resolved by the vite `@cardcutter/browser` alias: the sibling
    // package in dev, or the in-repo no-op stub when it's absent.
    // Side-effect import only — registration happens via the global.
    await import('@cardcutter/browser');
  } catch (err) {
    console.warn('[cardcutter] sibling import unavailable:', (err as Error).message);
  }
  // Packaged builds ship the no-op stub, so the import above registers
  // nothing. When the feature is switched on, load the user-installed
  // engine bundle from disk (userData/plugins, an explicit settings
  // path, or the CARDCUTTER_ENGINE env). The bundle self-registers.
  if (!engine && settings.get('cardCutterEnabled')) {
    const host = getElectronHost();
    if (host?.cardCutterLoad) {
      try {
        const r = await host.cardCutterLoad(settings.get('cardCutterEnginePath') || null);
        if (r.ok) console.log(`[cardcutter] engine loaded from ${r.path}`);
        else console.warn(`[cardcutter] engine plugin not loaded: ${r.error}`);
      } catch (err) {
        console.warn('[cardcutter] engine plugin load error:', (err as Error).message);
      }
    }
  }
  return engine !== null;
}

// ─── LLM injection ────────────────────────────────────────────────

// The engine hands this caller bare Anthropic model ids (`claude-…`), which
// OpenRouter rejects (it needs the `anthropic/…` prefix) — so the card cutter
// works only with the Anthropic provider. Model selection here must become
// provider-aware before the card cutter can run over OpenRouter.
function makeLlm(): LlmCaller {
  return async (system, user, model) => {
    const reply = await callLlm({
      apiKey: activeApiKey(),
      model,
      system,
      maxTokens: 8000,
      temperature: model.includes('opus') ? undefined : 0,
      messages: [{ role: 'user', content: user }],
    });
    if (reply.stopReason === 'max_tokens') throw new Error('truncated at max_tokens');
    return reply.text;
  };
}

// ─── Card extraction from the editor ──────────────────────────────

export interface FocusedCard {
  card: PlainCard;
  cardFrom: number;
  /** End of the card node (cardFrom + nodeSize) — the AI-working tint
   *  spans [cardFrom, cardTo] so the whole card shows as worked-on. */
  cardTo: number;
  /** Doc positions of each body paragraph's content start (= text
   *  offset 0), parallel to card.paras, for span → doc-pos mapping. */
  paraStarts: number[];
  /** The card body's EXISTING marks as engine-shaped spans (char
   *  ranges per body paragraph). Lets the port tell a plain card
   *  (full cut) from an underlined one (highlight only). */
  existing: MarkSpan[];
}

/** Whether the card already has any underline/emphasis, and any
 *  highlight — drives cut vs highlight vs done routing. */
function cardState(f: FocusedCard): { hasUnderline: boolean; hasHighlight: boolean } {
  let hasUnderline = false;
  let hasHighlight = false;
  for (const s of f.existing) {
    if (s.layer === 'hl') hasHighlight = true;
    else hasUnderline = true;
  }
  return { hasUnderline, hasHighlight };
}

/** Delimiter-protected spans — bracketed Omitted / ALT TEXT / FOOTNOTE
 *  markers, "Condense with warning" PAUSES/RESUMES, translator attributions,
 *  and the user's custom protections — must never be sent to the cutter: the
 *  highlight it returns is read aloud, and only text from the original article
 *  may be read. Same pattern set Shrink uses, applied unconditionally (this is
 *  independent of the shrink-keeps-protected setting). */
function cardCutterProtectionPatterns(): readonly RegExp[] {
  return compileShrinkProtections(
    settings.get('shrinkCustomProtections'),
    settings.get('condenseWarningDelimiter') === 'custom'
      ? settings.get('condenseWarningCustomPauseMarker')
      : '',
    settings.get('condenseWarningDelimiter') === 'custom'
      ? settings.get('condenseWarningCustomResumeMarker')
      : '',
  );
}

/** Blank every character of `text` whose doc position falls in a protected
 *  range, replacing it with a space. Keeping the length identical preserves
 *  the 1:1 text-offset ↔ doc-position mapping the rest of the port relies on;
 *  the cutter highlights words, so a blanked (whitespace) span is never
 *  selected, and the engine's whitespace-split word count skips it too. */
function maskProtected(
  text: string,
  contentStart: number,
  protectedRanges: readonly { from: number; to: number }[],
): string {
  if (protectedRanges.length === 0 || text.length === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const docPos = contentStart + i;
    const masked = protectedRanges.some((r) => docPos >= r.from && docPos < r.to);
    out += masked ? ' ' : text[i];
  }
  return out;
}

/** Find the card containing the cursor and pull its tag / cite / plain
 *  body text, with delimiter-protected spans blanked out. Returns null if
 *  the cursor isn't in a card or the body is empty. */
export function focusedPlainCard(view: EditorView): FocusedCard | null {
  const { $from } = view.state.selection;
  let cardPos = -1;
  let cardNode: PMNode | null = null;
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
      cardPos = $from.before(d);
      cardNode = n;
      break;
    }
  }
  if (!cardNode || cardPos < 0) return null;

  // Blank delimiter-protected spans from everything sent to the engine so
  // protected spans can't be read aloud. Scan PER child paragraph: scanning
  // the whole card at once concatenates tag/cite/body with no separators, so
  // an opening delimiter in one (e.g. the tag's `[TRANSLATION…]`) could pair
  // with a keyword in another and over-mask across them.
  const protectionPatterns = cardCutterProtectionPatterns();
  const maskChild = (child: PMNode, childPos: number): string =>
    maskProtected(
      child.textContent,
      childPos + 1,
      findProtectedRanges(
        view.state.doc,
        [{ from: childPos, to: childPos + child.nodeSize }],
        protectionPatterns,
      ),
    );

  let tag = '';
  let cite = '';
  const paras: string[] = [];
  const paraStarts: number[] = [];
  const existing: MarkSpan[] = [];
  cardNode.forEach((child, offset) => {
    const t = child.type.name;
    const childPos = cardPos + 1 + offset; // position of child node
    if (t === 'tag' || t === 'analytic') {
      tag += maskChild(child, childPos);
    } else if (t === 'cite_paragraph') {
      cite += (cite ? '\n' : '') + maskChild(child, childPos);
    } else if (child.isTextblock) {
      const p = paras.length;
      // Read existing body marks into char-range spans, tracking the
      // text offset as we walk the inline runs.
      let textOff = 0;
      child.forEach((inline) => {
        if (!inline.isText || !inline.text) return;
        const start = textOff;
        const end = textOff + inline.text.length;
        for (const m of inline.marks) {
          const name = m.type.name;
          if (name === 'underline_mark' || name === 'underline_direct')
            existing.push({ layer: 'u', p, start, end });
          else if (name === 'emphasis_mark') existing.push({ layer: 'em', p, start, end });
          else if (name === 'highlight') existing.push({ layer: 'hl', p, start, end });
        }
        textOff = end;
      });
      paras.push(maskChild(child, childPos));
      paraStarts.push(childPos + 1); // +1 into the textblock's content
    }
  });
  if (paras.length === 0) return null;

  return {
    card: {
      id: 'live',
      doc: '',
      section: '',
      tag: tag.trim(),
      cite: cite.trim(),
      paras,
    },
    cardFrom: cardPos,
    cardTo: cardPos + cardNode.nodeSize,
    paraStarts,
    existing,
  };
}

// ─── Highlight color resolution (doc convention, else ribbon) ─────

/** If every highlighted run in the document uses the same color, that
 *  is the doc convention; if the doc mixes colors or has none, fall
 *  back to the ribbon-selected highlight color. */
function resolveHighlightColor(view: EditorView): string {
  const seen = new Set<string>();
  view.state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === 'highlight') seen.add(String(m.attrs['color'] ?? 'yellow'));
    }
    return true;
  });
  if (seen.size === 1) return [...seen][0]!;
  return settings.get('lastHighlightColor') || 'yellow';
}

// ─── Apply: MarkSpan[] → one transaction ──────────────────────────

const LAYER_MARK: Record<Layer, string> = {
  u: 'underline_mark',
  em: 'emphasis_mark',
  hl: 'highlight',
};

export function applyCutToCard(
  view: EditorView,
  focused: FocusedCard,
  spans: MarkSpan[],
  layers?: Layer[],
  dispatch: (tr: Transaction) => void = (tr) => view.dispatch(tr),
): void {
  const tr = view.state.tr;
  const color = resolveHighlightColor(view);
  for (const s of spans) {
    if (layers && !layers.includes(s.layer)) continue;
    const base = focused.paraStarts[s.p];
    if (base === undefined) continue;
    const from = base + s.start;
    const to = base + s.end;
    if (to <= from) continue;
    const markName = LAYER_MARK[s.layer];
    const type = schema.marks[markName];
    if (!type) continue;
    tr.addMark(from, to, s.layer === 'hl' ? type.create({ color }) : type.create());
  }
  if (!tr.docChanged && tr.steps.length === 0) return;
  // Park the selection at the top of the card so the result is visible.
  tr.setSelection(TextSelection.create(tr.doc, focused.cardFrom + 1));
  dispatch(tr.scrollIntoView());
}

/** Shift a focused card's doc positions by `delta` — used after the
 *  coordinator lease reports the card moved (an edit elsewhere in the doc
 *  shifted it during the model call). Marks are position-stable inside the
 *  leased card, so one uniform delta re-anchors every position. */
function shiftFocused(focused: FocusedCard, delta: number): FocusedCard {
  if (delta === 0) return focused;
  return {
    ...focused,
    cardFrom: focused.cardFrom + delta,
    cardTo: focused.cardTo + delta,
    paraStarts: focused.paraStarts.map((p) => p + delta),
  };
}

/** Claim a coordinator lease over the focused card for the duration of an
 *  async card-cutter op. Returns null (with a toast) if another AI edit
 *  already holds this card. */
function claimCardLease(view: EditorView, focused: FocusedCard, label: string): EditLease | null {
  const lease = claimRegion(view, { from: focused.cardFrom, to: focused.cardTo }, { label });
  if (!lease) {
    showToast('Another AI edit is working on this card — try again in a moment.');
  }
  return lease;
}

// ─── The one public entry the command layer calls ─────────────────

export interface CutInvocation {
  role: CutOptions['role'];
  /** Optional read-time CAP in seconds. The cut is always made
   *  efficiently first; when set, a secondary de-highlight trims it
   *  toward this length (never pads up to it). Omit = no cap. */
  readTimeSec?: number;
}

/** What a completed cut leaves the UI to work with: the card handle
 *  (positions stay valid — applying marks doesn't move text), the
 *  engine MarkMap of the applied result (for proposeOmissions), the
 *  exact read length, and any budget shortfall. */
export interface CutSession {
  focused: FocusedCard;
  map: MarkMap;
  readWords: number;
  shortfall?: BudgetShortfall;
}

export async function cutFocusedCard(
  view: EditorView,
  inv: CutInvocation,
): Promise<CutSession | null> {
  if (!engine) {
    const ok = await tryLoadCardCutterEngine();
    if (!ok) {
      showToast('Card-cutter engine not loaded.');
      return null;
    }
  }
  const api = engine!;
  if (!activeApiKey()) {
    showToast('Set an API key in Settings to use the card cutter.');
    return null;
  }
  const focused = focusedPlainCard(view);
  if (!focused) {
    showToast('Put the cursor in a card with body text first.');
    return null;
  }
  const { hasUnderline, hasHighlight } = cardState(focused);
  // Already highlighted → done; don't clobber a finished cut. (Highlight
  // Down shrinks it.)
  if (hasHighlight) {
    showToast('This card is already highlighted.');
    return null;
  }
  const opts: CutOptions = {
    // Efficient by default; a read-time cap becomes the secondary
    // de-highlight target. No cap → undefined → pure efficient cut.
    ...(inv.readTimeSec
      ? { targetWords: Math.max(15, Math.round((inv.readTimeSec * readerWpm()) / 60)) }
      : {}),
    emphasisStyle: settings.get('cardCutterEmphasisStyle'),
    role: inv.role,
    model: resolveAiModel(),
    terminalImpact: api.detectTerminalImpact(focused.card.tag),
  };
  // Lease the card so the cut lands on it even if the doc shifts during
  // the model call, and user edits to the card are held meanwhile.
  const lease = claimCardLease(view, focused, 'card-cut');
  if (!lease) return null;
  // Pill + purple tint over the whole card while the model works.
  const activity = new AiActivity(view, { from: focused.cardFrom, to: focused.cardTo });
  activity.start();
  opts.onStage = (s) => activity.setStage(STAGE_LABEL[s]);
  const llm = makeLlm();
  try {
    // Underlined-but-not-highlighted → Highlight Card (trust the
    // existing underlines, add only highlights). Plain → full Cut.
    const result = hasUnderline
      ? await api.highlightCard(focused.card, focused.existing, opts, llm)
      : await api.cutCard(focused.card, opts, llm);
    // Re-anchor to the card's current position (edits elsewhere may have
    // shifted it). Null delta → the card was removed mid-cut.
    const delta = lease.delta();
    if (delta === null) {
      showToast('The card moved while cutting — cut not applied.');
      return null;
    }
    const placed = shiftFocused(focused, delta);
    applyCutToCard(view, placed, result.spans, hasUnderline ? ['hl'] : undefined, (tr) => lease.apply(tr));
    for (const w of result.warnings) console.log(`[cardcutter] ${w}`);
    showToast(hasUnderline ? 'Card highlighted — ↶ to undo' : 'Card cut — ↶ to undo');
    return {
      focused: placed,
      map: cardMapAfter(placed, result.spans),
      readWords: result.readWords ?? 0,
      ...(result.shortfall ? { shortfall: result.shortfall } : {}),
    };
  } catch (err) {
    console.error('[cardcutter] cut failed:', err);
    showToast(`Card cut failed: ${(err as Error).message}`);
    return null;
  } finally {
    activity.stop();
    lease.release();
  }
}

/** The engine MarkMap of the card after applying `spans` on top of its
 *  existing marks — what proposeOmissions / section toggles read. */
function cardMapAfter(focused: FocusedCard, spans: MarkSpan[]): MarkMap {
  const map = buildMarkMap(focused);
  for (const s of spans) {
    const arr = map[s.layer][s.p];
    if (!arr) continue;
    for (let i = s.start; i < s.end && i < arr.length; i++) arr[i] = 1;
  }
  return map;
}

/** First reader's WPM, or a sane default. */
function readerWpm(): number {
  const readers = settings.get('readers');
  return readers[0]?.wpm && readers[0].wpm > 0 ? readers[0].wpm : 350;
}

/** Whether the cursor is in a cuttable card, and its mark state — for
 *  the launch sheet to label cut vs highlight vs already-done. */
export function focusedCardStatus(
  view: EditorView,
): { cuttable: boolean; hasUnderline: boolean; hasHighlight: boolean } {
  const f = focusedPlainCard(view);
  if (!f) return { cuttable: false, hasUnderline: false, hasHighlight: false };
  return { cuttable: true, ...cardState(f) };
}

/** After an efficient cut, ask the engine to nominate optional sections
 *  the user could drop (with exact, engine-counted word savings). Empty
 *  on failure or when little is optional. */
export async function proposeFocusedOmissions(
  session: CutSession,
): Promise<OmissionSection[]> {
  if (!engine) return [];
  try {
    return await engine.proposeOmissions(
      session.focused.card,
      session.map,
      makeLlm(),
      resolveAiModel(),
    );
  } catch (err) {
    console.warn('[cardcutter] proposeOmissions failed:', (err as Error).message);
    return [];
  }
}

/** Toggle a nominated section: remove its highlight (omit) or restore
 *  it (un-omit). Underline/emphasis untouched. Positions come from the
 *  card handle, valid because applying marks never moves text. */
export function setSectionOmitted(
  view: EditorView,
  session: CutSession,
  section: OmissionSection,
  omit: boolean,
): void {
  const hlType = schema.marks['highlight'];
  if (!hlType) return;
  const tr = view.state.tr;
  const color = omit ? '' : resolveHighlightColor(view);
  for (const s of section.spans) {
    const base = session.focused.paraStarts[s.p];
    if (base === undefined) continue;
    const from = base + s.start;
    const to = base + s.end;
    if (to <= from) continue;
    if (omit) tr.removeMark(from, to, hlType);
    else tr.addMark(from, to, hlType.create({ color }));
  }
  if (tr.steps.length > 0) view.dispatch(tr);
}

/** Hover preview for the trim checklist: box the highlighted words a
 *  section's checkbox would affect (purple boxes hugging each run), or
 *  clear with `null`. Positions are valid because applying marks never
 *  moves text. */
export function previewOmissionSection(
  view: EditorView,
  session: CutSession,
  section: OmissionSection | null,
): void {
  if (!section) {
    setCardCutterPreview(view, null);
    return;
  }
  const ranges: { from: number; to: number }[] = [];
  for (const s of section.spans) {
    const base = session.focused.paraStarts[s.p];
    if (base === undefined) continue;
    const from = base + s.start;
    const to = base + s.end;
    if (to > from) ranges.push({ from, to });
  }
  setCardCutterPreview(view, ranges);
}

export async function ensureEngine(): Promise<boolean> {
  if (engine) return true;
  return tryLoadCardCutterEngine();
}

// ─── Highlight Down ───────────────────────────────────────────────

/** Build the engine's MarkMap from a focused card's existing marks. */
function buildMarkMap(focused: FocusedCard): MarkMap {
  const map: MarkMap = {
    u: focused.card.paras.map((p) => new Uint8Array(p.length)),
    em: focused.card.paras.map((p) => new Uint8Array(p.length)),
    hl: focused.card.paras.map((p) => new Uint8Array(p.length)),
  };
  for (const s of focused.existing) {
    const arr = map[s.layer][s.p];
    if (!arr) continue;
    for (let i = s.start; i < s.end && i < arr.length; i++) arr[i] = 1;
  }
  return map;
}

/** Apply the highlight DIFF between the original card and a refined map:
 *  remove highlight where it was dropped, add it where it was added (the
 *  refine "allow adding" path; adds are always within existing underline,
 *  so no new underline is needed). Surviving runs keep their color. */
function applyHlDiff(
  view: EditorView,
  focused: FocusedCard,
  original: MarkMap,
  result: MarkMap,
  dispatch: (tr: Transaction) => void = (tr) => view.dispatch(tr),
): void {
  const tr = view.state.tr;
  const hlType = schema.marks['highlight'];
  if (!hlType) return;
  const color = resolveHighlightColor(view);
  for (let p = 0; p < focused.paraStarts.length; p++) {
    const base = focused.paraStarts[p]!;
    const orig = original.hl[p]!;
    const res = result.hl[p]!;
    let i = 0;
    while (i < orig.length) {
      if (orig[i] && !res[i]) {
        const start = i;
        while (i < orig.length && orig[i] && !res[i]) i++;
        tr.removeMark(base + start, base + i, hlType);
      } else i++;
    }
    i = 0;
    while (i < res.length) {
      if (res[i] && !orig[i]) {
        const start = i;
        while (i < res.length && res[i] && !orig[i]) i++;
        tr.addMark(base + start, base + i, hlType.create({ color }));
      } else i++;
    }
  }
  if (tr.steps.length > 0) dispatch(tr.scrollIntoView());
}

/** Options for the dehighlight skill — every field optional and
 *  composable; `readTimeSec` is a length cap, the rest are toggles. */
export interface RefineInvocation {
  dropRedundancy?: boolean;
  skeletonize?: boolean;
  readTimeSec?: number;
  feedback?: string;
  /** Permit refine to ADD highlight (within underline), not just remove. */
  allowAdd?: boolean;
}

/** Refine (dehighlight) the focused card per the chosen combination of
 *  drop-redundancy / skeletonize / target-length / guidance. Removes
 *  highlight only (underline/emphasis untouched). */
export async function refineHighlightFocusedCard(
  view: EditorView,
  inv: RefineInvocation,
): Promise<void> {
  if (!(await ensureEngine())) {
    showToast('Card-cutter engine not loaded.');
    return;
  }
  if (!activeApiKey()) {
    showToast('Set an API key in Settings to use the card cutter.');
    return;
  }
  const feedback = inv.feedback?.trim() || undefined;
  if (!inv.dropRedundancy && !inv.skeletonize && !inv.readTimeSec && !feedback) {
    showToast('Pick a target or a setting, or type some guidance.');
    return;
  }
  const focused = focusedPlainCard(view);
  if (!focused) {
    showToast('Put the cursor in a card first.');
    return;
  }
  if (!cardState(focused).hasHighlight) {
    showToast('This card has no highlights to refine.');
    return;
  }
  const targetWords = inv.readTimeSec
    ? Math.max(10, Math.round((inv.readTimeSec * readerWpm()) / 60))
    : undefined;
  const original = buildMarkMap(focused);
  const lease = claimCardLease(view, focused, 'card-refine');
  if (!lease) return;
  const activity = new AiActivity(view, { from: focused.cardFrom, to: focused.cardTo });
  activity.start();
  try {
    const result = await engine!.refineHighlight(
      focused.card,
      original,
      {
        ...(inv.dropRedundancy ? { dropRedundancy: true } : {}),
        ...(inv.skeletonize ? { skeletonize: true } : {}),
        ...(targetWords ? { targetWords } : {}),
        ...(feedback ? { feedback } : {}),
        ...(inv.allowAdd ? { allowAdd: true } : {}),
        model: resolveAiModel(),
        onStage: (s) => activity.setStage(STAGE_LABEL[s]),
      },
      makeLlm(),
    );
    const delta = lease.delta();
    if (delta === null) {
      showToast('The card moved while refining — refine not applied.');
      return;
    }
    applyHlDiff(view, shiftFocused(focused, delta), original, result.map, (tr) => lease.apply(tr));
    for (const w of result.warnings) console.log(`[cardcutter] ${w}`);
    const sec = Math.round((result.words / readerWpm()) * 60);
    if (result.shortfall && inv.readTimeSec) {
      showToast(
        `Refined to ${result.words}w · ~${sec}s — couldn't reach ${inv.readTimeSec}s` +
          (result.shortfall.reason ? ` without dropping ${result.shortfall.reason}` : '') +
          '. ↶ to undo',
      );
    } else {
      showToast(`Refined to ${result.words}w · ~${sec}s — ↶ to undo`);
    }
  } catch (err) {
    console.error('[cardcutter] refine failed:', err);
    showToast(`Refine failed: ${(err as Error).message}`);
  } finally {
    activity.stop();
    lease.release();
  }
}

// ─── Add Highlight ────────────────────────────────────────────────

/** The current selection mapped to body-paragraph char ranges, or null
 *  if the selection is empty or covers the whole card (→ whole-card). */
function selectionScope(
  view: EditorView,
  focused: FocusedCard,
): { p: number; start: number; end: number }[] | null {
  const { from, to } = view.state.selection;
  if (to <= from) return null;
  const ranges: { p: number; start: number; end: number }[] = [];
  let coversAll = true;
  for (let p = 0; p < focused.card.paras.length; p++) {
    const base = focused.paraStarts[p]!;
    const len = focused.card.paras[p]!.length;
    const s = Math.max(from, base) - base;
    const e = Math.min(to, base + len) - base;
    if (e > s) ranges.push({ p, start: s, end: e });
    if (s > 0 || e < len) coversAll = false;
  }
  // Empty intersection, or the selection spans the whole body → no scope.
  if (ranges.length === 0 || coversAll) return null;
  return ranges;
}

/** Whether a usable sub-selection exists inside the focused card (drives
 *  the hotkey's add-highlight-vs-shorten routing). */
export function hasCardSubSelection(view: EditorView): boolean {
  const f = focusedPlainCard(view);
  return !!f && selectionScope(view, f) !== null;
}

/** Add Highlight — extend the read within the user's selection (or the
 *  whole card if none), highlighting tag-relevant material that isn't
 *  already read. Adds marks only; never removes. */
export async function addHighlightFocusedCard(view: EditorView): Promise<void> {
  if (!(await ensureEngine())) {
    showToast('Card-cutter engine not loaded.');
    return;
  }
  if (!activeApiKey()) {
    showToast('Set an API key in Settings to use the card cutter.');
    return;
  }
  const focused = focusedPlainCard(view);
  if (!focused) {
    showToast('Put the cursor in a card first.');
    return;
  }
  const scope = selectionScope(view, focused) ?? undefined;
  const opts: CutOptions = {
    emphasisStyle: settings.get('cardCutterEmphasisStyle'),
    role: 'block',
    model: resolveAiModel(),
  };
  const lease = claimCardLease(view, focused, 'card-add-highlight');
  if (!lease) return;
  const activity = new AiActivity(view, { from: focused.cardFrom, to: focused.cardTo });
  activity.start();
  opts.onStage = (s) => activity.setStage(STAGE_LABEL[s]);
  try {
    const result = await engine!.addHighlight(focused.card, focused.existing, opts, makeLlm(), scope);
    if (result.spans.length === 0) {
      showToast(scope ? 'Nothing tag-relevant to add in the selection.' : 'Nothing more to add.');
      return;
    }
    const shift = lease.delta();
    if (shift === null) {
      showToast('The card moved while adding highlight — not applied.');
      return;
    }
    const placed = shiftFocused(focused, shift);
    // Add the delta marks (u + hl) without moving the selection.
    const tr = view.state.tr;
    const color = resolveHighlightColor(view);
    for (const s of result.spans) {
      const base = placed.paraStarts[s.p];
      if (base === undefined) continue;
      const from = base + s.start;
      const to = base + s.end;
      if (to <= from) continue;
      const type = schema.marks[LAYER_MARK[s.layer]];
      if (!type) continue;
      tr.addMark(from, to, s.layer === 'hl' ? type.create({ color }) : type.create());
    }
    for (const w of result.warnings) console.log(`[cardcutter] ${w}`);
    if (tr.steps.length > 0) lease.apply(tr.scrollIntoView());
    showToast('Highlight added — ↶ to undo');
  } catch (err) {
    console.error('[cardcutter] add-highlight failed:', err);
    showToast(`Add highlight failed: ${(err as Error).message}`);
  } finally {
    activity.stop();
    lease.release();
  }
}
