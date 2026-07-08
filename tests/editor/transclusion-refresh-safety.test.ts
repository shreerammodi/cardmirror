// @vitest-environment jsdom
/**
 * Regression coverage for the refresh-safety fixes (the async `refreshZoneAtPos`
 * path, previously untested):
 *  - it refuses (reason 'ambiguous') rather than overwrite the WRONG same-identity
 *    zone when the clicked pos goes stale during the async source read;
 *  - it re-confirms when the target became edited DURING the read;
 *  - it flattens a nested zone in the refreshed section to plain content;
 *  - `deepZoneIdentities` sees nested zone identities at any depth.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';

// Control the source read + the discard confirm so we can drive the async gaps
// deterministically. The refresh flow now uses the in-editor `showConfirm`
// dialog (not window.confirm), so mock that module.
const { resolveMock, confirmMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  confirmMock: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/editor/transclusion-resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/editor/transclusion-resolve.js')>();
  return { ...actual, resolveTransclusion: resolveMock };
});
vi.mock('../../src/editor/confirm-dialog.js', () => ({ showConfirm: confirmMock }));

import {
  createTransclusionNode,
  contentHash,
  deepZoneIdentities,
  zoneIdentity,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';
import {
  refreshZoneAtPos,
  replaceZoneAtPos,
  refreshAllZones,
} from '../../src/editor/transclusion-actions.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zoneNode(children: PMNode[], attrs: Record<string, unknown>, edited = false): PMNode {
  const content = Fragment.fromArray(children);
  const hash = edited ? 'stale-hash-does-not-match' : contentHash(content);
  return createTransclusionNode(schema, { source_content_hash: hash, ...attrs }, content);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function zoneTextAt(view: EditorView, pos: number): string {
  return view.state.doc.nodeAt(pos)?.textContent ?? '';
}

const REF = { source_ref: 'S.cmir', source_ref_base: 'doc' as const, source_heading_id: 'H' };

beforeEach(() => {
  resolveMock.mockReset();
  // Default: confirm resolves true so a refresh proceeds; individual tests
  // override for the cancel path.
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

describe('deepZoneIdentities', () => {
  it('finds nested zone identities at any depth', () => {
    const inner = zoneNode([card('Inner', 'x')], { ...REF, source_ref: 'B.cmir', source_heading_id: 'HB' });
    const outer = Fragment.fromArray([card('C', 'y'), inner]);
    const ids = deepZoneIdentities(outer);
    expect(ids.has(zoneIdentity(inner))).toBe(true);
  });
});

describe('refreshZoneAtPos — safety', () => {
  it("refuses (ambiguous) instead of overwriting the WRONG same-identity zone when pos goes stale", async () => {
    // Two live zones with the SAME identity: A (edited) first, B (clean) second.
    const zoneA = zoneNode([card('A', 'A-edited-content')], REF, /* edited */ true);
    const zoneB = zoneNode([card('B', 'B-clean-content')], REF);
    const view = makeView([zoneA, zoneB]);
    const posA = 0;
    const posB = zoneA.nodeSize;
    expect(isTransclusionNode(view.state.doc.nodeAt(posB)!)).toBe(true);

    const d = deferred<unknown>();
    resolveMock.mockReturnValue(d.promise);

    const pending = refreshZoneAtPos(view, posB); // refresh the clean zone B
    // Simulate a concurrent edit landing DURING the async read: insert a block at
    // posB, which shifts zone B and makes the clicked pos stale.
    view.dispatch(view.state.tr.insert(posB, schema.nodes['paragraph']!.create()));
    d.resolve({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'FRESH-from-source')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('ambiguous');
    // Crucially, NEITHER zone was overwritten — zone A's edits survive.
    expect(zoneTextAt(view, posA)).toContain('A-edited-content');
    expect(view.state.doc.textContent).not.toContain('FRESH-from-source');
    view.destroy();
  });

  it('refreshes normally when the single target is unambiguous', async () => {
    const view = makeView([zoneNode([card('Old', 'old-ev')], REF)]);
    resolveMock.mockResolvedValue({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'new-ev')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await refreshZoneAtPos(view, 0);
    expect(outcome.ok).toBe(true);
    expect(view.state.doc.textContent).toContain('new-ev');
    expect(view.state.doc.textContent).not.toContain('old-ev');
    view.destroy();
  });

  it('flattens a nested zone in the refreshed section (no cycle, no nested zone)', async () => {
    const view = makeView([zoneNode([card('Orig', 'orig-ev')], REF)]);
    // The source section contains a nested zone; refresh must flatten it to plain
    // content rather than nest another zone (which is what could form a cycle).
    const nested = createTransclusionNode(schema, REF, Fragment.fromArray([card('inner', 'inner-ev')]));
    resolveMock.mockResolvedValue({
      ok: true,
      result: { content: Fragment.fromArray([nested]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await refreshZoneAtPos(view, 0);
    expect(outcome.ok).toBe(true);
    let zones = 0;
    view.state.doc.descendants((n) => {
      if (isTransclusionNode(n)) zones++;
      return true;
    });
    expect(zones).toBe(1); // only the outer zone — the nested one was flattened
    expect(view.state.doc.textContent).toContain('inner-ev');
    expect(view.state.doc.textContent).not.toContain('orig-ev'); // replaced by refresh
    view.destroy();
  });

  it('re-confirms when the zone became edited during the read (and cancel preserves the edit)', async () => {
    const view = makeView([zoneNode([card('T', 'clean-ev')], REF)]);
    const d = deferred<unknown>();
    resolveMock.mockReturnValue(d.promise);
    confirmMock.mockResolvedValue(false); // user cancels the re-confirm

    const pending = refreshZoneAtPos(view, 0);
    // Edit the (clean) zone DURING the read → it becomes edited. Type into the
    // 'clean-ev' body text node.
    let typePos = -1;
    view.state.doc.descendants((n, p) => {
      if (typePos < 0 && n.isText && n.text?.includes('clean-ev')) typePos = p + 1;
      return true;
    });
    view.dispatch(view.state.tr.insertText('ZZZ', typePos));
    d.resolve({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'from-source')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await pending;

    expect(confirmMock).toHaveBeenCalled();         // it asked before discarding
    expect(outcome.reason).toBe('cancelled');       // user said no
    expect(view.state.doc.textContent).toContain('ZZZ');          // the edit survived
    expect(view.state.doc.textContent).not.toContain('from-source'); // source not applied
    view.destroy();
  });
});

describe('replaceZoneAtPos — re-pick identity safety', () => {
  const NEW = { source_ref: 'N.cmir', source_ref_base: 'doc' as const, source_heading_id: 'H2' };

  it('re-targets the zone located by identity even when the pos went stale', () => {
    const z = zoneNode([card('Old', 'old-ev')], REF);
    const view = makeView([z]);
    // Shift the zone so the captured pos (0) is stale; identity still finds it.
    view.dispatch(view.state.tr.insert(0, schema.nodes['paragraph']!.create()));
    const ok = replaceZoneAtPos(view, 0, zoneIdentity(z), NEW, Fragment.fromArray([card('New', 'new-ev')]));
    expect(ok).toBe(true);
    expect(view.state.doc.textContent).toContain('new-ev');
    expect(view.state.doc.textContent).not.toContain('old-ev');
    view.destroy();
  });

  it('refuses (no change) when duplicate-identity zones make a stale pos ambiguous', () => {
    const a = zoneNode([card('A', 'aaa')], REF);
    const b = zoneNode([card('B', 'bbb')], REF); // same identity as A
    const view = makeView([a, b]);
    const posB = a.nodeSize;
    // Shift both so posB no longer points at B; two identity matches → ambiguous.
    view.dispatch(view.state.tr.insert(0, schema.nodes['paragraph']!.create()));
    const ok = replaceZoneAtPos(view, posB, zoneIdentity(a), NEW, Fragment.fromArray([card('New', 'new-ev')]));
    expect(ok).toBe(false);
    expect(view.state.doc.textContent).toContain('aaa'); // both untouched
    expect(view.state.doc.textContent).toContain('bbb');
    expect(view.state.doc.textContent).not.toContain('new-ev');
    view.destroy();
  });
});

describe('refresh refuses to blank a zone from an emptied source', () => {
  it('keeps the cache and reports source-empty when the heading is now empty', async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      result: { content: Fragment.empty, headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const view = makeView([zoneNode([card('A', 'cached-ev')], { ...REF, source_heading_id: 'H1' }, false)]);
    const outcome = await refreshZoneAtPos(view, 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('source-empty');
    // The zone is untouched — its cached card still renders (no invisible husk).
    expect(view.state.doc.textContent).toContain('cached-ev');
    expect(view.state.doc.nodeAt(0)?.type.name).toBe('transclusion_ref');
    view.destroy();
  });
});

describe('refreshAllZones (whole-document refresh)', () => {
  const freshOutcome = () => ({
    ok: true as const,
    result: {
      content: Fragment.fromArray([card('New', 'fresh-ev')]),
      headingLabel: 'H',
      headingType: 'block' as const,
    },
    sourceName: 'S.cmir',
  });

  it('refreshes every zone after ONE confirmation (not one per edited zone)', async () => {
    resolveMock.mockResolvedValue(freshOutcome());
    const view = makeView([
      zoneNode([card('A', 'a-ev')], { ...REF, source_heading_id: 'H1' }, true), // edited
      zoneNode([card('B', 'b-ev')], { ...REF, source_heading_id: 'H2' }, false),
      zoneNode([card('C', 'c-ev')], { ...REF, source_heading_id: 'H3' }, true), // edited
    ]);
    const summary = await refreshAllZones(view);
    expect(summary).toEqual({ total: 3, refreshed: 3, failed: 0, confirmed: true });
    // A single up-front batch confirm — NOT one prompt per edited zone.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    // Every zone now shows the source content; none keep their old text.
    const text = view.state.doc.textContent;
    expect(text).not.toContain('a-ev');
    expect(text).not.toContain('b-ev');
    expect(text).not.toContain('c-ev');
    expect((text.match(/fresh-ev/g) ?? []).length).toBe(3);
    view.destroy();
  });

  it('cancelling the confirmation touches nothing and reads no source', async () => {
    confirmMock.mockResolvedValue(false);
    resolveMock.mockResolvedValue(freshOutcome());
    const view = makeView([
      zoneNode([card('A', 'a-ev')], { ...REF, source_heading_id: 'H1' }, true),
      zoneNode([card('B', 'b-ev')], { ...REF, source_heading_id: 'H2' }, false),
    ]);
    const before = view.state.doc.toJSON();
    const summary = await refreshAllZones(view);
    expect(summary).toEqual({ total: 2, refreshed: 0, failed: 0, confirmed: false });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(view.state.doc.toJSON()).toEqual(before);
    view.destroy();
  });

  it('a doc with no zones needs no confirm and reports zeros', async () => {
    const view = makeView([card('A', 'a-ev')]);
    const summary = await refreshAllZones(view);
    expect(summary).toEqual({ total: 0, refreshed: 0, failed: 0, confirmed: true });
    expect(confirmMock).not.toHaveBeenCalled();
    view.destroy();
  });

  it('counts an unreadable source as failed while still refreshing the rest', async () => {
    resolveMock.mockImplementation((_docPath, _ref, _base, headingId) =>
      Promise.resolve(
        headingId === 'H2' ? { ok: false, reason: 'source-unreadable' } : freshOutcome(),
      ),
    );
    const view = makeView([
      zoneNode([card('A', 'a-ev')], { ...REF, source_heading_id: 'H1' }, false),
      zoneNode([card('B', 'b-ev')], { ...REF, source_heading_id: 'H2' }, false),
    ]);
    const summary = await refreshAllZones(view);
    expect(summary).toEqual({ total: 2, refreshed: 1, failed: 1, confirmed: true });
    const text = view.state.doc.textContent;
    expect(text).toContain('fresh-ev'); // H1 refreshed
    expect(text).toContain('b-ev'); // H2 kept its cache
    view.destroy();
  });
});
