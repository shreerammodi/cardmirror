import { describe, it, expect } from 'vitest';
import { repointFolderRoot } from '../../src/editor/folder-list-repoint.js';

// The Browse… handler in the file-search folder list resolves its row
// by VALUE against the list as it exists when the native picker
// returns — the render-time index can go stale while the picker sits
// open (another window can edit the same list; settings sync via the
// `storage` event). These cases pin that resolution down.
describe('repointFolderRoot', () => {
  it('repoints the row in place, preserving order', () => {
    expect(repointFolderRoot(['/a', '/b', '/c'], '/b', '/x')).toEqual([
      '/a',
      '/x',
      '/c',
    ]);
  });

  it('re-picking the same folder is a no-op', () => {
    expect(repointFolderRoot(['/a', '/b'], '/b', '/b')).toBeNull();
  });

  it('repointing onto a folder already in the list drops the row', () => {
    expect(repointFolderRoot(['/a', '/b', '/c'], '/c', '/a')).toEqual([
      '/a',
      '/b',
    ]);
  });

  // The regression PR #19's follow-up fixed: the row was removed while
  // the picker sat open. Index-based resolution would have repointed
  // whatever folder now occupies the stale index.
  it('row removed while the picker was open is a no-op', () => {
    expect(repointFolderRoot(['/a', '/c'], '/b', '/x')).toBeNull();
  });

  it('resolves the right row after the list was reordered under the picker', () => {
    // Rendered as ['/b', '/a']; by resolve time another window
    // rewrote the list. The stale render index of '/b' (0) now holds
    // '/a' — value resolution must still repoint '/b'.
    expect(repointFolderRoot(['/a', '/b'], '/b', '/x')).toEqual(['/a', '/x']);
  });

  it('empty list is a no-op', () => {
    expect(repointFolderRoot([], '/b', '/x')).toBeNull();
  });

  it('does not mutate the input list', () => {
    const roots = ['/a', '/b'];
    repointFolderRoot(roots, '/b', '/x');
    expect(roots).toEqual(['/a', '/b']);
  });
});
