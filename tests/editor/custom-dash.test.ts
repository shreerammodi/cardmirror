import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { customDashPlugin, dashOutput } from '../../src/editor/custom-dash-plugin.js';
import { settings } from '../../src/editor/settings.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

function bodyText(d: PMNode): string {
  let out = '';
  d.descendants((node) => {
    if (node.type.name === 'card_body') out = node.textContent;
  });
  return out;
}

type Plugin = ReturnType<typeof customDashPlugin>;
type Props = {
  handleTextInput: (v: unknown, from: number, to: number, text: string) => boolean;
  handleKeyDown: (v: unknown, e: Record<string, unknown>) => boolean;
};

/** A live mini-editor over `body` with the cursor at the end of the card_body. */
function makeView(body: string) {
  const d = doc(card(tag('T'), cardBody(body)));
  const plugin = customDashPlugin();
  let state = EditorState.create({ doc: d, plugins: [plugin] });
  let end = 0;
  d.descendants((node, pos) => {
    if (node.type.name === 'card_body') end = pos + 1 + node.content.size;
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)));
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  };
  const props = plugin.props as unknown as Props;
  return {
    typeHyphen: () => {
      const from = view.state.selection.from;
      return props.handleTextInput(view, from, from, '-');
    },
    backspace: () =>
      props.handleKeyDown(view, {
        key: 'Backspace',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    body: () => bodyText(view.state.doc),
  };
}

function configure(enabled: boolean, style: 'en' | 'en-spaced' | 'em' | 'em-spaced' = 'em') {
  settings.set('customDashEnabled', enabled);
  settings.set('customDashStyle', style);
}

describe('dashOutput', () => {
  it('maps the style to its literal', () => {
    configure(true, 'en');
    expect(dashOutput()).toBe('–');
    configure(true, 'em-spaced');
    expect(dashOutput()).toBe(' — ');
  });
});

describe('custom dash plugin', () => {
  it('converts on the third hyphen (em dash)', () => {
    configure(true, 'em');
    const v = makeView('a--');
    expect(v.typeHyphen()).toBe(true);
    expect(v.body()).toBe('a—'); // three hyphens collapse to one em dash
  });

  it('converts to an en dash with surrounding spaces for a spaced style', () => {
    configure(true, 'en-spaced');
    const v = makeView('word--');
    expect(v.typeHyphen()).toBe(true);
    expect(v.body()).toBe('word – ');
  });

  it('Backspace immediately after reverts to the literal ---', () => {
    configure(true, 'em');
    const v = makeView('a--');
    v.typeHyphen();
    expect(v.body()).toBe('a—');
    expect(v.backspace()).toBe(true);
    expect(v.body()).toBe('a---');
  });

  it('does nothing when disabled', () => {
    configure(false);
    const v = makeView('a--');
    expect(v.typeHyphen()).toBe(false);
    expect(v.body()).toBe('a--'); // handler declined; default would insert the hyphen
  });

  it('does not fire on the second hyphen (only -- present)', () => {
    configure(true, 'em');
    const v = makeView('a-');
    expect(v.typeHyphen()).toBe(false);
  });

  it('does not fire without two preceding hyphens', () => {
    configure(true, 'em');
    expect(makeView('ab').typeHyphen()).toBe(false);
  });
});
