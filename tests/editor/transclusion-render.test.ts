// @vitest-environment jsdom
/**
 * Live-zone rendering + nested-zone guards (depth cap, cycle guard, empty,
 * malformed). Exercises populateZoneBody without a full EditorView.
 */
import { describe, expect, it } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { createTransclusionNode, MAX_NEST_DEPTH } from '../../src/editor/transclusion.js';
import { populateZoneBody } from '../../src/editor/transclusion-nodeview.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: `t-${tag}` }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zone(ref: string, hid: string, cache: unknown[] | null): PMNode {
  return createTransclusionNode(schema, {
    source_ref: ref,
    source_heading_id: hid,
    cached_content: cache,
  });
}
function render(node: PMNode): HTMLElement {
  const target = document.createElement('div');
  populateZoneBody(target, schema, node);
  return target;
}

describe('populateZoneBody — normal content', () => {
  it('renders the cached cards read-only', () => {
    const node = zone('a.cmir', 'h1', [card('Tag A', 'evidence A').toJSON(), card('Tag B', 'evidence B').toJSON()]);
    const el = render(node);
    expect(el.textContent).toContain('Tag A');
    expect(el.textContent).toContain('evidence A');
    expect(el.textContent).toContain('Tag B');
    expect(el.querySelectorAll('.pmd-card').length).toBe(2);
  });

  it('empty cache → empty placeholder, no crash', () => {
    const el = render(zone('a.cmir', 'h1', null));
    const ph = el.querySelector('.pmd-transclusion-placeholder[data-kind="empty"]');
    expect(ph).toBeTruthy();
  });

  it('malformed cache → empty placeholder, no throw', () => {
    const node = schema.nodes['transclusion_ref']!.create({
      cached_content: [{ type: 'no_such_node' }],
    });
    let el: HTMLElement;
    expect(() => {
      el = render(node);
    }).not.toThrow();
    // Unknown node dropped → fragment empty → empty placeholder.
    expect(el!.querySelector('[data-kind="empty"]')).toBeTruthy();
  });
});

describe('populateZoneBody — nested zone guards', () => {
  it('renders a nested zone', () => {
    const inner = zone('b.cmir', 'h2', [card('Inner Tag', 'inner ev').toJSON()]);
    const outer = zone('a.cmir', 'h1', [inner.toJSON()]);
    const el = render(outer);
    expect(el.querySelector('.pmd-transclusion-nested')).toBeTruthy();
    expect(el.textContent).toContain('inner ev');
  });

  it('cycle guard: a nested zone with the same identity is not expanded', () => {
    // Outer and its nested child share (ref, heading) → cycle.
    const selfRef = zone('a.cmir', 'h1', [card('CycleTag', 'CYCLEBODYMARKER').toJSON()]);
    const outer = zone('a.cmir', 'h1', [selfRef.toJSON()]);
    const el = render(outer);
    expect(el.querySelector('[data-kind="cycle"]')).toBeTruthy();
    // The self-referential content is NOT rendered.
    expect(el.textContent).not.toContain('CYCLEBODYMARKER');
  });

  it('depth cap: a chain deeper than MAX_NEST_DEPTH stops with a placeholder', () => {
    // Distinct identities so it's a depth case, not a cycle.
    let node = zone('f-leaf.cmir', 'h-leaf', [card('Leaf', 'leaf ev').toJSON()]);
    for (let i = MAX_NEST_DEPTH + 3; i >= 1; i--) {
      node = zone(`f${i}.cmir`, `h${i}`, [node.toJSON()]);
    }
    const el = render(node);
    expect(el.querySelector('[data-kind="depth"]')).toBeTruthy();
    // The deepest leaf is beyond the cap and never rendered.
    expect(el.textContent).not.toContain('leaf ev');
  });

  it('shallow nesting (within cap) fully expands', () => {
    let node = zone('leaf.cmir', 'hl', [card('Leaf', 'leaf ev').toJSON()]);
    for (let i = 2; i >= 1; i--) {
      node = zone(`f${i}.cmir`, `h${i}`, [node.toJSON()]);
    }
    const el = render(node);
    expect(el.textContent).toContain('leaf ev');
    expect(el.querySelector('[data-kind="depth"]')).toBeNull();
  });
});
