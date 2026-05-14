/**
 * AI cite creator.
 *
 * User selects raw citation info (URL, byline, abstract, article
 * chunk — whatever they have). On invocation we send the selection
 * + today's date + the configurable system prompt to Anthropic.
 * The model returns JSON shaped like:
 *
 *   { "cite": "<formatted debate-style cite>",
 *     "tokens": ["Smith 24", ...] }
 *
 * We replace the user's selection with the cite text and apply the
 * named-style `cite_mark` to every substring listed in `tokens` —
 * those are the "Lastname ShortDate" pieces that get F8 cite
 * highlighting in the editor.
 *
 * While the request is in flight, a floating tooltip pinned near
 * the selection cycles through Clod activity text (or "Thinking…"
 * when Clod mode is off).
 */

import type { EditorView } from 'prosemirror-view';
import { schema } from '../../schema/index.js';
import { settings } from '../settings.js';
import { callAnthropic, AnthropicError } from './anthropic.js';
import {
  activitiesForNow,
  pickRandomActivity,
  personalizeActivity,
} from './clod.js';
import { getAiPersona } from '../comments-ui.js';
import { showToast } from '../toast.js';

/** Cycle interval for the in-flight tooltip's activity text. */
const ACTIVITY_TICK_MS = 4000;

/** Today's-date placeholder substituted into the prompt at run
 *  time. Putting it in the prompt rather than the user message
 *  keeps the user message tightly scoped to the raw citation
 *  text. */
const DATE_PLACEHOLDER = '{DATE}';

export const DEFAULT_AI_CITE_PROMPT = `You are a citation formatter for competitive debate. Today's date is ${DATE_PLACEHOLDER}.

The user has supplied raw citation information (URL, article text, byline, abstract — whatever they had). Format it into a single-line debate-style cite.

Standard cite shape:
  Lastname ShortYear (qualifications), "Article title," Publication, M-D-YYYY, URL, accessed M-D-YYYY.

Examples:
  Smith 24 (Professor of Political Science at UCLA), "Restraint is Inevitable," Foreign Affairs, 5-12-2024, https://example.com/restraint, accessed ${DATE_PLACEHOLDER}.
  Smith & Jones 23 (researchers at Brookings), "...", ..., 6-1-2023, ..., accessed ${DATE_PLACEHOLDER}.
  Brown et al. 22 (multi-author team at RAND), ..., 9-9-2022, ..., accessed ${DATE_PLACEHOLDER}.

Rules:
  - Author "short token" is "Lastname ShortYear" for one author, "Lastname & Lastname ShortYear" for two, "Lastname et al. ShortYear" for three or more. ShortYear is the 2-digit publication year.
  - The short token appears at the start of the cite (before the qualifications paren).
  - The qualifications are a compact noun-phrase descriptor — title + institution. Don't include the author's first name unless needed for disambiguation.
  - Use today's date for the "accessed" portion.
  - If the publication date is unknown, use the page's modification or scrape date and note "[no date]" inside the cite. The short token should use the year you used in the date.

Respond with VALID JSON ONLY (no prose around it), shape:
{
  "cite": "<the full formatted single-line cite>",
  "tokens": ["<the short token(s) verbatim, exactly as they appear in 'cite'>"]
}

Each entry in "tokens" must be a substring of "cite" so the editor can find it. Don't include any other commentary in the JSON.`;

export interface AiCiteResult {
  cite: string;
  tokens: string[];
}

/** Format today's date as M-D-YYYY, matching the cite convention. */
function formatToday(now: Date = new Date()): string {
  return `${now.getMonth() + 1}-${now.getDate()}-${now.getFullYear()}`;
}

/** Replace the prompt's {DATE} placeholders. */
export function resolveCitePrompt(template: string, now: Date = new Date()): string {
  const today = formatToday(now);
  return template.split(DATE_PLACEHOLDER).join(today);
}

/** Parse the model's JSON reply. Throws on any shape we can't
 *  use. Strips a leading ```json fence if the model adds one. */
export function parseCiteResponse(text: string): AiCiteResult {
  let body = text.trim();
  // Some models like to wrap JSON in ```json fences even when asked
  // not to. Peel them off if present.
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    body = body.trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Couldn't parse cite JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Cite response was not a JSON object.');
  }
  const obj = parsed as { cite?: unknown; tokens?: unknown };
  if (typeof obj.cite !== 'string' || !obj.cite.trim()) {
    throw new Error('Cite response missing "cite" string field.');
  }
  if (!Array.isArray(obj.tokens)) {
    throw new Error('Cite response missing "tokens" array.');
  }
  const tokens: string[] = [];
  for (const t of obj.tokens) {
    if (typeof t === 'string' && t.trim()) tokens.push(t);
  }
  return { cite: obj.cite, tokens };
}

/** Apply the cite to the editor: replace [from, to] with `cite`
 *  text, then add `cite_mark` to each token substring that
 *  appears within the inserted range. Returns false when the
 *  cite_mark type isn't in the schema (defensive — it always is). */
export function applyCiteToSelection(
  view: EditorView,
  from: number,
  to: number,
  result: AiCiteResult,
): boolean {
  const citeType = schema.marks['cite_mark'];
  if (!citeType) return false;

  // Replace the selection with the cite text. `insertText` keeps
  // any existing block boundaries intact and produces plain text
  // nodes. The inserted span runs from `from` to `from + cite.length`
  // — positions inside a single textblock are 1:1 with character
  // offsets, which is what we use to find token substrings below.
  const tr = view.state.tr;
  tr.insertText(result.cite, from, to);

  const start = from;
  const end = from + result.cite.length;
  for (const token of result.tokens) {
    if (!token) continue;
    let searchOffset = 0;
    while (searchOffset <= result.cite.length - token.length) {
      const idx = result.cite.indexOf(token, searchOffset);
      if (idx < 0) break;
      const matchStart = start + idx;
      const matchEnd = matchStart + token.length;
      if (matchEnd > end) break;
      tr.addMark(matchStart, matchEnd, citeType.create());
      searchOffset = idx + token.length;
    }
  }
  view.dispatch(tr);
  return true;
}

// --------------------------- tooltip ----------------------------

/** Floating in-flight indicator pinned near the cursor. Used
 *  instead of the side-panel placeholder because the cite creator
 *  doesn't open a comment thread. Shows a single line of text
 *  that cycles through Clod activities when Clod mode is on, or
 *  reads "Thinking…" otherwise. */
class CiteTooltip {
  private el: HTMLDivElement | null = null;
  private ticker: number | null = null;

  show(anchor: { left: number; top: number; bottom: number }): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'pmd-ai-cite-tooltip';
    // Position absolute to the page so we don't depend on a
    // particular ancestor's positioning. `coordsAtPos` returns
    // viewport coords, so add scroll offsets.
    const top = anchor.bottom + window.scrollY + 6;
    const left = anchor.left + window.scrollX;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.textContent = this.currentText();
    document.body.appendChild(el);
    this.el = el;

    this.ticker = window.setInterval(() => {
      if (this.el) this.el.textContent = this.currentText();
    }, ACTIVITY_TICK_MS);
  }

  hide(): void {
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  private currentText(): string {
    if (!settings.get('clodEnabled')) return 'Thinking…';
    const pool = activitiesForNow({
      customByTime: settings.get('clodActivitiesByTime'),
      ranges: settings.get('clodTimePeriods'),
    });
    return personalizeActivity(pickRandomActivity(pool), getAiPersona());
  }
}

let activeTooltip: CiteTooltip | null = null;

// --------------------------- command ----------------------------

/** Entry point — fires on `aiCreateCite` ribbon command. Reads
 *  the current selection, kicks off the API call, shows the
 *  in-flight tooltip, and on resolve replaces the selection
 *  with the formatted + marked cite. No-op when AI features are
 *  off, the key isn't set, or the selection is empty. */
export function runAiCreateCite(view: EditorView): void {
  if (!settings.get('aiFeaturesEnabled')) {
    showToast('AI features are disabled — enable them in Settings.');
    return;
  }
  const apiKey = settings.get('anthropicApiKey').trim();
  if (!apiKey) {
    showToast('Set an Anthropic API key in Settings to use AI features.');
    return;
  }
  const { state } = view;
  const sel = state.selection;
  if (sel.empty) {
    showToast('Select some citation info first.');
    return;
  }
  const raw = state.doc.textBetween(sel.from, sel.to, '\n', '\n').trim();
  if (!raw) {
    showToast('Selection has no text to format.');
    return;
  }

  const promptTemplate = settings.get('aiCitePrompt').trim() || DEFAULT_AI_CITE_PROMPT;
  const systemPrompt = resolveCitePrompt(promptTemplate);

  // Pin the tooltip below the selection's start coords.
  if (activeTooltip) activeTooltip.hide();
  activeTooltip = new CiteTooltip();
  try {
    const coords = view.coordsAtPos(sel.from);
    activeTooltip.show({ left: coords.left, top: coords.top, bottom: coords.bottom });
  } catch {
    // Fall back to top-of-viewport if coordsAtPos fails.
    activeTooltip.show({ left: 16, top: 16, bottom: 32 });
  }

  // Capture the bounds NOW; if the user edits during the request
  // the original selection might shift, but we want to replace
  // what they originally selected.
  const fromAtRequest = sel.from;
  const toAtRequest = sel.to;

  void (async () => {
    try {
      const reply = await callAnthropic({
        apiKey,
        system: systemPrompt,
        messages: [{ role: 'user', content: raw }],
      });
      const parsed = parseCiteResponse(reply.text);
      // Apply against the live view. If the user has somehow
      // deleted the range while the request was in flight, the
      // mark application step inside applyCiteToSelection will
      // throw — the catch below surfaces it as a toast.
      applyCiteToSelection(view, fromAtRequest, toAtRequest, parsed);
    } catch (e) {
      if (e instanceof AnthropicError) {
        showToast(`Cite: ${e.message}`);
      } else {
        showToast(`Cite: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (activeTooltip) {
        activeTooltip.hide();
        activeTooltip = null;
      }
    }
  })();
}
