/**
 * Build the context payload for the AI explainer flow.
 *
 * Walk up from the selection's `$from` position looking for the
 * innermost container (card or analytic_unit). If we find one, the
 * payload includes its tag / analytic / cite_paragraphs alongside
 * the selected text. If the selection lives at doc level, the
 * payload is selection-only — the AI just sees the text the user
 * asked about, with no surrounding card context.
 */

import type { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

export interface ExplainContext {
  /** The text the user selected (may span multiple paragraphs;
   *  paragraph breaks collapse to '\n'). */
  selection: string;
  /** Full text of every paragraph-like textblock the selection
   *  intersects, in document order. Gives the AI the surrounding
   *  prose even when the user only highlighted a fragment. */
  paragraphs: string[];
  /** Verbatim text of the containing card's tag, if any. */
  tag: string | null;
  /** Verbatim text of an in-card analytic paragraph or the
   *  analytic_unit's header analytic, if any. */
  analytic: string | null;
  /** All cite paragraphs in the containing container, in document
   *  order. Concatenated and shown to the model as a single block. */
  cites: string[];
}

/** Compute the explainer payload for the editor's current selection.
 *  Returns `null` when the selection is empty — callers should
 *  refuse to fire an AI request in that case. */
export function buildExplainContext(state: EditorState): ExplainContext | null {
  const { from, to } = state.selection;
  if (from === to) return null;

  const selection = state.doc.textBetween(from, to, '\n', '\n').trim();
  if (!selection) return null;

  // Walk depth ancestors from innermost outward looking for
  // a card or analytic_unit. We use $from rather than $to —
  // an unusual selection that straddles container boundaries
  // doesn't really fit the explainer flow; we take the
  // container of the start point and trust the AI to handle the
  // rest from the included selection text.
  const $pos = state.doc.resolve(from);
  let container: PMNode | null = null;
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'card' || node.type.name === 'analytic_unit') {
      container = node;
      break;
    }
  }

  // Collect the full text of every paragraph-like textblock the
  // selection intersects. This gives the model the surrounding
  // prose even when the user only highlighted a phrase. Skip
  // empty / whitespace-only paragraphs so noise doesn't pile up.
  const paragraphs: string[] = [];
  const seen = new Set<string>();
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) {
      const t = node.textContent.trim();
      if (t && !seen.has(t)) {
        paragraphs.push(t);
        seen.add(t);
      }
      return false;
    }
    return true;
  });

  if (!container) {
    return { selection, paragraphs, tag: null, analytic: null, cites: [] };
  }

  let tag: string | null = null;
  let analytic: string | null = null;
  const cites: string[] = [];
  container.forEach((child) => {
    if (child.type.name === 'tag' && tag === null) {
      tag = child.textContent.trim() || null;
    } else if (child.type.name === 'analytic' && analytic === null) {
      analytic = child.textContent.trim() || null;
    } else if (child.type.name === 'cite_paragraph') {
      const t = child.textContent.trim();
      if (t) cites.push(t);
    }
  });
  return { selection, paragraphs, tag, analytic, cites };
}

/** Format the context into a single user-message string. The shape
 *  is plain text rather than JSON so the model sees a natural
 *  narrative; the AI's reply will be plain prose that can land
 *  directly into a comment body. */
export function formatExplainPrompt(
  question: string,
  ctx: ExplainContext,
): string {
  const parts: string[] = [];
  parts.push(`Question: ${question.trim()}`);
  parts.push('');
  parts.push('Selected text:');
  parts.push('"""');
  parts.push(ctx.selection);
  parts.push('"""');
  // Include the full paragraph(s) the selection sits inside so the
  // model sees its broader context, even if the user only
  // highlighted a fragment.
  if (ctx.paragraphs.length > 0) {
    parts.push('');
    parts.push('Source paragraph(s):');
    for (const p of ctx.paragraphs) {
      parts.push('"""');
      parts.push(p);
      parts.push('"""');
    }
  }
  if (ctx.tag || ctx.analytic || ctx.cites.length > 0) {
    parts.push('');
    parts.push('Surrounding context (from the card this selection is part of):');
    if (ctx.tag) parts.push(`Tag: ${ctx.tag}`);
    if (ctx.analytic) parts.push(`Analytic: ${ctx.analytic}`);
    for (const cite of ctx.cites) parts.push(`Cite: ${cite}`);
  }
  return parts.join('\n');
}

/** Default system prompt for the AI explainer.
 *
 * Pedagogical stance: rather than answering the substantive question
 * outright, give the user background and situate the question within
 * the relevant literature — what field handles it, who the central
 * authors / schools are, where the question sits in the conversation.
 * The user does the further research on their own (this is a study
 * tool, not an oracle).
 */
export const EXPLAIN_SYSTEM_PROMPT =
  "You are a research coach embedded in a competitive-debate document editor. " +
  "A user has selected a passage from a debate card and asked a question about it. " +
  "Use the surrounding context (tag, analytic, cite) to interpret the selection.\n\n" +
  "Default to 3–4 sentences of plain prose. Don't aim to answer the question directly " +
  "— prioritize giving the user enough background to situate the question within the " +
  "relevant literature: what field handles this, who the central authors or schools of " +
  "thought are, and which concepts / debates / theoretical frames matter. Recommend " +
  "AUTHORS and CONCEPTS the user can look up; do NOT recommend specific texts (book " +
  "titles, article titles, journal issues). The user will find the right sources " +
  "themselves once they have the names and the vocabulary.\n\n" +
  "For follow-up replies in an ongoing thread, be much terser. Up to four sentences, " +
  "but go shorter if the question can be answered in one or two. Don't repeat context " +
  "the user has already seen.\n\n" +
  "Exception — translation requests: if the user asks you to translate the selection " +
  "(or part of it) into another language, just return the translation. No background, " +
  "no commentary, no scaffolding — translation only.\n\n" +
  "Reply in plain text only — no markdown, no bullet lists, no headings. The comment " +
  "surface renders raw text; any formatting characters will appear literally.";

/** Matches an `@AI` mention anywhere in a reply, case-insensitive,
 *  bounded by non-word chars or string ends. Used by the comments
 *  UI to decide whether a reply submission also fires an AI request. */
const AI_MENTION_RE = /(^|[^A-Za-z0-9])@AI(?![A-Za-z0-9])/i;

export function hasAiMention(text: string): boolean {
  return AI_MENTION_RE.test(text);
}
