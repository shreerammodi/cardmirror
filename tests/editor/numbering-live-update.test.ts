// @vitest-environment jsdom
/**
 * Numbering glyphs must re-render when a display setting changes — the widget
 * decoration key includes the RENDERED glyph, so a separator/capitalization
 * change busts it (field bug 2026-07-11: same key → PM reused the stale DOM,
 * so appearance only updated after toggling numbering).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { cardNumberingPlugin, NUMBERING_REFRESH } from '../../src/editor/numbering-plugin.js';
import { settings } from '../../src/editor/settings.js';

function numberedCard(tagText: string, role: 'number' | 'sub'): PMNode {
  return schema.nodes['card']!.create({ numRole: role }, [
    schema.nodes['tag']!.create(null, schema.text(tagText)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function mkView(doc: PMNode): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({ doc, plugins: [cardNumberingPlugin] }),
  });
}
function glyphText(view: EditorView): string {
  return view.dom.querySelector('.pmd-card-number')?.textContent ?? '';
}
function refresh(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(NUMBERING_REFRESH, true));
}

let restore: Array<() => void> = [];
afterEach(() => {
  restore.forEach((r) => r());
  restore = [];
});

describe('numbering live update on setting change', () => {
  it('number separator change re-renders the glyph', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingFormat', 'period');
    const v = mkView(schema.nodes['doc']!.create(null, [numberedCard('FIRST', 'number')]));
    expect(glyphText(v)).toBe('1.');
    settings.set('cardNumberingFormat', 'paren');
    refresh(v);
    expect(glyphText(v)).toBe('1)'); // was stuck at '1.' before the key fix
    v.destroy();
  });

  it('substructure capitalization change re-renders the glyph', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingSubFormat', 'paren');
    settings.set('cardNumberingSubCapitalized', false);
    const v = mkView(schema.nodes['doc']!.create(null, [numberedCard('SUB', 'sub')]));
    expect(glyphText(v)).toBe('a)');
    settings.set('cardNumberingSubCapitalized', true);
    refresh(v);
    expect(glyphText(v)).toBe('A)');
    v.destroy();
  });
});

function glyphEl(view: EditorView): HTMLElement | null {
  return view.dom.querySelector('.pmd-card-number');
}
function coloredCard(runs: Array<[string, string | null]>): PMNode {
  const fc = schema.marks['font_color']!;
  const content = runs.map(([text, hex]) =>
    hex ? schema.text(text, [fc.create({ color: hex })]) : schema.text(text),
  );
  return schema.nodes['card']!.create({ numRole: 'number' }, [
    schema.nodes['tag']!.create(null, content),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}

describe('display-off gate (perf audit A-02)', () => {
  it('with numbering off, the plugin STATE holds no decorations and edits never build', () => {
    settings.set('showCardNumbering', false);
    const v = mkView(schema.nodes['doc']!.create(null, [numberedCard('FIRST', 'number')]));
    const state = () => cardNumberingPlugin.getState(v.state)!;
    expect(state().decorations.find().length).toBe(0);
    // A doc-changing transaction must not rebuild while the display is off.
    v.dispatch(v.state.tr.insertText('x', 3));
    expect(state().decorations.find().length).toBe(0);
    expect(glyphText(v)).toBe('');
    v.destroy();
  });

  it('flipping the display on rebuilds via NUMBERING_REFRESH (the subscribers dispatch it)', () => {
    settings.set('showCardNumbering', false);
    settings.set('cardNumberingFormat', 'period');
    const v = mkView(schema.nodes['doc']!.create(null, [numberedCard('FIRST', 'number')]));
    expect(glyphText(v)).toBe('');
    settings.set('showCardNumbering', true);
    refresh(v); // what index.ts / the multi-pane shell dispatch on the sig change
    expect(glyphText(v)).toBe('1.');
    v.destroy();
  });

  it('flipping the display off drops the stale set on the refresh nudge', () => {
    settings.set('showCardNumbering', true);
    const v = mkView(schema.nodes['doc']!.create(null, [numberedCard('FIRST', 'number')]));
    expect(cardNumberingPlugin.getState(v.state)!.decorations.find().length).toBeGreaterThan(0);
    settings.set('showCardNumbering', false);
    refresh(v);
    expect(cardNumberingPlugin.getState(v.state)!.decorations.find().length).toBe(0);
    expect(glyphText(v)).toBe('');
    v.destroy();
  });
});

describe('match-heading numbering color', () => {
  it('off → token class only, no inline color', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingMatchHeadingColor', false);
    const v = mkView(schema.nodes['doc']!.create(null, [coloredCard([['ALL RED', 'aa0000']])]));
    const g = glyphEl(v)!;
    expect(g.classList.contains('pmd-card-number-match')).toBe(false);
    expect(g.style.color).toBe('');
    v.destroy();
  });

  it('on + whole heading one manual color → glyph takes that color', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingMatchHeadingColor', true);
    const v = mkView(schema.nodes['doc']!.create(null, [coloredCard([['ALL RED', 'aa0000']])]));
    const g = glyphEl(v)!;
    expect(g.classList.contains('pmd-card-number-match')).toBe(true);
    expect(g.style.color).toBe('rgb(170, 0, 0)');
    v.destroy();
  });

  it('on + PARTIAL manual color → glyph inherits (no inline color)', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingMatchHeadingColor', true);
    const v = mkView(
      schema.nodes['doc']!.create(null, [coloredCard([['RED ', 'aa0000'], ['PLAIN', null]])]),
    );
    const g = glyphEl(v)!;
    expect(g.classList.contains('pmd-card-number-match')).toBe(true);
    expect(g.style.color).toBe('');
    v.destroy();
  });

  it('on + uncolored heading → inherit; 000000 (Automatic) never counts', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingMatchHeadingColor', true);
    for (const runs of [[['PLAIN', null]], [['AUTO', '000000']]] as Array<
      Array<[string, string | null]>
    >) {
      const v = mkView(schema.nodes['doc']!.create(null, [coloredCard(runs)]));
      const g = glyphEl(v)!;
      expect(g.style.color).toBe('');
      v.destroy();
    }
  });

  it('toggling the setting re-renders live (key busts on color mode)', () => {
    settings.set('showCardNumbering', true);
    settings.set('cardNumberingMatchHeadingColor', false);
    const v = mkView(schema.nodes['doc']!.create(null, [coloredCard([['ALL RED', 'aa0000']])]));
    expect(glyphEl(v)!.style.color).toBe('');
    settings.set('cardNumberingMatchHeadingColor', true);
    refresh(v);
    expect(glyphEl(v)!.style.color).toBe('rgb(170, 0, 0)');
    v.destroy();
  });
});
