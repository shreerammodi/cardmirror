/**
 * Provider error handling in `llm.ts`: one-shot retry of transient
 * failures (429/408/5xx/529), sampling-parameter stripping on 400,
 * safety refusals surfacing as `'refusal'`-kind errors, the request
 * timeout, and OpenRouter's payment / moderation / embedded-in-200
 * failures. `fetch` is stubbed per test; `llmSleep.wait` is stubbed so
 * retries are instant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callLlm,
  parseOpenRouterReply,
  transientRetryDelayMs,
  llmSleep,
  LlmError,
} from '../../src/editor/ai/llm.js';
import { settings } from '../../src/editor/settings.js';

const REQ = { apiKey: 'sk-test', messages: [{ role: 'user' as const, content: 'hi' }] };

const OK_ANTHROPIC = {
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Stub fetch to return the given responses in order (the last repeats).
 *  Returns the mock so tests can inspect the request bodies. */
function fetchReturning(...responses: Response[]) {
  let i = 0;
  const mock = vi.fn(() => {
    const res = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return Promise.resolve(res);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function sentBody(mock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = mock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

const realWait = llmSleep.wait;

beforeEach(() => {
  llmSleep.wait = vi.fn(() => Promise.resolve());
});

afterEach(() => {
  llmSleep.wait = realWait;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  settings.set('aiProvider', 'anthropic');
  settings.set('openrouterModel', '');
});

describe('transientRetryDelayMs (retry policy table)', () => {
  it('retries 429 after 2s by default, honoring a short retry-after', () => {
    expect(transientRetryDelayMs(429, null)).toBe(2000);
    expect(transientRetryDelayMs(429, '3')).toBe(3000);
    expect(transientRetryDelayMs(429, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(2000);
  });

  it('does not silently absorb a long retry-after for an interactive call', () => {
    expect(transientRetryDelayMs(429, '30')).toBeNull();
  });

  it('waits out a long retry-after for a BULK call, up to a minute', () => {
    // An interactive keystroke must not freeze for half a minute; a
    // whole-document pass the user authorized should slow down rather
    // than throw away the tokens a throttled request already spent.
    expect(transientRetryDelayMs(429, '30', true)).toBe(30_000);
    expect(transientRetryDelayMs(429, '60', true)).toBe(60_000);
    expect(transientRetryDelayMs(429, '61', true)).toBeNull();
  });

  it('retries timeouts and server errors (500/502/503/529) after a short pause', () => {
    for (const status of [408, 500, 502, 503, 529]) {
      expect(transientRetryDelayMs(status, null), `status=${status}`).toBe(1500);
    }
  });

  it('never retries non-transient statuses', () => {
    for (const status of [400, 401, 402, 403, 404, 413]) {
      expect(transientRetryDelayMs(status, null), `status=${status}`).toBeNull();
    }
  });
});

describe('prompt caching', () => {
  const LONG_SYSTEM = 'You format citations. '.repeat(200);

  it('marks the Anthropic system prompt as a cache breakpoint', async () => {
    // ~95% of a sweep's input is one identical system prompt; cached, it
    // bills at 0.1x and stops counting against the per-minute input quota.
    const mock = fetchReturning(jsonResponse(200, OK_ANTHROPIC));
    await callLlm({ ...REQ, system: LONG_SYSTEM });
    expect(sentBody(mock, 0).system).toEqual([
      { type: 'text', text: LONG_SYSTEM, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('sends no system field when there is no system prompt', async () => {
    const mock = fetchReturning(jsonResponse(200, OK_ANTHROPIC));
    await callLlm(REQ);
    expect(sentBody(mock, 0)).not.toHaveProperty('system');
  });

  it('marks the OpenRouter system message and pins a sticky session', async () => {
    // Without a session id OpenRouter derives one from the first system
    // AND first user message, so a sweep's per-cite text would scatter
    // across providers and cold-start the cache on every call.
    settings.set('aiProvider', 'openrouter');
    settings.set('openrouterModel', 'anthropic/claude-sonnet-4.6');
    const mock = fetchReturning(
      jsonResponse(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
    );
    await callLlm({ ...REQ, system: LONG_SYSTEM });
    const body = sentBody(mock, 0);
    expect((body.messages as Array<{ role: string; content: unknown }>)[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: LONG_SYSTEM, cache_control: { type: 'ephemeral' } }],
    });
    expect(body.session_id).toMatch(/^cm-[0-9a-f]+$/);
  });
});

describe('bulk requests', () => {
  const RATE_LIMITED = jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '20' });

  it('reports a throttle back to the caller', async () => {
    const mock = fetchReturning(RATE_LIMITED, jsonResponse(200, OK_ANTHROPIC));
    const reply = await callLlm({ ...REQ, bulk: true });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(reply.throttled).toBe(true);
    expect(reply.text).toBe('hello');
  });

  it('leaves throttled unset when nothing had to wait', async () => {
    fetchReturning(jsonResponse(200, OK_ANTHROPIC));
    expect((await callLlm({ ...REQ, bulk: true })).throttled).toBe(false);
  });

  it('announces the backoff before sleeping it off', async () => {
    fetchReturning(RATE_LIMITED, jsonResponse(200, OK_ANTHROPIC));
    const onThrottle = vi.fn();
    await callLlm({ ...REQ, bulk: true, onThrottle });
    expect(onThrottle).toHaveBeenCalledWith(20_000);
  });

  it('retries a throttle more than once, unlike an interactive call', async () => {
    // Interactive: one retry, then the 429 surfaces.
    fetchReturning(RATE_LIMITED, RATE_LIMITED, jsonResponse(200, OK_ANTHROPIC));
    await expect(callLlm(REQ)).rejects.toThrow(LlmError);

    const bulk = fetchReturning(
      RATE_LIMITED,
      RATE_LIMITED,
      RATE_LIMITED,
      jsonResponse(200, OK_ANTHROPIC),
    );
    expect((await callLlm({ ...REQ, bulk: true })).text).toBe('hello');
    expect(bulk).toHaveBeenCalledTimes(4);
  });
});

describe('Anthropic: sampling-parameter stripping', () => {
  const TEMP_400 = jsonResponse(400, {
    error: {
      type: 'invalid_request_error',
      message: '`temperature` is not supported with this model.',
    },
  });

  it('retries a temperature 400 once without the parameter and succeeds', async () => {
    const mock = fetchReturning(TEMP_400, jsonResponse(200, OK_ANTHROPIC));
    const reply = await callLlm({ ...REQ, temperature: 0 });
    expect(reply.text).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(sentBody(mock, 0)).toHaveProperty('temperature', 0);
    expect(sentBody(mock, 1)).not.toHaveProperty('temperature');
  });

  it('a persistent sampling 400 is NOT misdiagnosed as a retired model', async () => {
    // The API message contains the word "model", which the retired-model
    // heuristic matches on — a sampling rejection must not trip it.
    fetchReturning(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: '`temperature` is not supported with this model.',
        },
      }),
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: '`temperature` is not supported with this model.',
        },
      }),
    );
    const err = await callLlm({ ...REQ, temperature: 0 }).catch((e: unknown) => e as LlmError);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('server');
    expect((err as LlmError).message).not.toMatch(/retired/);
  });

  it('does not fire the sampling retry when no temperature was sent', async () => {
    const mock = fetchReturning(TEMP_400);
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((err as LlmError).kind).toBe('server');
  });

  it('a genuine retired-model 404 still gets the friendly model message', async () => {
    fetchReturning(
      jsonResponse(404, {
        error: { type: 'not_found_error', message: 'model: claude-old-1 not found' },
      }),
    );
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect((err as LlmError).kind).toBe('model');
    expect((err as LlmError).message).toMatch(/retired/);
  });
});

describe('Anthropic: transient retry and status mapping', () => {
  it('recovers from a single 529 overload', async () => {
    const mock = fetchReturning(
      jsonResponse(529, { error: { type: 'overloaded_error', message: 'Overloaded' } }),
      jsonResponse(200, OK_ANTHROPIC),
    );
    const reply = await callLlm(REQ);
    expect(reply.text).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(llmSleep.wait).toHaveBeenCalledWith(1500);
  });

  it('a persistent 529 fails with the friendly overloaded message after one retry', async () => {
    const overloaded = () =>
      jsonResponse(529, { error: { type: 'overloaded_error', message: 'Overloaded' } });
    const mock = fetchReturning(overloaded(), overloaded());
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect(mock).toHaveBeenCalledTimes(2);
    expect((err as LlmError).kind).toBe('server');
    expect((err as LlmError).message).toMatch(/temporarily overloaded/);
  });

  it('honors a short retry-after on 429', async () => {
    const mock = fetchReturning(
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', message: 'rate limited' } },
        { 'retry-after': '3' },
      ),
      jsonResponse(200, OK_ANTHROPIC),
    );
    const reply = await callLlm(REQ);
    expect(reply.text).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(llmSleep.wait).toHaveBeenCalledWith(3000);
  });

  it('fails immediately on 429 when retry-after is too long to absorb', async () => {
    const mock = fetchReturning(
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', message: 'rate limited' } },
        { 'retry-after': '120' },
      ),
    );
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((err as LlmError).kind).toBe('rate-limit');
  });

  it('maps 403 to an auth-kind error naming the key', async () => {
    fetchReturning(
      jsonResponse(403, { error: { type: 'permission_error', message: 'forbidden' } }),
    );
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect((err as LlmError).kind).toBe('auth');
    expect((err as LlmError).message).toMatch(/API key/);
  });
});

describe('Anthropic: refusal stop_reason', () => {
  it('an empty refusal surfaces as a refusal error, not "empty response"', async () => {
    fetchReturning(jsonResponse(200, { content: [], stop_reason: 'refusal' }));
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect((err as LlmError).kind).toBe('refusal');
    expect((err as LlmError).message).toMatch(/declined/);
  });

  it('a partial answer with stop_reason refusal is not passed off as complete', async () => {
    fetchReturning(
      jsonResponse(200, {
        content: [{ type: 'text', text: 'partial answer that was cut' }],
        stop_reason: 'refusal',
      }),
    );
    await expect(callLlm(REQ)).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('a genuinely empty non-refusal response still reads as a parse error', async () => {
    fetchReturning(jsonResponse(200, { content: [], stop_reason: 'end_turn' }));
    await expect(callLlm(REQ)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('request timeout', () => {
  it('a hung connection aborts with a network-kind timeout error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );
    const outcome = expect(callLlm(REQ)).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringMatching(/timed out after 5 minutes/),
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await outcome;
  });
});

describe('OpenRouter: HTTP failures', () => {
  beforeEach(() => {
    settings.set('aiProvider', 'openrouter');
    settings.set('openrouterModel', 'anthropic/claude-sonnet-4.6');
  });

  it('402 names the out-of-credits fix without retrying', async () => {
    const mock = fetchReturning(
      jsonResponse(402, { error: { code: 402, message: 'Insufficient credits' } }),
    );
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((err as LlmError).kind).toBe('server');
    expect((err as LlmError).message).toMatch(/out of credits/);
    expect((err as LlmError).message).toMatch(/openrouter\.ai/);
  });

  it('403 surfaces the moderation metadata (who flagged it and why)', async () => {
    fetchReturning(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'Input flagged',
          metadata: { reasons: ['violence'], provider_name: 'Google', flagged_input: 'x' },
        },
      }),
    );
    const err = await callLlm(REQ).catch((e: unknown) => e as LlmError);
    expect((err as LlmError).kind).toBe('refusal');
    expect((err as LlmError).message).toMatch(/Google/);
    expect((err as LlmError).message).toMatch(/violence/);
  });

  it('strips temperature and retries when the upstream model rejects it', async () => {
    const mock = fetchReturning(
      jsonResponse(400, {
        error: { code: 400, message: 'temperature is not supported by this model' },
      }),
      jsonResponse(200, {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }),
    );
    const reply = await callLlm({ ...REQ, temperature: 0 });
    expect(reply.text).toBe('hello');
    expect(sentBody(mock, 0)).toHaveProperty('temperature', 0);
    expect(sentBody(mock, 1)).not.toHaveProperty('temperature');
  });

  it('recovers from a transient 503 (no provider available)', async () => {
    const mock = fetchReturning(
      jsonResponse(503, { error: { code: 503, message: 'No providers available' } }),
      jsonResponse(200, {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }),
    );
    const reply = await callLlm(REQ);
    expect(reply.text).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenRouter: failures embedded in an HTTP 200', () => {
  it('a top-level error envelope throws instead of reading as empty', () => {
    expect(() =>
      parseOpenRouterReply({ error: { code: 502, message: 'Provider returned error' } }),
    ).toThrow(/Provider returned error/);
  });

  it("finish_reason 'error' surfaces the provider failure", () => {
    expect(() =>
      parseOpenRouterReply({
        choices: [
          {
            message: { content: '' },
            finish_reason: 'error',
            error: { message: 'upstream 500' },
          },
        ],
      }),
    ).toThrow(/failed while generating.*upstream 500/);
  });

  it("finish_reason 'content_filter' is a refusal, even with partial text", () => {
    const err = (() => {
      try {
        parseOpenRouterReply({
          choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }],
        });
        return null;
      } catch (e) {
        return e as LlmError;
      }
    })();
    expect(err).toBeInstanceOf(LlmError);
    expect(err!.kind).toBe('refusal');
  });
});
