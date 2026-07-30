/**
 * Reformat Every Cite (AI) — the whole-document sweep built on top of
 * the single-selection cite creator (`cite-creator.ts`).
 *
 * Every `cite_paragraph` in the doc is fed to the same prompt, the same
 * parser and the same transaction builder the `aiCreateCite` command
 * uses, one paragraph at a time. Nothing about the per-cite behaviour is
 * re-implemented here; this module is the *driver*:
 *
 *   - **Confirm first.** One model request per cite means real money and
 *     real minutes, so the pass never starts without an explicit OK that
 *     states the request count.
 *   - **Sequential, one lease at a time.** A lease per in-flight cite
 *     (never all of them at once): a whole-doc lease would lock the user
 *     out of typing for the entire run, and holding N leases would make
 *     every keystroke run N region-diffs in `coordinatorBlocks`.
 *   - **Re-scan between cites instead of caching positions.** The pass
 *     walks forward with a document cursor and asks the *live* doc for
 *     the next cite each iteration. That survives user edits elsewhere,
 *     the length change of the cite we just rewrote, and the case where
 *     a rewritten paragraph loses its `cite_mark` and gets demoted out
 *     of `cite_paragraph` by the classifier — all of which would
 *     invalidate a precomputed position list or an ordinal index.
 *   - **One transaction per cite.** Partial progress survives a failure
 *     mid-pass, and a bad cite can be undone on its own. The flip side
 *     (N undo steps) is called out in the confirm text.
 *   - **Escape stops it.** The pass checks a cancel flag between cites;
 *     the request already in flight still lands.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { settings } from '../settings.js';
import { callLlm, LlmError, activeApiKey } from './llm.js';
import { AiActivity } from './ai-activity.js';
import { claimRegion } from './edit-coordinator.js';
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

/** Every non-empty `cite_paragraph` in the doc, in document order. Used
 *  for the up-front count in the confirm prompt; the pass itself
 *  re-scans as it goes (see `nextCiteParagraph`). */
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

/** The first `cite_paragraph` at or after `cursor`, read from the LIVE
 *  doc. The pass advances `cursor` past each paragraph it handles, and a
 *  handled paragraph always starts strictly before the new cursor, so
 *  this never returns the same paragraph twice — including when the
 *  rewritten cite is longer or shorter than the original. */
export function nextCiteParagraph(doc: PMNode, cursor: number): CiteTarget | null {
  let found: CiteTarget | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== 'cite_paragraph') return true;
    if (pos >= cursor) found = targetFor(node, pos);
    return false;
  });
  return found;
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
}

function summaryMessage(s: ReformatAllCitesSummary, total: number): string {
  const parts = [`Reformatted ${s.done} of ${total} cite${total === 1 ? '' : 's'}`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.skipped) parts.push(`${s.skipped} skipped (busy)`);
  if (s.unstyled) parts.push(`${s.unstyled} left unstyled — F8 the author/date`);
  if (s.cancelled) parts.push('stopped');
  return parts.join(' · ') + '.';
}

/** Escape-to-stop, installed only while a pass runs. Stands down while a
 *  modal is open so it can't swallow a dialog's own Escape. */
function installCancelKey(onCancel: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || isAnyOverlayOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// --------------------------- command ----------------------------

/** Entry point — fires on the `reformatAllCites` ribbon command. The
 *  returned promise settles when the whole pass is done (the ribbon hook
 *  voids it; the tests await it). */
export async function runReformatAllCites(view: EditorView): Promise<void> {
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

  const ok = await showConfirm({
    title: 'Reformat every cite with AI?',
    message:
      `${total} cite${total === 1 ? '' : 's'} in this document will be sent to the AI ` +
      `one at a time and rewritten in place.\n\n` +
      `That is ${total} model request${total === 1 ? '' : 's'}, so it costs ${total} ` +
      `call${total === 1 ? '' : 's'} against your API key and can take a while. ` +
      `Each cite is its own undo step, and Escape stops the pass.`,
    confirmLabel: `Reformat ${total} cite${total === 1 ? '' : 's'}`,
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  await reformatAllCites(view, apiKey, systemPrompt, total);
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
  };
  let activity: AiActivity | null = null;
  const removeCancelKey = installCancelKey(() => {
    if (s.cancelled) return;
    s.cancelled = true;
    activity?.setStage('Stopping after this cite…');
  });
  let cursor = 0;

  try {
    for (let n = 1; !s.cancelled; n++) {
      const target = nextCiteParagraph(view.state.doc, cursor);
      if (!target) break;
      // Advance past this paragraph BEFORE any await: a `continue` from
      // here must not re-find it. Corrected to the post-edit end once
      // the rewrite lands.
      cursor = target.to;
      if (!target.text) continue;

      const lease = claimRegion(view, { from: target.from, to: target.to }, { label: 'cite' });
      if (!lease) {
        s.skipped++;
        continue;
      }
      try {
        const range = { from: target.from, to: target.to };
        if (activity) activity.setRange(range);
        else {
          activity = new AiActivity(view, range, 'selection');
          activity.start();
        }
        activity.setStage(`Cite ${n} of ${total} · Esc to stop`);

        const reply = await callLlm({
          apiKey,
          system: systemPrompt,
          messages: [{ role: 'user', content: target.text }],
        });
        const parsed = parseCiteResponse(reply.text);
        // Apply at the lease's CURRENT bounds — user edits elsewhere in
        // the doc during the request have shifted them.
        const region = lease.region();
        if (!region) {
          console.warn(`[cite-all] cite ${n}: range no longer in the document`);
          s.failed++;
          continue;
        }
        // `buildCiteTransaction` rather than `applyCiteToSelection`: the
        // latter toasts per unstyled cite, which across a whole document
        // is a toast storm. Tally instead and report once at the end.
        const tr = buildCiteTransaction(view.state, region.from, region.to, parsed);
        if (!tr) {
          s.failed++;
          continue;
        }
        lease.apply(tr);
        if (parsed.tokens.length > 0 && tr.getMeta(CITE_TOKENS_MARKED_META) === 0) s.unstyled++;
        s.done++;
        const after = lease.region();
        if (after) cursor = after.to;
      } catch (e) {
        const msg = e instanceof LlmError ? e.message : e instanceof Error ? e.message : String(e);
        console.warn(`[cite-all] cite ${n} failed: ${msg}`);
        s.failed++;
        // Auth / model / config failures repeat on every remaining cite;
        // stop rather than burning the whole document down on them.
        if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'model')) {
          showToast(`Reformat cites: ${msg}`);
          break;
        }
      } finally {
        lease.release();
      }
    }
  } finally {
    removeCancelKey();
    activity?.stop();
  }

  showToast(summaryMessage(s, total), { durationMs: 5000 });
}
