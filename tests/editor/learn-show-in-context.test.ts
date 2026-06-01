// @vitest-environment jsdom
//
// "Show in context" source selection: from a card's anchors + the doc
// registry, pick the source file to open (first anchor whose doc has a
// known path). The open/scroll wiring lives in index.ts and isn't unit-
// testable; this covers the selection rule that gates the button.
import { describe, it, expect } from 'vitest';
import { pickCardSource } from '../../src/editor/learn-session-ui.js';
import type { CardAnchor, DocRegistryEntry } from '../../src/editor/learn-store.js';
import type { AnchorDescriptor } from '../../src/editor/learn-anchor.js';

const desc = (quote: string): AnchorDescriptor => ({
  quote,
  prefix: '',
  suffix: '',
  approxPos: 0,
});

const doc = (docId: string, paths: string[], name = docId): DocRegistryEntry => ({
  docId,
  knownPaths: paths,
  lastName: name,
  format: 'cmir',
});

describe('pickCardSource', () => {
  it('returns the source for an anchored card whose doc has a path', () => {
    const anchors: CardAnchor[] = [{ cardId: 'c1', docId: 'd1', anchor: desc('hello') }];
    const docs = [doc('d1', ['/files/a.cmir'], 'a.cmir')];
    expect(pickCardSource('c1', anchors, docs)).toEqual({
      path: '/files/a.cmir',
      name: 'a.cmir',
      descriptor: desc('hello'),
    });
  });

  it('uses the newest known path (knownPaths[0])', () => {
    const anchors: CardAnchor[] = [{ cardId: 'c1', docId: 'd1', anchor: desc('x') }];
    const docs = [doc('d1', ['/new/a.cmir', '/old/a.cmir'])];
    expect(pickCardSource('c1', anchors, docs)?.path).toBe('/new/a.cmir');
  });

  it('is null for an unanchored card (anchor === null)', () => {
    const anchors: CardAnchor[] = [{ cardId: 'c1', docId: 'd1', anchor: null }];
    const docs = [doc('d1', ['/files/a.cmir'])];
    expect(pickCardSource('c1', anchors, docs)).toBeNull();
  });

  it("is null when the card's doc has no known path (never saved / web)", () => {
    const anchors: CardAnchor[] = [{ cardId: 'c1', docId: 'd1', anchor: desc('x') }];
    const docs = [doc('d1', [])];
    expect(pickCardSource('c1', anchors, docs)).toBeNull();
  });

  it('skips an anchor whose doc has no path and uses a later one that does', () => {
    const anchors: CardAnchor[] = [
      { cardId: 'c1', docId: 'd1', anchor: desc('x') }, // d1 has no path
      { cardId: 'c1', docId: 'd2', anchor: desc('y') }, // d2 does
    ];
    const docs = [doc('d1', []), doc('d2', ['/files/b.cmir'], 'b.cmir')];
    expect(pickCardSource('c1', anchors, docs)?.path).toBe('/files/b.cmir');
  });

  it('ignores anchors belonging to other cards', () => {
    const anchors: CardAnchor[] = [{ cardId: 'other', docId: 'd1', anchor: desc('x') }];
    const docs = [doc('d1', ['/files/a.cmir'])];
    expect(pickCardSource('c1', anchors, docs)).toBeNull();
  });
});
