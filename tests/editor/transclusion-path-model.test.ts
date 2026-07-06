/**
 * Path-model helpers: root-relative vs doc-relative ref choice (the shared-
 * Dropbox insight), plus the pure containment/relative primitives.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseSourceRef,
  rootRelative,
  isWithinPure,
  relativeSourceRef,
} from '../../src/editor/transclusion.js';

const ROOT = '/Users/alice/Dropbox/Debate';
const DOC = '/Users/alice/Dropbox/Debate/Speeches/1AC.cmir';
const SRC = '/Users/alice/Dropbox/Debate/Impacts/Warming.cmir';

describe('chooseSourceRef — prefers root-relative in a shared folder', () => {
  it('uses root-relative when doc AND source share a configured root', () => {
    expect(chooseSourceRef(DOC, SRC, [ROOT])).toEqual({ ref: 'Impacts/Warming.cmir', base: 'root' });
  });
  it('root-relative survives the doc moving within the shared folder', () => {
    const movedDoc = '/Users/alice/Dropbox/Debate/Tournaments/Round3/1AC.cmir';
    expect(chooseSourceRef(movedDoc, SRC, [ROOT])).toEqual({ ref: 'Impacts/Warming.cmir', base: 'root' });
  });
  it('falls back to doc-relative when no root contains both', () => {
    // Root only contains the source, not the doc.
    const outsideDoc = '/Users/alice/Desktop/1AC.cmir';
    const r = chooseSourceRef(outsideDoc, SRC, [ROOT]);
    expect(r?.base).toBe('doc');
    expect(r?.ref).toBe('../Dropbox/Debate/Impacts/Warming.cmir');
  });
  it('falls back to doc-relative when no roots are configured', () => {
    expect(chooseSourceRef(DOC, SRC, [])).toEqual({
      ref: '../Impacts/Warming.cmir',
      base: 'doc',
    });
  });
  it('a teammate root-relative ref is machine-independent (same ref, different prefix)', () => {
    // Bob's shared folder is at a different absolute path but the ref is identical.
    const bobRoot = '/Users/bob/Dropbox/Debate';
    const bobDoc = '/Users/bob/Dropbox/Debate/Speeches/1AC.cmir';
    const bobSrc = '/Users/bob/Dropbox/Debate/Impacts/Warming.cmir';
    const alice = chooseSourceRef(DOC, SRC, [ROOT]);
    const bob = chooseSourceRef(bobDoc, bobSrc, [bobRoot]);
    expect(alice).toEqual(bob);
  });
  it('null when no portable ref exists (different Windows drives, no root)', () => {
    expect(chooseSourceRef('C:\\a\\Doc.cmir', 'D:\\b\\Src.cmir', [])).toBeNull();
  });
});

describe('rootRelative + isWithinPure', () => {
  it('rootRelative returns the path under the root', () => {
    expect(rootRelative(ROOT, SRC)).toBe('Impacts/Warming.cmir');
  });
  it('rootRelative is null when target is outside the root', () => {
    expect(rootRelative(ROOT, '/Users/alice/Desktop/x.cmir')).toBeNull();
  });
  it('isWithinPure: self, descendant, not ancestor/sibling', () => {
    expect(isWithinPure('/a/b', '/a/b')).toBe(true);
    expect(isWithinPure('/a/b', '/a/b/c')).toBe(true);
    expect(isWithinPure('/a/b', '/a')).toBe(false);
    expect(isWithinPure('/a/b', '/a/bc')).toBe(false); // prefix trap
  });
  it('handles windows separators + drive', () => {
    expect(isWithinPure('C:\\Users\\x\\DB', 'C:\\Users\\x\\DB\\Imp\\S.cmir')).toBe(true);
    expect(rootRelative('C:\\Users\\x\\DB', 'C:\\Users\\x\\DB\\Imp\\S.cmir')).toBe('Imp/S.cmir');
  });
  it('relativeSourceRef still works for the doc-relative fallback', () => {
    expect(relativeSourceRef(DOC, SRC)).toBe('../Impacts/Warming.cmir');
  });
});
