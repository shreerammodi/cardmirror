/**
 * Comments plugin state.
 *
 * Thread data lives outside the document tree (the doc only carries
 * `comment_range` marks that reference thread IDs). The plugin owns
 * a `Map<threadId, Thread>` and exposes a small command surface for
 * the UI: load (used at import time), addThread, addReply,
 * deleteThread, deleteComment, setVisible.
 *
 * Mutations always go through transactions with a `commentsKey` meta
 * payload so the undo history captures them. Document edits that
 * affect comment ranges (e.g. deleting all marked text) are handled
 * by an `appendTransaction` that garbage-collects threads whose
 * mark has disappeared from the doc.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

export type CommentKind = 'human' | 'ai';

export interface Comment {
  /** OOXML-compatible numeric id. Allocated as a stringified integer
   *  on new comments; preserved verbatim when imported from docx. */
  id: string;
  /** Display name of the author. */
  author: string;
  /** Author initials (Word shows these in the margin badge). */
  initials: string;
  /** ISO 8601 timestamp. */
  date: string;
  /** Plain-text body for now. Rich-text bodies can come later. */
  text: string;
  /** Distinguishes the AI-explainer flow from regular user comments.
   *  Lost on docx export (Word has no concept); preserved within
   *  our own JSON serialization if we ship that later. */
  kind: CommentKind;
  /** `null` = root of the thread; otherwise the `id` of the comment
   *  this one replies to. Modern Word stores this via
   *  `word/commentsExtended.xml`'s paraId/paraIdParent linkage; we
   *  flatten that to a parent comment-id reference. */
  parentId: string | null;
}

export interface Thread {
  /** Same as the root comment's `id`. The `comment_range` mark
   *  references threads by this value. */
  id: string;
  /** Root comment first, then replies in chronological order. */
  comments: Comment[];
}

export interface CommentsState {
  threads: Map<string, Thread>;
  /** Mirrors `settings.commentsVisible` so the view can read this
   *  state directly without subscribing to the settings store. */
  visible: boolean;
}

export const commentsKey = new PluginKey<CommentsState>('comments');

/** Meta-payload shape for transactions that mutate the comments
 *  state. The plugin's `apply` reads these. */
type CommentsMeta =
  | { type: 'load'; threads: Thread[] }
  | { type: 'add'; thread: Thread }
  | { type: 'reply'; threadId: string; comment: Comment }
  | { type: 'edit-text'; threadId: string; commentId: string; text: string }
  | { type: 'delete-thread'; threadId: string }
  | { type: 'delete-comment'; threadId: string; commentId: string }
  | { type: 'set-visible'; visible: boolean };

export const commentsPlugin: Plugin<CommentsState> = new Plugin<CommentsState>({
  key: commentsKey,
  state: {
    init() {
      return { threads: new Map(), visible: false };
    },
    apply(tr, prev) {
      const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined;
      if (!meta) return prev;
      switch (meta.type) {
        case 'load': {
          const threads = new Map<string, Thread>();
          for (const t of meta.threads) threads.set(t.id, t);
          return { ...prev, threads };
        }
        case 'add': {
          const threads = new Map(prev.threads);
          threads.set(meta.thread.id, meta.thread);
          return { ...prev, threads };
        }
        case 'reply': {
          const threads = new Map(prev.threads);
          const t = threads.get(meta.threadId);
          if (t) {
            threads.set(meta.threadId, {
              ...t,
              comments: [...t.comments, meta.comment],
            });
          }
          return { ...prev, threads };
        }
        case 'edit-text': {
          const threads = new Map(prev.threads);
          const t = threads.get(meta.threadId);
          if (t) {
            threads.set(meta.threadId, {
              ...t,
              comments: t.comments.map((c) =>
                c.id === meta.commentId ? { ...c, text: meta.text } : c,
              ),
            });
          }
          return { ...prev, threads };
        }
        case 'delete-thread': {
          const threads = new Map(prev.threads);
          threads.delete(meta.threadId);
          return { ...prev, threads };
        }
        case 'delete-comment': {
          const threads = new Map(prev.threads);
          const t = threads.get(meta.threadId);
          if (t) {
            const comments = t.comments.filter((c) => c.id !== meta.commentId);
            // If we just removed the root, drop the whole thread —
            // the `comment_range` mark gets stripped separately by
            // the caller (otherwise the mark would point at
            // nothing).
            if (comments.length === 0 || (t.comments[0]?.id === meta.commentId)) {
              threads.delete(meta.threadId);
            } else {
              threads.set(meta.threadId, { ...t, comments });
            }
          }
          return { ...prev, threads };
        }
        case 'set-visible':
          return { ...prev, visible: meta.visible };
      }
    },
  },
  appendTransaction(transactions, _oldState, newState) {
    // Garbage-collect threads whose `comment_range` mark no longer
    // exists anywhere in the doc — e.g. when the user deletes the
    // entire commented range. Only do work when the doc actually
    // changed (cheap fast path).
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const liveIds = collectLiveThreadIds(newState.doc);
    const state = commentsKey.getState(newState);
    if (!state) return null;
    const stale: string[] = [];
    for (const id of state.threads.keys()) {
      if (!liveIds.has(id)) stale.push(id);
    }
    if (stale.length === 0) return null;
    const tr = newState.tr;
    // One bookkeeping transaction handles all stale IDs; the meta
    // payload is a delete-thread per ID, applied sequentially via
    // multiple setMetas. Easier: a synthetic 'load' with the
    // surviving threads.
    const surviving: Thread[] = [];
    for (const [id, thread] of state.threads) {
      if (liveIds.has(id)) surviving.push(thread);
    }
    tr.setMeta(commentsKey, { type: 'load', threads: surviving });
    tr.setMeta('addToHistory', false);
    return tr;
  },
});

function collectLiveThreadIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'comment_range') {
        const id = String(mark.attrs['threadId'] ?? '');
        if (id) ids.add(id);
      }
    }
  });
  return ids;
}

// ----------------------- helpers / commands ----------------------

/** Generate a fresh comment id. Stringified integers keep
 *  round-trip with Word's `w:id` (a non-negative integer) trivial. */
let commentIdCounter = Date.now();
export function newCommentId(): string {
  commentIdCounter += 1;
  return String(commentIdCounter);
}

/** Apply a `load` transaction. Used right after importing a docx to
 *  populate plugin state with the parsed threads. */
export function loadThreads(state: EditorState, threads: Thread[]): Transaction {
  return state.tr.setMeta(commentsKey, { type: 'load', threads }).setMeta('addToHistory', false);
}

/** Read-only accessor — the side column UI calls this to render. */
export function getCommentsState(state: EditorState): CommentsState {
  return (
    commentsKey.getState(state) ?? { threads: new Map(), visible: false }
  );
}

/** Build a `meta` payload to add a new thread. Caller is responsible
 *  for also applying the `comment_range` mark to the selected text. */
export function addThreadMeta(thread: Thread): CommentsMeta {
  return { type: 'add', thread };
}

export function addReplyMeta(threadId: string, comment: Comment): CommentsMeta {
  return { type: 'reply', threadId, comment };
}

export function editCommentTextMeta(
  threadId: string,
  commentId: string,
  text: string,
): CommentsMeta {
  return { type: 'edit-text', threadId, commentId, text };
}

export function deleteThreadMeta(threadId: string): CommentsMeta {
  return { type: 'delete-thread', threadId };
}

export function deleteCommentMeta(threadId: string, commentId: string): CommentsMeta {
  return { type: 'delete-comment', threadId, commentId };
}

export function setCommentsVisibleMeta(visible: boolean): CommentsMeta {
  return { type: 'set-visible', visible };
}
