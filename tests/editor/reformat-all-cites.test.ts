// @vitest-environment jsdom
/**
 * Reformat Every Cite (AI) — the whole-document sweep over the cite
 * creator.
 *
 * The load-bearing invariant is the cursor walk: the pass re-scans the
 * LIVE doc for the next `cite_paragraph` each iteration instead of
 * caching positions, because a rewritten cite changes length and can
 * even stop being a `cite_paragraph` (the classifier demotes a cite
 * whose author/date token found no home). Both cases would break a
 * precomputed position list or an ordinal index, and both are covered
 * here — every cite is visited exactly once, none twice, none skipped.
 *
 * `runReformatAllCites` returns the pass promise, so every assertion
 * below awaits the real completion instead of a timer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import { editCoordinatorPlugin, claimRegion } from '../../src/editor/ai/edit-coordinator.js';
import { citeClassifierPlugin } from '../../src/editor/cite-classifier-plugin.js';
import { LlmError, type LlmRequest, type LlmReply } from '../../src/editor/ai/llm.js';
import type { ConfirmOptions } from '../../src/editor/confirm-dialog.js';
import type { ToastOptions } from '../../src/editor/toast.js';
import {
  collectCiteParagraphs,
  nextCiteParagraph,
  runReformatAllCites,
} from '../../src/editor/ai/reformat-all-cites.js';

const callLlm = vi.fn<(req: LlmRequest) => Promise<LlmReply>>();
const showConfirm = vi.fn<(opts: ConfirmOptions) => Promise<boolean>>();
const showToast = vi.fn<(message: string, opts?: ToastOptions) => void>();

vi.mock('../../src/editor/ai/llm.js', async (importOriginal) => ({
  // Keep the real LlmError / settings-driven helpers; swap the network call
  // and the key lookup.
  ...(await importOriginal<typeof import('../../src/editor/ai/llm.js')>()),
  callLlm: (req: LlmRequest) => callLlm(req),
  activeApiKey: () => 'test-key',
}));
vi.mock('../../src/editor/confirm-dialog.js', () => ({
  showConfirm: (opts: ConfirmOptions) => showConfirm(opts),
}));
vi.mock('../../src/editor/toast.js', () => ({
  showToast: (...args: Parameters<typeof showToast>) => showToast(...args),
}));

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const citeMark = schema.marks['cite_mark']!.create();
/** A cite paragraph: `marked` is the substring wearing `cite_mark` — the
 *  classifier keys cite-ness off the mark, so an unmarked paragraph
 *  wouldn't stay a `cite_paragraph`. */
const cite = (marked: string, rest: string) =>
  schema.nodes['cite_paragraph']!.create(null, [
    schema.text(marked, [citeMark]),
    schema.text(rest),
  ]);
const card = (...kids: PMNode[]) => schema.nodes['card']!.create(null, kids);
const doc = (...kids: PMNode[]) => schema.nodes['doc']!.createChecked(null, kids);

/** Minimal EditorView stand-in — the pass touches `.state`, `.dispatch`,
 *  `.isDestroyed` and (through the activity cues) `.dom`. dispatch runs
 *  the real apply pipeline so the coordinator's filterTransaction and the
 *  cite classifier both fire. */
interface FakeView {
  state: EditorState;
  isDestroyed: boolean;
  dom: HTMLElement;
  dispatch(tr: unknown): void;
}
function fakeView(d: PMNode): EditorView & FakeView {
  const v: FakeView = {
    state: EditorState.create({
      doc: d,
      plugins: [editCoordinatorPlugin, citeClassifierPlugin],
    }),
    isDestroyed: false,
    dom: document.createElement('div'),
    dispatch(tr) {
      // A fake view only ever receives transactions from the code under
      // test, which builds them off this very state.
      const step = tr as Parameters<EditorState['apply']>[0];
      v.state = v.state.apply(step);
    },
  };
  // Deliberate stand-in: the pass reads four members, and the DOM-facing
  // cues degrade to no-ops without real geometry (`rangeRect` returns
  // null when `coordsAtPos` isn't there).
  return v as unknown as EditorView & FakeView;
}

function reply(citeText: string, tokens: string[]): LlmReply {
  return { text: `[[CITE]]\n${citeText}\n[[TOKENS]]\n${tokens.join('\n')}\n[[END]]` };
}

/** Every cite_paragraph's text in the doc, in order. */
function citeTexts(d: PMNode): string[] {
  const out: string[] = [];
  d.descendants((n) => {
    if (n.type.name !== 'cite_paragraph') return true;
    out.push(n.textContent);
    return false;
  });
  return out;
}

/** The user text of every request the pass made, in order. */
function sentTexts(): string[] {
  return callLlm.mock.calls.map(([req]) => {
    const content = req.messages[0]!.content;
    return typeof content === 'string' ? content : '';
  });
}

/** The pass's end-of-run summary toast. */
function summary(): string | undefined {
  return showToast.mock.calls.map(([m]) => m).find((m) => m.startsWith('Reformatted'));
}

/** Route each request to a canned reply, keyed by the lastname the sent
 *  cite starts with. Every fixture cite is `Lastname NN, …` and every
 *  reply keeps that head, so the [[TOKENS]] line is its first two words.
 *  Throws on an unexpected request — a cite sent twice or out of order
 *  must fail the test, not silently reuse a reply. */
function replyPerLastname(replies: Record<string, string>) {
  return async (req: LlmRequest): Promise<LlmReply> => {
    const content = req.messages[0]!.content;
    const sent = typeof content === 'string' ? content : '';
    const lastname = Object.keys(replies).find((k) => sent.startsWith(k));
    if (!lastname) throw new Error(`unexpected request: ${sent}`);
    const citeText = replies[lastname]!;
    return reply(citeText, [citeText.split(' ').slice(0, 2).join(' ')]);
  };
}

beforeEach(() => {
  callLlm.mockReset();
  showConfirm.mockReset();
  showToast.mockReset();
  showConfirm.mockResolvedValue(true);
  settings.set('aiFeaturesEnabled', true);
  settings.set('aiCitePrompt', '');
});

describe('collectCiteParagraphs', () => {
  it('finds every cite paragraph in document order, across containers', () => {
    const d = doc(
      card(tag('A'), cite('Smith 24', ', first'), body('body')),
      schema.nodes['analytic_unit']!.create(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('AN')),
        cite('Jones 23', ', second'),
      ]),
      cite('Lee 22', ', third'),
    );
    expect(collectCiteParagraphs(d).map((t) => t.text)).toEqual([
      'Smith 24, first',
      'Jones 23, second',
      'Lee 22, third',
    ]);
  });

  it('skips a blank cite paragraph — there is nothing to reformat', () => {
    const d = doc(
      card(tag('A'), schema.nodes['cite_paragraph']!.create(), cite('Smith 24', ', x')),
    );
    expect(collectCiteParagraphs(d).map((t) => t.text)).toEqual(['Smith 24, x']);
  });

  it('reports inline content bounds, not node bounds', () => {
    const d = doc(cite('Smith 24', ', x'));
    const t = collectCiteParagraphs(d)[0]!;
    expect(t.from).toBe(t.pos + 1);
    expect(d.textBetween(t.from, t.to)).toBe('Smith 24, x');
  });
});

describe('nextCiteParagraph', () => {
  const d = doc(cite('Smith 24', ', one'), body('x'), cite('Jones 23', ', two'));
  const targets = collectCiteParagraphs(d);

  it('returns the first cite at or after the cursor', () => {
    expect(nextCiteParagraph(d, 0)!.text).toBe('Smith 24, one');
    expect(nextCiteParagraph(d, targets[0]!.to)!.text).toBe('Jones 23, two');
  });

  it('returns null once the cursor is past the last cite', () => {
    expect(nextCiteParagraph(d, targets[1]!.to)).toBeNull();
  });
});

describe('runReformatAllCites', () => {
  it('does not even confirm when the document has no cites', async () => {
    await runReformatAllCites(fakeView(doc(card(tag('A'), body('no cites here')))));
    expect(showConfirm).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('No cites in this document.');
  });

  it('refuses to run with AI features off', async () => {
    settings.set('aiFeaturesEnabled', false);
    await runReformatAllCites(fakeView(doc(card(tag('A'), cite('Smith 24', ', a')))));
    expect(showConfirm).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('states the request count in the confirm prompt and runs nothing if declined', async () => {
    showConfirm.mockResolvedValue(false);
    const view = fakeView(
      doc(card(tag('A'), cite('Smith 24', ', a')), card(tag('B'), cite('Jones 23', ', b'))),
    );
    await runReformatAllCites(view);

    expect(showConfirm).toHaveBeenCalledTimes(1);
    const opts = showConfirm.mock.calls[0]![0];
    expect(opts.message).toContain('2 cites');
    expect(opts.message).toContain('2 model requests');
    expect(opts.confirmLabel).toBe('Reformat 2 cites');
    expect(callLlm).not.toHaveBeenCalled();
    expect(citeTexts(view.state.doc)).toEqual(['Smith 24, a', 'Jones 23, b']);
  });

  it('sends each cite once and rewrites it in place', async () => {
    const view = fakeView(
      doc(
        card(tag('A'), cite('Smith 24', ', old a'), body('body a')),
        card(tag('B'), cite('Jones 23', ', old b')),
      ),
    );
    callLlm.mockImplementation(
      replyPerLastname({
        Smith: 'Smith 24, NEW A, Journal.',
        Jones: 'Jones 23, NEW B, Journal.',
      }),
    );

    await runReformatAllCites(view);

    expect(sentTexts()).toEqual(['Smith 24, old a', 'Jones 23, old b']);
    expect(citeTexts(view.state.doc)).toEqual([
      'Smith 24, NEW A, Journal.',
      'Jones 23, NEW B, Journal.',
    ]);
    // No stray paragraph split off the cite, and body text is untouched.
    expect(view.state.doc.firstChild!.childCount).toBe(3);
    expect(view.state.doc.firstChild!.child(2).textContent).toBe('body a');
    expect(summary()).toBe('Reformatted 2 of 2 cites.');
  });

  it('keeps walking when a rewrite GROWS the cite — no cite is revisited', async () => {
    // Growth is what a cached-position walk gets wrong: rewriting the
    // first cite pushes every later cite forward in the doc.
    const long = ', '.padEnd(200, 'x');
    const view = fakeView(
      doc(card(tag('A'), cite('Smith 24', ', a')), card(tag('B'), cite('Jones 23', ', b'))),
    );
    callLlm.mockImplementation(
      replyPerLastname({ Smith: `Smith 24${long}`, Jones: `Jones 23${long}` }),
    );

    await runReformatAllCites(view);

    expect(sentTexts()).toEqual(['Smith 24, a', 'Jones 23, b']);
    expect(citeTexts(view.state.doc)).toEqual([`Smith 24${long}`, `Jones 23${long}`]);
  });

  it('keeps walking when a rewrite is DEMOTED out of cite_paragraph', async () => {
    // A token the model can't locate in its own cite leaves the paragraph
    // unmarked, so the classifier turns it into card_body. An ordinal
    // index over cite_paragraphs would then shift and skip a cite.
    const view = fakeView(
      doc(
        card(tag('A'), cite('Smith 24', ', a')),
        card(tag('B'), cite('Jones 23', ', b')),
        card(tag('C'), cite('Lee 22', ', c')),
      ),
    );
    callLlm.mockImplementation(async (req) => {
      const content = req.messages[0]!.content;
      const text = typeof content === 'string' ? content : '';
      if (text.startsWith('Smith')) return reply('Rewritten, no locatable token.', ['Nobody 99']);
      if (text.startsWith('Jones')) return reply('Jones 23, NEW B.', ['Jones 23']);
      return reply('Lee 22, NEW C.', ['Lee 22']);
    });

    await runReformatAllCites(view);

    expect(sentTexts()).toEqual(['Smith 24, a', 'Jones 23, b', 'Lee 22, c']);
    // The demoted paragraph is body text now; the other two stay cites.
    expect(view.state.doc.child(0).child(1).type.name).toBe('card_body');
    expect(view.state.doc.child(0).child(1).textContent).toBe('Rewritten, no locatable token.');
    expect(citeTexts(view.state.doc)).toEqual(['Jones 23, NEW B.', 'Lee 22, NEW C.']);
    expect(summary()).toContain('1 left unstyled');
  });

  it('skips a cite another AI edit already holds, and still does the rest', async () => {
    const view = fakeView(
      doc(card(tag('A'), cite('Smith 24', ', a')), card(tag('B'), cite('Jones 23', ', b'))),
    );
    const held = collectCiteParagraphs(view.state.doc)[0]!;
    expect(claimRegion(view, { from: held.from, to: held.to }, { label: 'other' })).not.toBeNull();
    callLlm.mockImplementation(replyPerLastname({ Jones: 'Jones 23, NEW B.' }));

    await runReformatAllCites(view);

    expect(sentTexts()).toEqual(['Jones 23, b']);
    expect(citeTexts(view.state.doc)).toEqual(['Smith 24, a', 'Jones 23, NEW B.']);
    expect(summary()).toContain('1 skipped (busy)');
  });

  it('a single failed cite does not abort the pass', async () => {
    const view = fakeView(
      doc(card(tag('A'), cite('Smith 24', ', a')), card(tag('B'), cite('Jones 23', ', b'))),
    );
    callLlm.mockImplementation(async (req) => {
      const content = req.messages[0]!.content;
      if (typeof content === 'string' && content.startsWith('Smith')) throw new Error('boom');
      return reply('Jones 23, NEW B.', ['Jones 23']);
    });

    await runReformatAllCites(view);

    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(citeTexts(view.state.doc)).toEqual(['Smith 24, a', 'Jones 23, NEW B.']);
    expect(summary()).toContain('1 failed');
  });

  it('stops the whole pass on an auth failure instead of repeating it per cite', async () => {
    const view = fakeView(
      doc(
        card(tag('A'), cite('Smith 24', ', a')),
        card(tag('B'), cite('Jones 23', ', b')),
        card(tag('C'), cite('Lee 22', ', c')),
      ),
    );
    callLlm.mockRejectedValue(new LlmError('bad key', 401, 'auth'));

    await runReformatAllCites(view);

    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(summary()).toBe('Reformatted 0 of 3 cites · 1 failed.');
  });
});
