// @vitest-environment jsdom
/**
 * Nav width is per-window (field request 2026-07-15): the `navWidth`
 * setting seeds `--nav-width` ONCE at window boot and records the
 * default for future windows; a settings change (which is how another
 * window's drag arrives, via the cross-window storage sync) must NOT
 * resize this window, and neither may a late panel construction
 * (multi-pane creates panels per opened doc).
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';

const navWidthVar = (): string =>
  document.documentElement.style.getPropertyValue('--nav-width');

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text('body')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}

describe('nav width is per-window', () => {
  it('module init seeded the CSS var from the setting', () => {
    // The import applied SOME clamped pixel value — the seed ran.
    expect(navWidthVar()).toMatch(/^\d+px$/);
  });

  it("a settings change (another window's drag) does not resize this window", () => {
    const before = navWidthVar();
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view); // live subscriber installed
    settings.set('navWidth', 555); // what a cross-window sync delivers
    expect(navWidthVar()).toBe(before);
    panel.destroy();
    view.destroy();
    settings.set('navWidth', 300);
  });

  it('late panel construction does not re-pull the setting (multi-pane leak guard)', () => {
    const before = navWidthVar();
    settings.set('navWidth', 444);
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div')); // a new pane opening
    panel.attach(view);
    expect(navWidthVar()).toBe(before);
    panel.destroy();
    view.destroy();
    settings.set('navWidth', 300);
  });
});
