/**
 * Comments side-column UI.
 *
 * Owns the right-side panel that shows comment threads as cards.
 * Subscribes to the comments plugin state (and to the live PM doc
 * for thread→range lookups) and rebuilds the panel on change.
 *
 * Per-thread card shape:
 *   - Header: author + initials badge + date.
 *   - Body: comment text (rendered as plain `<p>` per newline).
 *   - Replies (rendered the same way, indented).
 *   - Reply textarea + submit button.
 *   - "Delete thread" button on the root comment's header.
 *
 * Clicking the card scrolls the editor to the marked range and
 * keeps the card visually highlighted.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { settings } from './settings.js';
import {
  commentsKey,
  getCommentsState,
  newCommentId,
  addThreadMeta,
  addReplyMeta,
  editCommentTextMeta,
  deleteThreadMeta,
  deleteCommentMeta,
  setCommentsVisibleMeta,
  type Comment,
  type Thread,
} from './comments-plugin.js';

export class CommentsColumn {
  private readonly root: HTMLElement;
  private getView: () => EditorView | null;
  /** When a thread's textarea was last focused, we'd otherwise blow
   *  it away on every re-render. Track which thread is currently
   *  being typed-in so we re-focus + restore the text on rebuild. */
  private activeReplyThreadId: string | null = null;
  private activeReplyText = '';
  private suppressBlurReset = false;

  constructor(root: HTMLElement, getView: () => EditorView | null) {
    this.root = root;
    this.getView = getView;
  }

  /** Show/hide the entire column. The toggle button in the ribbon
   *  calls this; we also dispatch a `setCommentsVisibleMeta` so
   *  the plugin state reflects the same value (useful for any
   *  consumer that wants to render based on it). */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    const view = this.getView();
    if (view) {
      view.dispatch(view.state.tr.setMeta(commentsKey, setCommentsVisibleMeta(visible)));
    }
    settings.set('commentsVisible', visible);
  }

  /** Re-render the column from the current plugin state + doc.
   *  Two phases: build the cards into the DOM (positions are still
   *  default at this point), then `layoutCards` measures each card's
   *  natural height and assigns a `top` aligned with the start of
   *  its anchored range. */
  render(): void {
    const view = this.getView();
    if (!view) {
      this.root.innerHTML = '';
      this.root.classList.remove('pmd-comments-empty-state');
      this.root.style.minHeight = '';
      return;
    }
    const state = getCommentsState(view.state);
    const ranges = collectRanges(view.state.doc);

    this.root.innerHTML = '';
    if (state.threads.size === 0) {
      this.root.classList.add('pmd-comments-empty-state');
      const empty = document.createElement('div');
      empty.className = 'pmd-comments-empty';
      empty.textContent = 'No comments yet.';
      this.root.appendChild(empty);
      this.root.style.minHeight = '';
      return;
    }
    this.root.classList.remove('pmd-comments-empty-state');

    // Iterate threads in document order so the column matches the
    // top-to-bottom flow of the editor. Orphans (mark removed but
    // plugin state not yet GC'd) append at the end.
    const orderedIds = Array.from(ranges.keys()).filter((id) => state.threads.has(id));
    for (const id of state.threads.keys()) {
      if (!ranges.has(id)) orderedIds.push(id);
    }
    for (const id of orderedIds) {
      const thread = state.threads.get(id);
      if (!thread) continue;
      this.root.appendChild(this.renderThread(thread, ranges.get(id) ?? null));
    }

    // Defer measurement to the next frame so the browser has
    // committed the new card DOM and computed their natural heights.
    requestAnimationFrame(() => this.layoutCards(view, ranges));
  }

  /** Position each thread card next to its anchored range using
   *  `view.coordsAtPos`. Cards stack downward when their desired
   *  positions would overlap (greedy left-to-right packing in the
   *  one-column case). */
  private layoutCards(
    view: EditorView,
    ranges: Map<string, { from: number; to: number }>,
  ): void {
    const cards = Array.from(this.root.querySelectorAll<HTMLElement>('.pmd-comment-thread'));
    if (cards.length === 0) {
      this.root.style.minHeight = '';
      return;
    }
    const columnRect = this.root.getBoundingClientRect();
    const minGap = 8; // px between adjacent cards

    interface Layout { card: HTMLElement; desiredTop: number; height: number }
    const layouts: Layout[] = [];
    for (const card of cards) {
      const id = card.dataset['threadId'] ?? '';
      const range = ranges.get(id);
      let desiredTop = 0;
      if (range) {
        try {
          const coords = view.coordsAtPos(range.from);
          desiredTop = Math.max(0, coords.top - columnRect.top);
        } catch {
          // Range out of view / detached — leave at top.
        }
      }
      layouts.push({ card, desiredTop, height: card.offsetHeight });
    }
    layouts.sort((a, b) => a.desiredTop - b.desiredTop);

    let cursor = 0;
    for (const l of layouts) {
      const actualTop = Math.max(l.desiredTop, cursor);
      l.card.style.top = `${actualTop}px`;
      // `pmd-laid-out` flips visibility to visible — until this
      // point the card was hidden so the brief top:0 default
      // before measurement didn't flash a visible card at the top
      // of the column on every doc edit.
      l.card.classList.add('pmd-laid-out');
      cursor = actualTop + l.height + minGap;
    }
    // Ensure the column itself is tall enough to contain the last
    // card. Without this, a card anchored near the bottom of a
    // tall doc overflows the column's flex-stretched height and
    // gets visually clipped against the page boundary.
    this.root.style.minHeight = `${cursor}px`;
  }

  private renderThread(thread: Thread, range: { from: number; to: number } | null): HTMLElement {
    const card = document.createElement('article');
    card.className = 'pmd-comment-thread';
    card.dataset['threadId'] = thread.id;

    // Click → scroll editor to the range. We skip if the click
    // landed inside an editable (reply input) — that's a typing
    // event, not navigation.
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('textarea, input, button')) return;
      if (!range) return;
      this.scrollToRange(range);
    });

    // A freshly-created thread starts as a single empty-text root.
    // Render it as a primary "add comment" input instead of an
    // existing comment + reply box, so the user can type their
    // first message naturally. First submit edits the root in
    // place rather than creating a reply.
    const root = thread.comments[0];
    const isEmptyRoot = thread.comments.length === 1 && root && root.text === '';
    if (isEmptyRoot) {
      card.appendChild(this.renderRootHeader(thread, root));
      card.appendChild(this.renderPrimaryInput(thread, root));
      return card;
    }

    for (const c of thread.comments) {
      card.appendChild(this.renderComment(thread, c, c.id === thread.id));
    }
    card.appendChild(this.renderReplyForm(thread));
    return card;
  }

  /** Header-only render for the empty-root state: shows author
   *  badge + delete button without the empty body block, so the
   *  thread doesn't render a blank comment card before the user
   *  has typed anything. */
  private renderRootHeader(thread: Thread, root: Comment): HTMLElement {
    const block = document.createElement('div');
    block.className = 'pmd-comment-root pmd-comment-pending';
    const header = document.createElement('header');
    header.className = 'pmd-comment-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    fillBadge(badge, root.author, root.initials);
    header.appendChild(badge);
    const name = document.createElement('span');
    name.className = 'pmd-comment-author';
    name.textContent = root.author || 'Unknown';
    header.appendChild(name);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-comment-delete';
    del.title = 'Cancel';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteThread(thread.id);
    });
    header.appendChild(del);
    block.appendChild(header);
    return block;
  }

  private renderPrimaryInput(thread: Thread, root: Comment): HTMLElement {
    const form = this.buildInputForm(thread, 'Add a comment…', (text) => {
      this.commitRootText(thread.id, root.id, text);
    }, 'Comment');
    return form;
  }

  private renderReplyForm(thread: Thread): HTMLElement {
    return this.buildInputForm(thread, 'Reply…', (text) => {
      this.submitReply(thread.id, text);
    }, 'Reply');
  }

  private buildInputForm(
    thread: Thread,
    placeholder: string,
    onSubmit: (text: string) => void,
    submitLabel: string,
  ): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'pmd-comment-reply-form';

    const ta = document.createElement('textarea');
    ta.className = 'pmd-comment-reply-input';
    ta.rows = 2;
    ta.placeholder = placeholder;
    if (this.activeReplyThreadId === thread.id) ta.value = this.activeReplyText;
    ta.addEventListener('focus', () => {
      this.activeReplyThreadId = thread.id;
      this.activeReplyText = ta.value;
    });
    ta.addEventListener('input', () => {
      if (this.activeReplyThreadId === thread.id) this.activeReplyText = ta.value;
    });
    ta.addEventListener('blur', () => {
      if (this.suppressBlurReset) return;
      this.activeReplyThreadId = null;
      this.activeReplyText = '';
    });
    // Enter submits, Shift-Enter inserts a newline.
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.appendChild(ta);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'pmd-comment-reply-submit';
    submitBtn.textContent = submitLabel;
    form.appendChild(submitBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      onSubmit(text);
    });
    return form;
  }

  private commitRootText(threadId: string, commentId: string, text: string): void {
    const view = this.getView();
    if (!view) return;
    this.suppressBlurReset = true;
    this.activeReplyThreadId = null;
    this.activeReplyText = '';
    view.dispatch(
      view.state.tr.setMeta(commentsKey, editCommentTextMeta(threadId, commentId, text)),
    );
    this.suppressBlurReset = false;
    view.focus();
  }

  private renderComment(thread: Thread, comment: Comment, isRoot: boolean): HTMLElement {
    const block = document.createElement('div');
    block.className = isRoot ? 'pmd-comment-root' : 'pmd-comment-reply';
    if (comment.kind === 'ai') block.classList.add('pmd-comment-ai');

    const header = document.createElement('header');
    header.className = 'pmd-comment-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    fillBadge(badge, comment.author, comment.initials);
    header.appendChild(badge);
    const name = document.createElement('span');
    name.className = 'pmd-comment-author';
    name.textContent = comment.author || 'Unknown';
    if (comment.kind === 'ai') {
      const tag = document.createElement('span');
      tag.className = 'pmd-comment-kind-tag';
      tag.textContent = 'AI';
      name.appendChild(tag);
    }
    header.appendChild(name);
    if (comment.date) {
      const date = document.createElement('span');
      date.className = 'pmd-comment-date';
      date.textContent = formatDate(comment.date);
      header.appendChild(date);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-comment-delete';
    del.title = isRoot ? 'Delete thread' : 'Delete reply';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isRoot) this.deleteThread(thread.id);
      else this.deleteComment(thread.id, comment.id);
    });
    header.appendChild(del);
    block.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-comment-body';
    for (const line of comment.text.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    block.appendChild(body);
    return block;
  }

  private submitReply(threadId: string, text: string): void {
    const view = this.getView();
    if (!view) return;
    const comment: Comment = {
      id: newCommentId(),
      author: settings.get('commentAuthor'),
      // Store only the user's explicit setting — derivation happens
      // at render time so the badge can fall back to a silhouette
      // when there's no good initials to compute.
      initials: settings.get('commentAuthorInitials').trim(),
      date: new Date().toISOString(),
      text,
      kind: 'human',
      parentId: threadId,
    };
    this.suppressBlurReset = true;
    this.activeReplyThreadId = null;
    this.activeReplyText = '';
    view.dispatch(view.state.tr.setMeta(commentsKey, addReplyMeta(threadId, comment)));
    this.suppressBlurReset = false;
    view.focus();
  }

  private deleteThread(threadId: string): void {
    const view = this.getView();
    if (!view) return;
    // Strip the comment_range mark from the doc, then drop the
    // thread from plugin state. (The plugin's GC would also clean
    // it up, but doing both in one transaction keeps the undo
    // history coherent.)
    const tr = view.state.tr;
    const commentType = schema.marks['comment_range'];
    if (commentType) {
      view.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          if (mark.type.name === 'comment_range' && mark.attrs['threadId'] === threadId) {
            tr.removeMark(pos, pos + node.nodeSize, commentType);
            return;
          }
        }
      });
    }
    tr.setMeta(commentsKey, deleteThreadMeta(threadId));
    view.dispatch(tr);
  }

  private deleteComment(threadId: string, commentId: string): void {
    const view = this.getView();
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(commentsKey, deleteCommentMeta(threadId, commentId)));
  }

  private scrollToRange(range: { from: number; to: number }): void {
    const view = this.getView();
    if (!view) return;
    const dom = view.domAtPos(range.from);
    if (!dom.node) return;
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement;
    if (el && 'scrollIntoView' in el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** Focus the brand-new thread's reply input so the user can
   *  start typing their first comment immediately after the
   *  "add comment" action runs. */
  focusReplyForThread(threadId: string): void {
    this.activeReplyThreadId = threadId;
    this.activeReplyText = '';
    // Defer to next frame so the DOM has been re-rendered.
    requestAnimationFrame(() => {
      const card = this.root.querySelector(
        `[data-thread-id="${cssEscape(threadId)}"]`,
      );
      if (!card) return;
      const ta = card.querySelector<HTMLTextAreaElement>('textarea.pmd-comment-reply-input');
      if (ta) ta.focus();
    });
  }
}

// ----------------------- helpers --------------------------------

function collectRanges(doc: PMNode): Map<string, { from: number; to: number }> {
  // Lowest position wins (= first occurrence in doc order). Multiple
  // segments of the same thread get merged into a single range
  // spanning their min/max positions, so a multi-paragraph comment
  // still scroll-anchors to its first segment.
  const out = new Map<string, { from: number; to: number }>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== 'comment_range') continue;
      const id = String(mark.attrs['threadId'] ?? '');
      if (!id) continue;
      const r = out.get(id);
      if (r) {
        r.from = Math.min(r.from, pos);
        r.to = Math.max(r.to, pos + node.nodeSize);
      } else {
        out.set(id, { from: pos, to: pos + node.nodeSize });
      }
    }
  });
  return out;
}

/** Decide what to render in the avatar circle. Returns a short
 *  initials string when we have something better than slicing two
 *  letters off a single-word name (which produces "Yo" for "You"
 *  and similarly silly results). Returns null when the caller
 *  should render a generic silhouette icon instead. */
function badgeText(authorName: string, explicitInitials: string): string | null {
  const explicit = explicitInitials.trim();
  if (explicit) return explicit.slice(0, 3).toUpperCase();
  const parts = authorName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  // Single-word or empty author name — no good initials to derive.
  return null;
}

/** Build a small head-and-shoulders silhouette SVG. Sized to fit
 *  inside the 1.4rem badge circle without specific width/height —
 *  inherits via 100%/100% so the badge's existing dimensions
 *  apply. */
function buildSilhouetteSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('width', '60%');
  svg.setAttribute('height', '60%');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(ns, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '8');
  head.setAttribute('r', '4');
  const body = document.createElementNS(ns, 'path');
  body.setAttribute('d', 'M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8H4z');
  svg.appendChild(head);
  svg.appendChild(body);
  return svg;
}

/** Populate a badge element with either initials text or a silhouette
 *  icon. Always clears `el` first so re-renders don't accumulate
 *  stale children. */
function fillBadge(el: HTMLElement, authorName: string, storedInitials: string): void {
  el.replaceChildren();
  const text = badgeText(authorName, storedInitials);
  if (text) {
    el.textContent = text;
  } else {
    el.appendChild(buildSilhouetteSvg());
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Short local-time format — matches Word's compact comment date.
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function cssEscape(s: string): string {
  // Minimal CSS escape for our slug-shaped thread ids; sufficient
  // since allocated ids are stringified integers.
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// ----------------------- commands --------------------------------

/** Apply a comment_range mark to the current selection and add the
 *  thread to plugin state. Returns the new thread's id (so the
 *  caller can scroll the side column to the new card). No-op when
 *  the selection is empty or already entirely commented. */
export function addCommentToSelection(view: EditorView): string | null {
  const { state } = view;
  const sel = state.selection;
  if (sel.empty) return null;
  const commentType = schema.marks['comment_range'];
  if (!commentType) return null;

  const threadId = newCommentId();
  const commentId = threadId; // root comment id == thread id
  const root: Comment = {
    id: commentId,
    author: settings.get('commentAuthor'),
    initials: settings.get('commentAuthorInitials').trim(),
    date: new Date().toISOString(),
    text: '',
    kind: 'human',
    parentId: null,
  };
  const thread: Thread = { id: threadId, comments: [root] };

  const tr = state.tr;
  tr.addMark(sel.from, sel.to, commentType.create({ threadId }));
  tr.setMeta(commentsKey, addThreadMeta(thread));
  view.dispatch(tr);
  return threadId;
}
