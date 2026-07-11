/**
 * `webSearch` flag on LlmRequest: maps to the Anthropic web_search
 * server tool / the OpenRouter web plugin. Asserted by capturing the
 * request body through a stubbed fetch (precedent: translate.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLlm } from '../../src/editor/ai/llm.js';
import { settings } from '../../src/editor/settings.js';

function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
}

const ANTHROPIC_REPLY = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const OPENROUTER_REPLY = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

afterEach(() => {
  vi.unstubAllGlobals();
  settings.set('aiProvider', 'anthropic');
  settings.set('openrouterModel', '');
});

describe('callLlm webSearch flag (Anthropic)', () => {
  it('adds the web_search server tool when set', async () => {
    const fetchMock = stubFetch(ANTHROPIC_REPLY);
    await callLlm({
      apiKey: 'sk-test',
      webSearch: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sentBody(fetchMock).tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ]);
  });

  it('sends no tools when the flag is off', async () => {
    const fetchMock = stubFetch(ANTHROPIC_REPLY);
    await callLlm({ apiKey: 'sk-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(sentBody(fetchMock)).not.toHaveProperty('tools');
  });
});

describe('callLlm webSearch flag (OpenRouter)', () => {
  it('adds the web plugin when set', async () => {
    settings.set('aiProvider', 'openrouter');
    settings.set('openrouterModel', 'anthropic/claude-sonnet-4.6');
    const fetchMock = stubFetch(OPENROUTER_REPLY);
    await callLlm({
      apiKey: 'sk-or-test',
      webSearch: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sentBody(fetchMock).plugins).toEqual([{ id: 'web' }]);
  });

  it('sends no plugins when the flag is off', async () => {
    settings.set('aiProvider', 'openrouter');
    settings.set('openrouterModel', 'anthropic/claude-sonnet-4.6');
    const fetchMock = stubFetch(OPENROUTER_REPLY);
    await callLlm({ apiKey: 'sk-or-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(sentBody(fetchMock)).not.toHaveProperty('plugins');
  });
});
