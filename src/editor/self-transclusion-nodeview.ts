/**
 * NodeView for a `self_ref` — the intra-document live window.
 *
 * Renders a READ-ONLY projection of the mirrored source section (resolved live
 * from the current doc via `resolveSelfProjection`), plus a rail + glyph menu
 * (Jump to source / Re-pick / Unlink / Delete, with the mirrored-section
 * provenance shown at the top). Being an atom, the projected DOM is not
 * ProseMirror-managed content — you edit at the source, and the window re-renders
 * when the source changes (driven by the re-render plugin's decoration).
 */
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, Decoration } from 'prosemirror-view';
import { icon, type IconName } from './icons.js';
import { resolveSelfProjection } from './self-transclusion.js';
import {
  jumpToSelfRefSource,
  openRepickSelfRef,
  unlinkSelfRef,
  deleteSelfRef,
} from './self-transclusion-commands.js';
import { windowNumbering, createNumberGlyph } from './numbering-plugin.js';

class SelfRefView implements NodeView {
  readonly dom: HTMLElement;
  private readonly glyphBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly serializer: DOMSerializer;
  private menuEl: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.serializer = DOMSerializer.fromSchema(view.state.schema);

    this.dom = document.createElement('div');
    this.dom.className = 'pmd-self-ref';
    this.dom.setAttribute('contenteditable', 'false');
    // Deliberately NOT natively draggable (the schema spec isn't `draggable`), so
    // a text selection can be dragged straight through it. Moving a live view goes
    // through the same paths as any card: the editor pickup-chord and nav-pane row
    // drag, both of which build explicit move/copy transactions.

    this.glyphBtn = document.createElement('button');
    this.glyphBtn.type = 'button';
    this.glyphBtn.className = 'pmd-transclusion-glyph-btn pmd-self-ref-glyph';
    this.glyphBtn.setAttribute('contenteditable', 'false');
    this.glyphBtn.title = 'Live view — a read-only window onto another section of this document';
    this.glyphBtn.setAttribute('aria-label', 'Live view actions');
    this.glyphBtn.appendChild(icon('link'));
    this.glyphBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.glyphBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu();
    });

    this.body = document.createElement('div');
    this.body.className = 'pmd-self-ref-body';
    this.body.setAttribute('contenteditable', 'false');

    this.dom.appendChild(this.glyphBtn);
    this.dom.appendChild(this.body);
    this.renderProjection();
  }

  private headingId(): string {
    return String(this.node.attrs['source_heading_id'] ?? '');
  }

  /** Resolve the source now and (re)render its content read-only. */
  private renderProjection(): void {
    const { content, missing, cycle } = resolveSelfProjection(this.view.state.doc, this.headingId());
    this.body.replaceChildren();
    this.dom.classList.toggle('pmd-self-ref-missing', missing);
    this.dom.classList.toggle('pmd-self-ref-cycle', cycle);
    if (missing) {
      const note = document.createElement('div');
      note.className = 'pmd-self-ref-note';
      note.textContent = 'Source section not found in this document.';
      this.body.appendChild(note);
      return;
    }
    const dom = this.serializer.serializeFragment(content);
    // The projection is a COPY of live cards, so its DOM carries the source's
    // `data-id`s. Two elements with the same `data-id` break every
    // `[data-id="…"]` scroll lookup (nav jump, "Go to source") — they'd match
    // this read-only copy instead of the real source. Strip them: the window is
    // never itself a scroll target.
    dom.querySelectorAll('[data-id]').forEach((el) => el.removeAttribute('data-id'));
    // Auto-numbering (§7): the window flows through the host count, so its cards
    // carry HOST-positional numbers (the same source card shows different numbers
    // in different windows). The numbering plugin computes them; a `data-num-hash`
    // node decoration on this self_ref triggers `update()` when they change.
    const labels = windowNumbering(this.view.state, this.getPos() ?? -1);
    if (labels) {
      dom.querySelectorAll('.pmd-card, .pmd-analytic-unit').forEach((cardEl, i) => {
        const label = labels[i];
        if (!label) return;
        const tagEl = cardEl.querySelector(':scope > .pmd-tag, :scope > .pmd-analytic');
        if (tagEl) tagEl.insertBefore(createNumberGlyph(label), tagEl.firstChild);
      });
    }
    this.body.appendChild(dom);
    if (cycle) {
      const note = document.createElement('div');
      note.className = 'pmd-self-ref-note';
      note.textContent = '↻ A nested window pointed back here (cycle) and was left out.';
      this.body.appendChild(note);
    }
  }

  private sectionLabel(): string {
    return String(this.node.attrs['source_label'] ?? '').replace(/^↳\s*/, '') || 'Section';
  }

  private toggleMenu(): void {
    if (this.menuEl) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'pmd-transclusion-menu';
    menu.setAttribute('contenteditable', 'false');

    const info = document.createElement('div');
    info.className = 'pmd-transclusion-menu-info';
    const fileRow = document.createElement('div');
    fileRow.className = 'pmd-transclusion-menu-file';
    fileRow.appendChild(icon('link'));
    const fileText = document.createElement('span');
    fileText.textContent = 'This document';
    fileRow.appendChild(fileText);
    info.appendChild(fileRow);
    const secRow = document.createElement('div');
    secRow.className = 'pmd-transclusion-menu-section';
    secRow.textContent = this.sectionLabel();
    info.appendChild(secRow);
    const meta = document.createElement('div');
    meta.className = 'pmd-transclusion-menu-meta';
    const status = document.createElement('span');
    status.textContent = 'Live view of this document';
    meta.appendChild(status);
    info.appendChild(meta);
    menu.appendChild(info);

    const sep = document.createElement('div');
    sep.className = 'pmd-transclusion-menu-sep';
    menu.appendChild(sep);

    menu.appendChild(
      this.menuItem('bookmark', 'Go to source section', () => {
        this.closeMenu();
        jumpToSelfRefSource(this.view, this.headingId());
      }),
    );
    menu.appendChild(
      this.menuItem('search', 'Re-pick source…', () => {
        this.closeMenu();
        const pos = this.getPos();
        if (pos != null) openRepickSelfRef(this.view, pos);
      }),
    );
    menu.appendChild(
      this.menuItem('edit', 'Unlink (keep a copy)', () => {
        this.closeMenu();
        const pos = this.getPos();
        if (pos != null) unlinkSelfRef(this.view, pos);
      }),
    );
    menu.appendChild(
      this.menuItem('trash', 'Delete', () => {
        this.closeMenu();
        const pos = this.getPos();
        if (pos != null) deleteSelfRef(this.view, pos);
      }),
    );

    this.dom.appendChild(menu);
    this.menuEl = menu;
    this.dom.classList.add('pmd-transclusion-menu-open');
    setTimeout(() => {
      document.addEventListener('mousedown', this.onOutsidePointer, true);
      document.addEventListener('keydown', this.onMenuKey, true);
    }, 0);
  }

  private onOutsidePointer = (e: Event): void => {
    if (this.menuEl && !this.menuEl.contains(e.target as Node) && e.target !== this.glyphBtn) {
      this.closeMenu();
    }
  };
  private onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMenu();
    }
  };
  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    this.dom.classList.remove('pmd-transclusion-menu-open');
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    document.removeEventListener('keydown', this.onMenuKey, true);
  }

  private menuItem(iconName: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-transclusion-menu-item';
    btn.appendChild(icon(iconName));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  update(node: PMNode, _decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // Re-resolve + re-render: the node's own attrs may have changed (re-pick), or
    // a decoration fired because the mirrored source content changed (the plugin).
    this.closeMenu();
    this.renderProjection();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }
  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** Atom: PM never manages our DOM, so ignore all mutations. */
  ignoreMutation(): boolean {
    return true;
  }

  /** Keep glyph/menu clicks away from PM; let selection inside the read-only
   *  projection through so text is still selectable/copyable. */
  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest?.('.pmd-self-ref-glyph, .pmd-transclusion-menu');
  }

  destroy(): void {
    this.closeMenu();
  }
}

export const selfRefNodeViews = {
  self_ref: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SelfRefView(node, view, getPos),
};
