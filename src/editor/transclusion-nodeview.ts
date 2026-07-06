/**
 * Read-only NodeView for a transclusion "live zone" (TRANSCLUSION_PLAN.md §4).
 *
 * Renders the cached fragment read-only behind a left gutter rail (the reused
 * card-unit rail grammar, persistent, in --pmd-c-transclusion) with a link
 * glyph at its head and a reveal-on-hover header bar (breadcrumb, synced date,
 * Refresh / Detach). Nested zones render recursively with a depth cap and a
 * cycle guard. The node is an atom, so the caret never enters and PM manages
 * selection over the whole zone as a unit.
 */
import { DOMSerializer, Fragment } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { icon, type IconName } from './icons.js';
import { showToast } from './toast.js';
import {
  TRANSCLUSION_NODE,
  MAX_NEST_DEPTH,
  fragmentFromCache,
  zoneIdentity,
} from './transclusion.js';
import { refreshZoneAtPos, detachZoneAtPos } from './transclusion-actions.js';
import { transclusionSupported, refreshFailMessage } from './transclusion-resolve.js';

interface RenderCtx {
  depth: number;
  ancestors: Set<string>;
}

function placeholderEl(kind: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pmd-transclusion-placeholder';
  el.setAttribute('data-kind', kind);
  el.textContent = text;
  return el;
}

function railGlyph(): HTMLElement {
  const g = icon('link', { label: 'Live zone' });
  g.classList.add('pmd-transclusion-glyph');
  return g;
}

/** Render a fragment into `target`, intercepting nested zones for guarded
 *  recursion and serializing everything else via the schema's toDOM. */
function renderFragmentInto(
  target: HTMLElement,
  schema: EditorView['state']['schema'],
  frag: Fragment,
  ctx: RenderCtx,
): void {
  const serializer = DOMSerializer.fromSchema(schema);
  frag.forEach((node) => {
    if (node.type.name === TRANSCLUSION_NODE) {
      target.appendChild(renderNestedZone(schema, node, ctx));
    } else {
      target.appendChild(serializer.serializeNode(node));
    }
  });
}

function renderNestedZone(
  schema: EditorView['state']['schema'],
  node: PMNode,
  ctx: RenderCtx,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-transclusion pmd-transclusion-nested';
  wrap.appendChild(railGlyph());

  const id = zoneIdentity(node);
  if (ctx.ancestors.has(id)) {
    wrap.appendChild(placeholderEl('cycle', 'Live zone not expanded (cycle).'));
    return wrap;
  }
  if (ctx.depth >= MAX_NEST_DEPTH) {
    wrap.appendChild(placeholderEl('depth', 'Live zone not expanded (nesting too deep).'));
    return wrap;
  }
  const body = document.createElement('div');
  body.className = 'pmd-transclusion-body';
  const inner = fragmentFromCache(schema, node.attrs['cached_content']);
  if (inner.size === 0) {
    body.appendChild(placeholderEl('empty', 'Empty live zone.'));
  } else {
    renderFragmentInto(body, schema, inner, {
      depth: ctx.depth + 1,
      ancestors: new Set([...ctx.ancestors, id]),
    });
  }
  wrap.appendChild(body);
  return wrap;
}

/**
 * Populate `target` with a zone's cached content, read-only, applying the
 * nested-zone depth cap and cycle guard. Returns whether the zone is empty.
 * Exported so the rendering + guards can be unit-tested without an EditorView.
 */
export function populateZoneBody(
  target: HTMLElement,
  schema: EditorView['state']['schema'],
  node: PMNode,
): boolean {
  target.replaceChildren();
  const frag = fragmentFromCache(schema, node.attrs['cached_content']);
  if (frag.size === 0) {
    target.appendChild(
      placeholderEl('empty', 'This live zone is empty — nothing under the source heading yet.'),
    );
    return true;
  }
  renderFragmentInto(target, schema, frag, {
    depth: 0,
    ancestors: new Set([zoneIdentity(node)]),
  });
  return false;
}

function formatSyncedDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'earlier';
  }
}

class TransclusionView implements NodeView {
  readonly dom: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private statusEl: HTMLElement | null = null;
  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private busy = false;
  private transient: 'unreachable' | 'web' | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'pmd-transclusion';
    this.dom.setAttribute('contenteditable', 'false');

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'pmd-transclusion-header';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'pmd-transclusion-body';
    this.dom.appendChild(this.headerEl);
    this.dom.appendChild(this.bodyEl);

    this.renderHeader();
    this.renderBody();
  }

  private renderHeader(): void {
    this.headerEl.replaceChildren();
    this.headerEl.appendChild(railGlyph());

    const crumb = document.createElement('span');
    crumb.className = 'pmd-transclusion-crumb';
    crumb.textContent = String(this.node.attrs['source_label'] || 'Live zone');
    this.headerEl.appendChild(crumb);

    const status = document.createElement('span');
    status.className = 'pmd-transclusion-status';
    this.statusEl = status;
    this.headerEl.appendChild(status);
    this.refreshStatusText();

    const actions = document.createElement('div');
    actions.className = 'pmd-transclusion-actions';
    actions.appendChild(this.actionButton('reset', 'Refresh from source', () => this.onRefresh()));
    actions.appendChild(this.actionButton('edit', 'Detach to editable copy', () => this.onDetach()));
    this.headerEl.appendChild(actions);
  }

  private renderBody(): void {
    const empty = populateZoneBody(this.bodyEl, this.view.state.schema, this.node);
    this.dom.classList.toggle('pmd-transclusion-is-empty', empty);
  }

  private refreshStatusText(): void {
    if (!this.statusEl) return;
    let text: string;
    let state = 'ok';
    if (this.busy) {
      text = 'refreshing…';
      state = 'busy';
    } else if (this.transient === 'unreachable') {
      text = 'source not found · cached';
      state = 'unreachable';
    } else if (this.transient === 'web') {
      text = 'refresh on desktop';
      state = 'web';
    } else {
      const lr = Number(this.node.attrs['last_refreshed'] ?? 0);
      text = lr > 0 ? `synced ${formatSyncedDate(lr)}` : 'not yet refreshed';
    }
    this.statusEl.textContent = text;
    this.dom.setAttribute('data-status', state);
  }

  private actionButton(iconName: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-transclusion-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(icon(iconName));
    // Keep PM from treating the click as a selection gesture.
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

  private onRefresh(): void {
    const pos = this.getPos();
    if (pos == null) return;
    if (!transclusionSupported()) {
      this.transient = 'web';
      this.refreshStatusText();
      showToast(refreshFailMessage('not-desktop'));
      return;
    }
    this.busy = true;
    this.transient = null;
    this.refreshStatusText();
    void refreshZoneAtPos(this.view, pos).then((outcome) => {
      this.busy = false;
      if (outcome.ok) {
        this.transient = null;
        // The dispatch already fired update() → the body + synced date are fresh.
        this.refreshStatusText();
      } else {
        this.transient = outcome.reason === 'not-desktop' ? 'web' : 'unreachable';
        this.refreshStatusText();
        showToast(refreshFailMessage(outcome.reason));
      }
    });
  }

  private onDetach(): void {
    const pos = this.getPos();
    if (pos == null) return;
    detachZoneAtPos(this.view, pos);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const contentChanged =
      node.attrs['content_hash'] !== this.node.attrs['content_hash'] ||
      node.attrs['cached_content'] !== this.node.attrs['cached_content'];
    const labelChanged = node.attrs['source_label'] !== this.node.attrs['source_label'];
    this.node = node;
    // A refresh landed (locally or from a co-editing peer) — clear any stale
    // transient error and re-render what changed.
    if (contentChanged) {
      this.transient = null;
      this.renderBody();
    }
    if (contentChanged || labelChanged) this.renderHeader();
    else this.refreshStatusText();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** Keep events on our own chrome (the header buttons) away from PM. */
  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest?.('.pmd-transclusion-header');
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    /* listeners are on elements we drop with the DOM */
  }
}

/** NodeView factory map — merged into the editor's `nodeViews`. */
export const transclusionNodeViews = {
  transclusion_ref: (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => new TransclusionView(node, view, getPos),
};
