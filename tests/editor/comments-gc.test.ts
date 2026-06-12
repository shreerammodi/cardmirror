/**
 * Comment GC vs undo: orphaned threads are tombstoned (not discarded) so an
 * undo that restores the `comment_range` mark resurrects the thread, and
 * tombstones are dropped when a new document loads.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  commentsPlugin,
  commentsKey,
  getCommentsState,
  gcOrphanThreads,
  addThreadMeta,
  loadThreads,
  type Thread,
} from '../../src/editor/comments-plugin.js';

const markType = schema.marks['comment_range']!;

function docWith(text: string): PMNode {
  return schema.nodes['doc']!.create(null, schema.nodes['paragraph']!.create(null, schema.text(text)));
}

function thread(id: string): Thread {
  return {
    id,
    comments: [{ id, author: 'A', initials: 'A', date: '', text: `note ${id}`, kind: 'human', parentId: null }],
  };
}

describe('comment GC vs undo', () => {
  it('tombstones an orphaned thread and resurrects it when the mark returns', () => {
    let state = EditorState.create({ doc: docWith('hello world'), plugins: [commentsPlugin] });
    const runGc = (): void => {
      gcOrphanThreads({ state, dispatch: (t) => { state = state.apply(t); } });
    };

    // Add a thread anchored on "hello" (positions 1..6).
    let tr = state.tr.setMeta(commentsKey, addThreadMeta(thread('1')));
    tr.addMark(1, 6, markType.create({ threadId: '1' }));
    state = state.apply(tr);
    expect(getCommentsState(state).threads.has('1')).toBe(true);

    // Delete the commented text → the mark goes with it; GC tombstones it.
    state = state.apply(state.tr.delete(1, 6));
    runGc();
    expect(getCommentsState(state).threads.has('1')).toBe(false);

    // Undo-equivalent: bring "hello" and its mark back; GC resurrects.
    const tr2 = state.tr.insertText('hello', 1);
    tr2.addMark(1, 6, markType.create({ threadId: '1' }));
    state = state.apply(tr2);
    runGc();
    const threads = getCommentsState(state).threads;
    expect(threads.has('1')).toBe(true);
    expect(threads.get('1')!.comments[0]!.text).toBe('note 1'); // content intact
  });

  it('drops tombstones when a new document loads (no cross-doc resurrection)', () => {
    let state = EditorState.create({ doc: docWith('hi there'), plugins: [commentsPlugin] });
    let tr = state.tr.setMeta(commentsKey, addThreadMeta(thread('9')));
    tr.addMark(1, 3, markType.create({ threadId: '9' }));
    state = state.apply(tr);
    state = state.apply(state.tr.delete(1, 3));
    gcOrphanThreads({ state, dispatch: (t) => { state = state.apply(t); } });
    expect(getCommentsState(state).tombstone.has('9')).toBe(true);

    state = state.apply(loadThreads(state, []));
    expect(getCommentsState(state).tombstone.size).toBe(0);
  });
});
