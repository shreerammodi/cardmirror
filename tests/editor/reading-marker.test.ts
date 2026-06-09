import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  formatMarkerTime,
  isReadingMarkerColor,
  readingMarkerRunAt,
  buildInsertReadingMarkerTransaction,
  buildToggleReadingMarkerTransaction,
  READING_MARKER_COLOR,
  READING_MARKER_META,
} from '../../src/editor/reading-marker.js';
import { history } from 'prosemirror-history';
import {
  readModePlugin,
  PMD_READ_MODE_TOGGLE,
  readModeAwareUndo,
  readModeAwareRedo,
} from '../../src/editor/read-mode-plugin.js';

function tag(text: string) { return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)); }
function cardBody(text: string) { return schema.nodes['card_body']!.create(null, schema.text(text)); }
function card(...c: any[]) { return schema.nodes['card']!.createChecked(null, c); }
function makeDoc(...c: any[]) { return schema.nodes['doc']!.createChecked(null, c); }

const NOW = new Date(2024, 0, 1, 7, 32);

function cursorAt(doc: any, text: string, offset: number): EditorState {
  let pos = -1;
  doc.descendants((n: any, p: number) => { if (n.isText && n.text === text) pos = p + offset; return true; });
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

function markerText(doc: any): { text: string; color: string | undefined } | null {
  let found: { text: string; color: string | undefined } | null = null;
  doc.descendants((n: any) => {
    if (n.isText && n.text?.startsWith('Marked')) {
      const fc = n.marks.find((m: any) => m.type.name === 'font_color');
      found = { text: n.text, color: fc?.attrs['color'] };
    }
    return true;
  });
  return found;
}

describe('formatMarkerTime', () => {
  it('formats as h:mm, 12-hour, no leading zero on the hour', () => {
    expect(formatMarkerTime(new Date(2024, 0, 1, 7, 32))).toBe('7:32');
    expect(formatMarkerTime(new Date(2024, 0, 1, 19, 5))).toBe('7:05');
    expect(formatMarkerTime(new Date(2024, 0, 1, 0, 0))).toBe('12:00');
  });
});

describe('isReadingMarkerColor', () => {
  it('matches the marker red case-insensitively', () => {
    expect(isReadingMarkerColor('FF0000')).toBe(true);
    expect(isReadingMarkerColor('ff0000')).toBe(true);
    expect(isReadingMarkerColor('000000')).toBe(false);
    expect(isReadingMarkerColor(undefined)).toBe(false);
  });
});

describe('reading marker toggle', () => {
  it('inserts a red "Marked h:mm" run when the cursor is on plain text', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    const tr = buildToggleReadingMarkerTransaction(state, NOW)!;
    const next = state.apply(tr);
    const m = markerText(next.doc);
    expect(m).toEqual({ text: 'Marked 7:32', color: READING_MARKER_COLOR });
    expect((next.storedMarks ?? []).some((mk) => mk.type.name === 'font_color')).toBe(false);
  });

  it('removes the marker when the cursor is on an existing one (toggle off)', () => {
    // Insert one, then toggle again at the caret (which lands after it).
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    const afterInsert = state.apply(buildToggleReadingMarkerTransaction(state, NOW)!);
    expect(markerText(afterInsert.doc)).not.toBeNull();
    // Caret is right after the marker → run is detected.
    expect(readingMarkerRunAt(afterInsert)).not.toBeNull();
    const afterRemove = afterInsert.apply(buildToggleReadingMarkerTransaction(afterInsert, NOW)!);
    expect(markerText(afterRemove.doc)).toBeNull();
    // Original text is intact.
    expect(afterRemove.doc.textContent).toBe('TAGhello world');
  });

  it('readingMarkerRunAt is null when the cursor is on plain text', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    expect(readingMarkerRunAt(state)).toBeNull();
  });

  it('buildInsertReadingMarkerTransaction always inserts (no toggle)', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('x'))), 'x', 1);
    const next = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!);
    expect(markerText(next.doc)?.text).toBe('Marked 7:32');
  });
});

describe('read mode edit lock (filterTransaction)', () => {
  function readModeState(text: string, offset: number) {
    const doc = makeDoc(card(tag('TAG'), cardBody(text)));
    let pos = -1;
    doc.descendants((n: any, p: number) => { if (n.isText && n.text === text) pos = p + offset; return true; });
    let s = EditorState.create({ doc, plugins: [readModePlugin] });
    s = s.applyTransaction(s.tr.setSelection(TextSelection.create(s.doc, pos))).state;
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, true)).state;
    return s;
  }

  it('blocks a plain edit while read mode is on', () => {
    const s = readModeState('hello world', 5);
    const after = s.applyTransaction(s.tr.insertText('Z', s.selection.head)).state;
    expect(after.doc.textContent).toBe('TAGhello world'); // unchanged
  });

  it('allows a transaction flagged as the reading marker', () => {
    const s = readModeState('hello world', 5);
    const tr = s.tr.insertText('Z', s.selection.head).setMeta(READING_MARKER_META, true);
    const after = s.applyTransaction(tr).state;
    expect(after.doc.textContent).toContain('Z');
  });

  it('allows selection-only changes (cursor stays usable)', () => {
    const s = readModeState('hello world', 5);
    const tr = s.tr.setSelection(TextSelection.create(s.doc, s.selection.head + 2));
    const after = s.applyTransaction(tr).state;
    expect(after.selection.head).toBe(s.selection.head + 2);
  });

  it('allows edits again once read mode is off', () => {
    let s = readModeState('hello world', 5);
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, false)).state;
    const after = s.applyTransaction(s.tr.insertText('Z', s.selection.head)).state;
    expect(after.doc.textContent).toContain('Z');
  });
});

describe('read-mode undo/redo is bounded to markers', () => {
  function dispatchCmd(s: EditorState, cmd: typeof readModeAwareUndo): EditorState {
    let next = s;
    cmd(s, (tr) => { next = s.applyTransaction(tr).state; });
    return next;
  }

  function enterReadModeWithPreEdit(): EditorState {
    const doc = makeDoc(card(tag('TAG'), cardBody('hello')));
    let s = EditorState.create({ doc, plugins: [history(), readModePlugin] });
    let pos = -1;
    doc.descendants((n: any, p: number) => { if (n.isText && n.text === 'hello') pos = p + 5; return true; });
    s = s.applyTransaction(s.tr.setSelection(TextSelection.create(s.doc, pos))).state;
    // A normal (non-marker) edit BEFORE read mode — must never be undoable
    // from inside read mode.
    s = s.applyTransaction(s.tr.insertText(' world', s.selection.head)).state;
    expect(s.doc.textContent).toBe('TAGhello world');
    // Enter read mode, then drop a marker.
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, true)).state;
    s = s.applyTransaction(buildToggleReadingMarkerTransaction(s, NOW)!).state;
    expect(markerText(s.doc)).not.toBeNull();
    return s;
  }

  it('undoes the marker but stops there (never the pre-read-mode edit)', () => {
    let s = enterReadModeWithPreEdit();
    s = dispatchCmd(s, readModeAwareUndo); // removes the marker
    expect(markerText(s.doc)).toBeNull();
    expect(s.doc.textContent).toBe('TAGhello world');
    s = dispatchCmd(s, readModeAwareUndo); // blocked — does NOT undo " world"
    expect(s.doc.textContent).toBe('TAGhello world');
  });

  it('redo re-applies the undone marker', () => {
    let s = enterReadModeWithPreEdit();
    s = dispatchCmd(s, readModeAwareUndo);
    expect(markerText(s.doc)).toBeNull();
    s = dispatchCmd(s, readModeAwareRedo);
    expect(markerText(s.doc)).not.toBeNull();
  });
});
