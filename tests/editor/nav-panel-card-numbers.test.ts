// @vitest-environment jsdom

/**
 * Card numbers in the nav pane — the editor's numbering pass mirrored onto
 * the outline rows (field request 2026-07-13: the numbering toggle affected
 * the editor but not the nav). Each numbered card/analytic_unit's FIRST
 * heading row carries the computed glyph; display follows the same
 * `showCardNumbering` gate and format settings as the editor, via the nav's
 * own settings subscriber (no explicit re-render call needed on a toggle).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';
import type { NumRole } from '../../src/editor/numbering.js';

function card(tag: string, role: NumRole = 'none', restart = false): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function analytic(tag: string, role: NumRole = 'none'): PMNode {
  return schema.nodes['analytic_unit']!.createChecked({ numRole: role }, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}

function setup(...children: PMNode[]) {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state: EditorState.create({ doc }) });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  nav.update(view.state.doc);
  return { view, nav };
}

/** [rowLabelText, glyphText|null] per rendered nav row, in order. */
function rows(nav: NavigationPanel): Array<[string, string | null]> {
  const root = (nav as unknown as Record<string, unknown>)['listEl'] as HTMLElement;
  return [...root.querySelectorAll('.pmd-nav-item')].map((li) => [
    li.querySelector('.pmd-nav-label')?.textContent ?? '',
    li.querySelector('.pmd-nav-card-number')?.textContent ?? null,
  ]);
}

afterEach(() => {
  // The suite flips display settings; restore the defaults for neighbors.
  settings.set('showCardNumbering', true);
  settings.set('cardNumberingFormat', 'period');
});

describe('NavigationPanel — card number glyphs', () => {
  it('numbered rows carry the computed glyph; skipped cards stay bare', () => {
    const { view, nav } = setup(
      card('First', 'number'),
      card('Skip'),
      card('Second', 'number'),
      analytic('Sub under second', 'sub'),
    );
    expect(rows(nav)).toEqual([
      ['First', '1.'],
      ['Skip', null],
      ['Second', '2.'],
      // Note the default separators differ by kind: number `period`, sub `paren`.
      ['Sub under second', 'a)'],
    ]);
    view.destroy();
  });

  it('the display toggle removes / restores glyphs through the nav settings subscriber alone', () => {
    const { view, nav } = setup(card('Only', 'number'));
    expect(rows(nav)).toEqual([['Only', '1.']]);
    // No nav.update() calls — the panel's own subscriber must re-render.
    settings.set('showCardNumbering', false);
    expect(rows(nav)).toEqual([['Only', null]]);
    settings.set('showCardNumbering', true);
    expect(rows(nav)).toEqual([['Only', '1.']]);
    view.destroy();
  });

  it('a format change re-renders glyphs through the subscriber', () => {
    const { view, nav } = setup(card('Only', 'number'));
    settings.set('cardNumberingFormat', 'paren');
    expect(rows(nav)).toEqual([['Only', '1)']]);
    view.destroy();
  });
});
