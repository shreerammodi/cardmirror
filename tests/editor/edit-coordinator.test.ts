/**
 * AI edit coordinator — leases that anchor an in-flight AI edit's region,
 * remap it through concurrent edits, reject overlapping claims, and block
 * (non-bypass) user edits inside a live lease.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import {
  editCoordinatorPlugin,
  claimRegion,
  coordinatorBlocks,
} from '../../src/editor/ai/edit-coordinator.js';

function para(text: string) {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeDoc(...texts: string[]) {
  return schema.nodes['doc']!.createChecked(null, texts.map(para));
}

/** Minimal stand-in for an EditorView: the coordinator only touches
 *  `.state` and `.dispatch`. dispatch runs the real apply pipeline
 *  (so filterTransaction fires). */
function fakeView(...texts: string[]): EditorView & { state: EditorState } {
  const state = EditorState.create({ doc: makeDoc(...texts), plugins: [editCoordinatorPlugin] });
  const v = {
    state,
    dispatch(tr: ReturnType<EditorState['tr']['insertText']>) {
      v.state = v.state.apply(tr);
    },
  };
  return v as unknown as EditorView & { state: EditorState };
}

describe('edit coordinator leases', () => {
  it('remaps a lease through an edit elsewhere in the doc', () => {
    // doc: para1 "hello world" [1..12], para2 "second" [14..20].
    const view = fakeView('hello world', 'second');
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    expect(lease).not.toBeNull();
    expect(lease.region()).toEqual({ from: 14, to: 20 });

    // Insert 2 chars inside para1 (OUTSIDE the lease) → lease shifts by 2.
    view.dispatch(view.state.tr.insertText('XX', 1));
    expect(lease.region()).toEqual({ from: 16, to: 22 });
    expect(lease.delta()).toBe(2);
  });

  it('rejects an overlapping claim but allows a disjoint one', () => {
    const view = fakeView('hello world long enough');
    const a = claimRegion(view, { from: 2, to: 8 }, { label: 'a' });
    expect(a).not.toBeNull();
    // Overlaps [2,8).
    expect(claimRegion(view, { from: 5, to: 10 }, { label: 'b' })).toBeNull();
    // Abuts at 8 (no shared interior) — allowed.
    const c = claimRegion(view, { from: 8, to: 12 }, { label: 'c' });
    expect(c).not.toBeNull();
    // Fully disjoint — allowed.
    expect(claimRegion(view, { from: 13, to: 16 }, { label: 'd' })).not.toBeNull();
  });

  it('blocks a non-bypass edit inside a lease, allows one outside', () => {
    const view = fakeView('hello world', 'second');
    claimRegion(view, { from: 14, to: 20 }, { label: 'test' });

    const inside = view.state.tr.insertText('Z', 16);
    expect(coordinatorBlocks(view.state, inside)).toBe(true);

    const outside = view.state.tr.insertText('Z', 3);
    expect(coordinatorBlocks(view.state, outside)).toBe(false);

    // A deletion straddling the lease boundary is also blocked.
    const straddle = view.state.tr.delete(12, 17);
    expect(coordinatorBlocks(view.state, straddle)).toBe(true);
  });

  it('blocks a length-neutral mark / style change inside a lease', () => {
    const view = fakeView('hello world', 'second');
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    const um = schema.marks['underline_mark']!;

    // Adding a direct mark inside the lease doesn't change length, but it's
    // still an edit to the region — blocked.
    expect(coordinatorBlocks(view.state, view.state.tr.addMark(15, 19, um.create()))).toBe(true);

    // Seed a mark via the lease's own bypass write, then removing it inside the
    // lease is blocked too.
    lease.apply(view.state.tr.addMark(14, 20, um.create()));
    expect(coordinatorBlocks(view.state, view.state.tr.removeMark(15, 19, um))).toBe(true);

    // The same mark applied OUTSIDE the lease is allowed.
    expect(coordinatorBlocks(view.state, view.state.tr.addMark(2, 6, um.create()))).toBe(false);
  });

  it('filterTransaction drops a user edit inside a lease', () => {
    const view = fakeView('hello world', 'second');
    claimRegion(view, { from: 14, to: 20 }, { label: 'test' });
    const before = view.state.doc;
    // Plain (non-bypass) edit inside the lease → filtered out by the plugin.
    view.dispatch(view.state.tr.insertText('Z', 16));
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it('lets the lease holder write inside its own region (bypass)', () => {
    const view = fakeView('hello world', 'second');
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    const region = lease.region()!;
    lease.apply(view.state.tr.insertText('!', region.from + 1));
    expect(view.state.doc.textContent).toContain('s!econd');
    // The lease tracked its own write — region grew by one.
    expect(lease.region()).toEqual({ from: 14, to: 21 });
  });

  it('release ends the lease and lifts the block', () => {
    const view = fakeView('hello world', 'second');
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    lease.release();
    expect(lease.region()).toBeNull();
    expect(coordinatorBlocks(view.state, view.state.tr.insertText('Z', 16))).toBe(false);
    // The region is free to claim again.
    expect(claimRegion(view, { from: 14, to: 20 }, { label: 'again' })).not.toBeNull();
  });

  it('invalidates a lease whose region is wiped by a bypass write', () => {
    const view = fakeView('hello world', 'second');
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    // Bypass-delete the whole leased range → it collapses, lease drops.
    lease.apply(view.state.tr.delete(14, 20));
    expect(lease.region()).toBeNull();
    expect(lease.delta()).toBeNull();
  });
});
