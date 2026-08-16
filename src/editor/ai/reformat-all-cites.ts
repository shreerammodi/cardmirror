/**
 * Reformat Every Cite (AI) — the whole-document sweep built on top of
 * the single-selection cite creator (`cite-creator.ts`).
 *
 * Every `cite_paragraph` in the doc is fed to the same prompt, the same
 * parser and the same transaction builder the `aiCreateCite` command
 * uses. Nothing about the per-cite behaviour is re-implemented here;
 * this module is the *driver*:
 *
 *   - **Confirm first.** One model request per cite means real money, so
 *     the pass never starts without an explicit OK that states the
 *     request count.
 *   - **Concurrent, bounded.** Cites are independent requests over
 *     disjoint ranges, so the pass keeps `MAX_IN_FLIGHT` of them in the
 *     air instead of paying one round trip per cite in series. It is
 *     bounded rather than "all of them at once" on purpose:
 *     `callLlm` gives a 429 exactly ONE retry and treats a
 *     `retry-after` above 8s as a hard failure, so firing a
 *     hundred-cite document at a provider whose limit is dozens per
 *     minute would convert a slow pass into a mostly-failed one, at
 *     full token cost. A small pool captures nearly all the speedup
 *     with none of that.
 *   - **Slow start.** The first cite goes alone; the pool only opens
 *     once one comes back clean. A dead key, a retired model or an
 *     exhausted quota therefore still costs exactly ONE request instead
 *     of a pool's worth (`FAILURE_STREAK_LIMIT` covers the same ground
 *     for failures that only show up later).
 *   - **A lease per cite, claimed up front.** The lease is what tracks a
 *     cite's position: leases remap through every intervening
 *     transaction, so a cite's range is still right after the user
 *     edited above it, after a *sibling* cite's rewrite changed length,
 *     and whatever order the replies land in. Out-of-order completion is
 *     exactly what a document cursor cannot survive, which is why the
 *     pass no longer walks one. The cost is real and deliberate: while
 *     the pass runs, every cite line is locked against typing and each
 *     user transaction remaps N lease positions in `coordinatorBlocks`
 *     — cheap per lease, and now over a run that is a fraction as long.
 *     Body text stays editable throughout.
 *   - **One transaction per cite.** Partial progress survives a failure
 *     mid-pass, and a bad cite can be undone on its own. The flip side
 *     (N undo steps) is called out in the confirm text.
 *   - **Escape stops it.** The pass stops dispatching; the requests
 *     already in flight still land.
 *   - **One pill, N tints.** The cues split by granularity: a single
 *     `ThinkingTooltip` narrates the pass's progress, and one
 *     `AiWorkingBox` per in-flight cite marks what is being worked on.
 *     `AiActivity` pairs one pill with one range, which no longer fits.
 *   - **One pass per pane.** A second invocation over the same document
 *     is refused explicitly (`runningPasses`) — with a lease over every
 *     cite it would find nothing to claim anyway, but it must not get as
 *     far as a second confirm. Another pane is another document, and
 *     runs freely.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { settings } from '../settings.js';
import { callLlm, LlmError, activeApiKey } from './llm.js';
import { ThinkingTooltip } from './thinking-tooltip.js';
import { AiWorkingBox } from './ai-working-box.js';
import { claimRegion, type EditLease } from './edit-coordinator.js';
import { showConfirm } from '../confirm-dialog.js';
import { isAnyOverlayOpen } from '../overlay-stack.js';
import { showToast } from '../toast.js';
import {
  DEFAULT_AI_CITE_PROMPT,
  CITE_TOKENS_MARKED_META,
  buildCiteTransaction,
  parseCiteResponse,
  resolveCitePrompt,
} from './cite-creator.js';

/** One cite paragraph to reformat. `from`/`to` bound its INLINE content
 *  (not the node), so the range handed to the cite builder is exactly
 *  what a user selection over the paragraph's text would be — no
 *  adjacent content, hence no own-paragraph split on apply. */
export interface CiteTarget {
  /** Position of the `cite_paragraph` node itself. */
  pos: number;
  from: number;
  to: number;
  /** The paragraph's text, trimmed. Empty for a blank cite line. */
  text: string;
}

function targetFor(node: PMNode, pos: number): CiteTarget {
  return {
    pos,
    from: pos + 1,
    to: pos + node.nodeSize - 1,
    text: node.textContent.trim(),
  };
}

/** Every non-empty `cite_paragraph` in the doc, in document order. Blank
 *  cite lines are dropped: there is nothing to reformat, and counting
 *  them would inflate the authorized request count. */
export function collectCiteParagraphs(doc: PMNode): CiteTarget[] {
  const out: CiteTarget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'cite_paragraph') return true;
    const t = targetFor(node, pos);
    if (t.text) out.push(t);
    // Cite paragraphs are textblocks — nothing inside to visit.
    return false;
  });
  return out;
}

/** Outcome tallies, so the summary toast can be honest about what
 *  happened across a long run. Exported for the tests. */
export interface ReformatAllCitesSummary {
  /** Cites rewritten in the doc. */
  done: number;
  /** Cites whose request or apply failed (each logged to the console). */
  failed: number;
  /** Cites skipped because another AI edit held the range. */
  skipped: number;
  /** Rewritten cites whose author/date token found no home, so the
   *  paragraph carries no `cite_mark` and reads as body text. */
  unstyled: number;
  /** Whether the user stopped the pass with Escape. */
  cancelled: boolean;
  /** Whether the pass gave up after `FAILURE_STREAK_LIMIT` failures in a
   *  row — a dead key or an exhausted quota fails identically on every
   *  remaining cite, so grinding through hundreds of them helps nobody. */
  halted: boolean;
  /** Whether cites appeared after the confirm (pasted in mid-run) and
   *  were left alone: the pass makes at most the number of requests the
   *  user authorized. */
  cappedOut: boolean;
}

/** Requests in the air at once once the pass is up to speed. Sized for
 *  the provider, not the document: Anthropic's entry tier allows dozens
 *  of requests a minute, and `callLlm` retries a 429 exactly once, so a
 *  pool this size stays comfortably inside the limit while cutting a
 *  hundred-cite pass from a hundred round trips to about seventeen. */
const MAX_IN_FLIGHT = 6;

/** Consecutive failures that end a pass. Two is within the noise of a
 *  flaky connection (each request has already burned its own internal
 *  retry); three in a row means the run is not going to recover.
 *  "In a row" is by completion order — with a pool in flight that is the
 *  order replies land, which is the order the failures are observed. */
const FAILURE_STREAK_LIMIT = 3;

function summaryMessage(s: ReformatAllCitesSummary, total: number): string {
  const parts = [`Reformatted ${s.done} of ${total} cite${total === 1 ? '' : 's'}`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.skipped) parts.push(`${s.skipped} skipped (busy)`);
  if (s.unstyled) parts.push(`${s.unstyled} left unstyled — F8 the author/date`);
  if (s.halted) parts.push('stopped after repeated failures');
  if (s.cappedOut) parts.push('cites added during the run were left alone');
  if (s.cancelled) parts.push('stopped');
  return parts.join(' · ') + '.';
}

/** Is this keystroke the running pane's business? True when the event —
 *  or, failing that, wherever focus currently sits — is inside this
 *  view's editor DOM. */
function ownsKey(view: EditorView, target: EventTarget | null): boolean {
  const within = (n: unknown): boolean => n instanceof Node && view.dom.contains(n);
  return within(target) || within(document.activeElement);
}

/** Escape-to-stop, installed only while a pass runs. Stands down while a
 *  modal is open so it can't swallow a dialog's own Escape.
 *
 *  Scoping: a lone pass answers to any Escape, wherever focus is — the
 *  reach it has always had. Once a second pane is also running, each
 *  pass takes only the keystrokes belonging to its own pane, so stopping
 *  one never stops the other. (Both handlers sit on `window`, and
 *  `stopPropagation` does not stop listeners on the same node, so
 *  without this check a single Escape would cancel every pass at once.) */
function installCancelKey(view: EditorView, onCancel: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || isAnyOverlayOpen()) return;
    if (runningPasses.size > 1 && !ownsKey(view, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// --------------------------- command ----------------------------

/** Panes with a pass in flight. Serves two purposes: refusing a second
 *  pass over a document already being swept, and telling `installCancelKey`
 *  whether Escape has to be scoped.
 *
 *  Per pane rather than app-wide because panes hold distinct documents —
 *  the shell focuses an already-open file instead of loading it into a
 *  second slot — so two passes in two panes are two different documents'
 *  cites, and refusing the second would be an arbitrary restriction. What
 *  must not happen is two passes over the SAME document, which would send
 *  (and bill) every cite twice. Windows need no coordination at all: each
 *  is its own renderer, hence its own copy of this module. */
const runningPasses = new Set<EditorView>();

/** Entry point — fires on the `reformatAllCites` ribbon command. The
 *  returned promise settles when the whole pass is done (the ribbon hook
 *  voids it; the tests await it). */
export async function runReformatAllCites(view: EditorView): Promise<void> {
  if (runningPasses.has(view)) {
    showToast('A cite reformat pass is already running in this document.');
    return;
  }
  runningPasses.add(view);
  try {
    if (!settings.get('aiFeaturesEnabled')) {
      showToast('AI features are disabled — enable them in Settings.');
      return;
    }
    const apiKey = activeApiKey();
    if (!apiKey) {
      showToast('Set an API key in Settings to use AI features.');
      return;
    }
    const total = collectCiteParagraphs(view.state.doc).length;
    if (total === 0) {
      showToast('No cites in this document.');
      return;
    }

    const systemPrompt = resolveCitePrompt(
      settings.get('aiCitePrompt').trim() || DEFAULT_AI_CITE_PROMPT,
    );

    // The confirm is inside the guard: the dialog is the longest window
    // in which a second invocation could land, and two stacked confirms
    // would each start a pass.
    const ok = await showConfirm({
      title: 'Reformat every cite with AI?',
      message:
        `${total} cite${total === 1 ? '' : 's'} in this document will be sent to the AI ` +
        `and rewritten in place, up to ${MAX_IN_FLIGHT} at a time.\n\n` +
        `That is ${total} model request${total === 1 ? '' : 's'}, so it costs ${total} ` +
        `call${total === 1 ? '' : 's'} against your API key. ` +
        `Each cite is its own undo step, and Escape stops the pass.`,
      confirmLabel: `Reformat ${total} cite${total === 1 ? '' : 's'}`,
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await reformatAllCites(view, apiKey, systemPrompt, total);
  } finally {
    runningPasses.delete(view);
  }
}

/** One cite the pass has claimed and will send. */
interface CiteJob {
  target: CiteTarget;
  /** Live bounds of this cite for the whole run — see the module note on
   *  why positions come from a lease and not a cursor. */
  lease: EditLease;
  /** 1-based ordinal over claimed cites, for the console log lines. */
  n: number;
}

async function reformatAllCites(
  view: EditorView,
  apiKey: string,
  systemPrompt: string,
  total: number,
): Promise<void> {
  const s: ReformatAllCitesSummary = {
    done: 0,
    failed: 0,
    skipped: 0,
    unstyled: 0,
    cancelled: false,
    halted: false,
    cappedOut: false,
  };
  // Cues: ONE pill for the pass, one purple tint per cite in flight.
  // `AiActivity` deliberately isn't used here — it pairs exactly one pill
  // with exactly one range, and six pills all narrating the same pass is
  // noise. The tints already say which cites are being worked on, so the
  // pill carries the pass's progress instead.
  const tip = new ThinkingTooltip();
  let tipShown = false;
  const tints = new Map<CiteJob, AiWorkingBox>();
  const inFlight = new Set<CiteJob>();
  /** Set by an auth/model failure: the same error is waiting for every
   *  remaining cite, so stop dispatching. Not a summary field — the
   *  toast it raises already says what happened. */
  let aborted = false;

  /** Re-anchor and re-label every cue. Called on each dispatch and each
   *  completion: a rewrite moves the cites after it, so the tints of the
   *  requests still in flight need their leases re-read, not their
   *  original rects. */
  const refreshCues = (): void => {
    let anchor: { from: number; to: number } | null = null;
    for (const job of inFlight) {
      const r = job.lease.region();
      if (!r) continue;
      tints.get(job)?.setRange(r);
      // The pill tracks the topmost cite still in flight, so it walks down
      // the document with the pass instead of jumping around the pool.
      if (!anchor || r.from < anchor.from) anchor = r;
    }
    tip.setStage(
      s.cancelled
        ? 'stopping after the cites in flight'
        : `reformatting cites · ${s.done} of ${total} rewritten · Esc to stop`,
    );
    if (!anchor) return;
    if (tipShown) tip.setRange(anchor);
    else {
      tip.show(view, anchor);
      tipShown = true;
    }
  };

  const removeCancelKey = installCancelKey(view, () => {
    if (s.cancelled) return;
    s.cancelled = true;
    refreshCues();
  });

  // Re-scan rather than reusing the list the confirm was counted from:
  // the dialog is an await, and a collab partner's edit during it would
  // leave every cached position stale. Capped at the authorized count —
  // cites that appeared in the meantime are none of this pass's
  // business, since billing past the number the user agreed to is worse
  // than leaving them for a second run.
  const fresh = collectCiteParagraphs(view.state.doc);
  if (fresh.length > total) s.cappedOut = true;

  // Claim every cite before sending any of them. The lease both reserves
  // the range against other AI edits and, from here on, IS the cite's
  // position: replies land out of order and each rewrite shifts the
  // cites after it.
  const jobs: CiteJob[] = [];
  for (const target of fresh.slice(0, total)) {
    const lease = claimRegion(view, { from: target.from, to: target.to }, { label: 'cite' });
    if (!lease) {
      s.skipped++;
      continue;
    }
    jobs.push({ target, lease, n: jobs.length + 1 });
  }

  /** Next unclaimed job. Bumped before the await, so no two workers can
   *  take the same cite. */
  let next = 0;
  /** Failures since the last success — see FAILURE_STREAK_LIMIT. */
  let streak = 0;
  const stopped = (): boolean => s.cancelled || s.halted || aborted;

  const runJob = async (job: CiteJob): Promise<void> => {
    const { lease, n } = job;
    const at = lease.region();
    if (!at) {
      console.warn(`[cite-all] cite ${n}: range no longer in the document`);
      s.failed++;
      streak++;
      return;
    }
    const tint = new AiWorkingBox();
    tint.show(view, at);
    tints.set(job, tint);
    inFlight.add(job);
    refreshCues();
    try {
      const reply = await callLlm({
        apiKey,
        system: systemPrompt,
        messages: [{ role: 'user', content: job.target.text }],
      });
      const parsed = parseCiteResponse(reply.text);
      // Apply at the lease's CURRENT bounds — a sibling cite's rewrite
      // or a user edit above this one has shifted them.
      const region = lease.region();
      if (!region) {
        console.warn(`[cite-all] cite ${n}: range no longer in the document`);
        s.failed++;
        streak++;
        return;
      }
      // `buildCiteTransaction` rather than `applyCiteToSelection`: the
      // latter toasts per unstyled cite, which across a whole document
      // is a toast storm. Tally instead and report once at the end.
      const tr = buildCiteTransaction(view.state, region.from, region.to, parsed);
      if (!tr) {
        s.failed++;
        streak++;
        return;
      }
      lease.apply(tr);
      if (parsed.tokens.length > 0 && tr.getMeta(CITE_TOKENS_MARKED_META) === 0) s.unstyled++;
      s.done++;
      streak = 0;
    } catch (e) {
      const msg = e instanceof LlmError ? e.message : e instanceof Error ? e.message : String(e);
      console.warn(`[cite-all] cite ${n} failed: ${msg}`);
      s.failed++;
      streak++;
      // Auth / model / config failures repeat on every remaining cite;
      // stop rather than burning the whole document down on them.
      if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'model')) {
        showToast(`Reformat cites: ${msg}`);
        aborted = true;
      }
    } finally {
      inFlight.delete(job);
      tints.delete(job);
      tint.hide();
      refreshCues();
    }
  };

  /** One worker, draining the queue until it empties, the pass stops, or
   *  `until` says this worker's job is done (the slow-start case). */
  const worker = async (until?: () => boolean): Promise<void> => {
    for (;;) {
      // Checked here so every failure path reaches it: a key, quota or
      // endpoint that is simply not working fails the same way on every
      // remaining cite, so stop once that is clear rather than walking
      // the whole document to prove it.
      if (streak >= FAILURE_STREAK_LIMIT) s.halted = true;
      if (stopped() || until?.()) return;
      const job = jobs[next];
      if (!job) return;
      next++;
      await runJob(job);
    }
  };

  try {
    // Slow start: one cite at a time until one comes back clean, so a
    // pass that cannot work at all costs a single request. A failure
    // does NOT open the pool — that is the whole point.
    await worker(() => s.done > 0);
    const pool = Math.min(MAX_IN_FLIGHT, jobs.length - next);
    if (!stopped() && pool > 0) {
      await Promise.all(Array.from({ length: pool }, () => worker()));
    }
  } finally {
    removeCancelKey();
    tip.hide();
    for (const t of tints.values()) t.hide();
    tints.clear();
    inFlight.clear();
    // A cite sitting after everything we claimed was pasted in mid-run
    // (the leases are still live here, so this reads real positions, not
    // the pre-run ones). Cites added ABOVE the pass are not detected —
    // they aren't billed either way, and the summary is a courtesy.
    let anchor = -1;
    for (const j of jobs) {
      const r = j.lease.region();
      if (r) anchor = Math.max(anchor, r.to);
    }
    if (anchor >= 0 && collectCiteParagraphs(view.state.doc).some((t) => t.pos >= anchor)) {
      s.cappedOut = true;
    }
    for (const j of jobs) j.lease.release();
  }

  showToast(summaryMessage(s, total), { durationMs: 5000 });
}
