// @vitest-environment jsdom

/**
 * Vim mode: key parsing, and normal / visual / insert behavior driven
 * through the plugin's real key handler with the real ribbon commands.
 * j / k are not covered: they are geometric and jsdom has no layout.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { getRibbonCommand } from '../../src/editor/ribbon-commands.js';
import { parseKeys, toggleVimMode, vimModePlugin } from '../../src/editor/vim-mode.js';

const para = (text: string): PMNode =>
  schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []);

let view: EditorView;

function setup(texts: string[], cursor = 1): void {
  const doc = schema.nodes['doc']!.create(null, texts.map(para));
  const state = EditorState.create({
    doc,
    plugins: [vimModePlugin({ buildCommand: (id) => getRibbonCommand(id) })],
  });
  view = new EditorView(document.body.appendChild(document.createElement('div')), { state });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor)));
}

/** Press keys one at a time; returns whether the LAST one was consumed. */
function press(keys: string | string[]): boolean {
  let consumed = false;
  for (const key of keys) {
    const event = new KeyboardEvent('keydown', { key });
    consumed = view.someProp('handleKeyDown', (f) => f(view, event)) === true;
  }
  return consumed;
}

const paragraphs = (): string[] => {
  const out: string[] = [];
  view.state.doc.forEach((n) => out.push(n.textContent));
  return out;
};

/** The text carrying mark `name`, with '|' between separate stretches. */
function marked(name: string): string {
  let out = '';
  let end = -1;
  view.state.doc.descendants((n, pos) => {
    if (!n.isText || !n.marks.some((m) => m.type.name === name)) return;
    out += (end === -1 || end === pos ? '' : '|') + n.text!;
    end = pos + n.nodeSize;
  });
  return out;
}

beforeAll(() => toggleVimMode()); // off by default
describe('parseKeys', () => {
  it('waits for the rest of a command and rejects non-commands', () => {
    expect(parseKeys('d', false)).toBe('more');
    expect(parseKeys('2', false)).toBe('more');
    expect(parseKeys('gh', false)).toBe('more');
    expect(parseKeys('ghi', false)).toBe('more');
    expect(parseKeys('dq', false)).toBe('bad');
    expect(parseKeys('q', false)).toBe('bad');
  });

  it('reads a leading 0 as a motion but a later 0 as a count digit', () => {
    expect(parseKeys('0', false)).toEqual({ count: 1, motion: '0' });
    expect(parseKeys('10l', false)).toEqual({ count: 10, motion: 'l' });
    expect(parseKeys('2d3w', false)).toEqual({ count: 6, op: 'd', motion: 'w' });
  });

  it('keeps an operator letter that is also a motion as the motion', () => {
    expect(parseKeys('gee', false)).toEqual({ count: 1, op: 'ge', motion: 'e' });
    expect(parseKeys('gege', false)).toEqual({ count: 1, op: 'ge', line: true });
    expect(parseKeys('ghh', false)).toEqual({ count: 1, op: 'gh', motion: 'h' });
    expect(parseKeys('gg', false)).toEqual({ count: 1, motion: 'gg' });
  });

  it('applies an operator immediately in visual mode', () => {
    expect(parseKeys('gh', true)).toEqual({ count: 1, op: 'gh' });
    expect(parseKeys('iw', true)).toEqual({ count: 1, object: 'iw' });
  });
});

// Module-global mode: leave every test in normal mode.
const teardown = (): void => {
  press(['Escape', 'Escape']);
  view.destroy();
};

describe('normal mode', () => {
  afterEach(teardown);

  it('swallows typing and moves by word across paragraphs', () => {
    setup(['one two', 'three']);
    expect(press('z')).toBe(true);
    expect(paragraphs()).toEqual(['one two', 'three']);
    press('w');
    expect(view.state.selection.head).toBe(5);
    press('w');
    expect(view.state.selection.$head.parent.textContent).toBe('three');
    press('b');
    expect(view.state.selection.head).toBe(5);
  });

  it('leaves modifier chords alone', () => {
    setup(['one']);
    const event = new KeyboardEvent('keydown', { key: 'b', metaKey: true });
    expect(view.someProp('handleKeyDown', (f) => f(view, event))).toBeUndefined();
  });

  it('deletes with operator + motion, text object, and count', () => {
    setup(['one two three four']);
    press('dw');
    expect(paragraphs()).toEqual(['two three four']);
    press('wdiw');
    expect(paragraphs()).toEqual(['two  four']);
    press('0de');
    expect(paragraphs()).toEqual(['  four']);
    press('3x');
    expect(paragraphs()).toEqual(['our']);
  });

  it('does not delete past the end of the paragraph', () => {
    setup(['one two', 'three'], 5);
    press('dw');
    expect(paragraphs()).toEqual(['one ', 'three']);
    press('dfz'); // no z: nothing happens
    expect(paragraphs()).toEqual(['one ', 'three']);
  });

  it('dd removes the paragraph and p puts it back below', () => {
    setup(['one', 'two', 'three']);
    press('ddp');
    expect(paragraphs()).toEqual(['two', 'one', 'three']);
    press('2ddP'); // cuts one + three, lands on two, puts them above it
    expect(paragraphs()).toEqual(['one', 'three', 'two']);
  });

  it('yanks and puts text within a paragraph', () => {
    setup(['one two']);
    press('yiw$p');
    expect(paragraphs()).toEqual(['one twoone']);
  });

  it('applies formatting operators over a motion or text object', () => {
    setup(['one two three. four five.']);
    press('wghiw');
    expect(marked('highlight')).toBe('two');
    expect(view.state.selection.empty).toBe(true);
    press('0guis');
    expect(marked('underline_mark')).toBe('one two three.');
    press('$bgbb'); // from the final period, back one word
    expect(marked('emphasis_mark')).toBe('five');
  });

  it('repeats the last change with .', () => {
    setup(['one two three']);
    press('ghiwww.');
    expect(marked('highlight')).toBe('one|three');
  });
});

describe('insert and visual modes', () => {
  afterEach(teardown);

  it('passes typing through in insert mode until Escape', () => {
    setup(['one two']);
    press('ciw');
    expect(paragraphs()).toEqual([' two']);
    expect(press('x')).toBe(false); // the editor types it
    expect(press(['Escape'])).toBe(true);
    press('x');
    expect(paragraphs()).toEqual(['two']);
  });

  it('visual mode includes the character under the cursor', () => {
    setup(['one two']);
    press('ved');
    expect(paragraphs()).toEqual([' two']);
  });

  it('formats a visual selection and returns to normal mode', () => {
    setup(['one two', 'three']);
    press('wviwgu');
    expect(marked('underline_mark')).toBe('two');
    expect(view.state.selection.empty).toBe(true);
    press('Vjgh'); // whole paragraphs, whatever the cursor column
    expect(marked('highlight')).toBe('one two|three');
  });

  it('treats an existing selection as a visual selection', () => {
    setup(['one two']);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)));
    press('gh');
    expect(marked('highlight')).toBe('one');
  });
});
