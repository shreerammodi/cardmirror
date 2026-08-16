/**
 * LLM client. Dispatches on the `aiProvider` setting between the
 * Anthropic Messages API and OpenRouter (OpenAI-chat-compatible).
 * Browser-direct calls — the user's API key lives in local settings
 * and is sent on every request from the client. Documented as a
 * security tradeoff in PROJECT.md; users opt in by enabling AI
 * features and pasting their own key.
 *
 * Failure envelope (both providers): every failure surfaces as an
 * `LlmError` with a user-facing message and a `kind` for branching.
 * Transient statuses (429/408/5xx incl. Anthropic's 529 "overloaded")
 * get ONE automatic retry after a short pause; a 400 rejecting a
 * sampling parameter retries once without `temperature` (the newest
 * Claude models refuse it — directly and through OpenRouter alike);
 * safety declines (Anthropic `stop_reason: 'refusal'`, OpenRouter
 * moderation 403 / `finish_reason: 'content_filter'`) are `'refusal'`-
 * kind errors that explain themselves instead of masquerading as empty
 * responses; every request carries a hard timeout so a hung connection
 * can't spin the AI activity indicator forever.
 */

import { settings } from '../settings.js';

/** Anthropic multipart content blocks (vision support). A text-only
 *  message can be a plain string; messages with images use the
 *  block-array form: `[{ type: 'text', text }, { type: 'image', ... }]`.
 *  Block ordering matters — Anthropic recommends placing images
 *  before the text instruction in multimodal prompts. */
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        /** MIME type of the inlined bytes. Anthropic supports the common
         *  raster formats — `image/png`, `image/jpeg`, `image/gif`,
         *  `image/webp`. SVG / EMF / TIFF aren't supported by the
         *  vision API; callers should fall back gracefully. */
        media_type: string;
        /** Raw base64 (no `data:` prefix). */
        data: string;
      };
    };

/** Raster formats the vision API accepts. SVG / EMF / TIFF aren't
 *  supported; callers should filter and fall back gracefully. */
export const VISION_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

export interface LlmRequest {
  apiKey: string;
  /** Default `claude-sonnet-4-6`; callers can override. */
  model?: string;
  /** Max tokens to generate. Defaults to a sane chat-reply size. */
  maxTokens?: number;
  /** Sampling temperature. Omit to use the provider's default; set low
   *  (e.g. 0) for deterministic, thorough extraction tasks. Best-effort:
   *  the newest Claude models reject sampling parameters, and the client
   *  silently retries without it rather than failing the request. */
  temperature?: number;
  /** System prompt. Falls back to the explainer-flavored default. Marked
   *  as a cache breakpoint (see `cachedSystem`), so a prompt reused across
   *  calls is billed at the cache-read rate and stops counting against the
   *  input-tokens-per-minute quota. */
  system?: string;
  messages: LlmMessage[];
  /** Part of a BULK pass (a whole-document sweep), not an interactive
   *  one-shot. Bulk requests wait out a long `retry-after` and retry a
   *  throttle more than once: the user authorized a job measured in
   *  minutes, so absorbing a 30-second backoff is right where failing an
   *  interactive keystroke would not be. */
  bulk?: boolean;
  /** Called when the request is about to sleep off a transient failure,
   *  so a long-running caller can say so instead of looking hung. */
  onThrottle?: (delayMs: number) => void;
}

export interface LlmReply {
  text: string;
  /** The API's `stop_reason` — `'max_tokens'` means the output was
   *  truncated by the token limit (i.e. likely invalid/cut-off JSON). */
  stopReason?: string;
  /** Whether the call had to sleep off a 429/5xx before succeeding. A
   *  bulk caller reads this to back its concurrency off — the provider
   *  said "slower", and only the caller can act on that. */
  throttled?: boolean;
}

/** The single source of truth for which Claude model the app talks to.
 *  Bump this one constant on a model deprecation (and ship a release);
 *  `modelMarkerName` in `translate.ts` derives its label from the id, so
 *  it usually needs no change. Users can also override per-install via
 *  the `aiModelOverride` setting (see `resolveAiModel`). */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
/** Floor for the user-configurable output budget. Reasoning models
 *  count hidden thinking tokens against `max_tokens`, so anything below
 *  this can leave no room for the actual reply (empty content, a
 *  `finish_reason: length` cut-off). */
const MIN_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = '2023-06-01';

/** The output-token ceiling for calls that don't set their own, from the
 *  `aiMaxTokens` setting and never below the floor. Shared by both
 *  providers so cite/explain/flashcards/image-alt behave the same. */
function defaultMaxTokens(): number {
  const n = Math.round(settings.get('aiMaxTokens'));
  return Number.isFinite(n) ? Math.max(MIN_MAX_TOKENS, n) : MIN_MAX_TOKENS;
}

/** Loosely validate a model id before trusting a user override: no
 *  whitespace, a plausible length, and only the characters model ids use.
 *  Garbage reverts to the default; a well-formed-but-retired id still
 *  reaches the API, which surfaces a friendly `'model'` error. */
function isPlausibleModelId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(s);
}

/** The model the app should use: for OpenRouter, the user's configured
 *  `openrouterModel` verbatim; for Anthropic, the `aiModelOverride` when
 *  it looks valid, otherwise `DEFAULT_MODEL`. Single resolver so every AI
 *  feature (cite, explain, translate, flashcards, image) stays in sync. */
export function resolveAiModel(): string {
  if (settings.get('aiProvider') === 'openrouter') {
    return settings.get('openrouterModel').trim();
  }
  const override = (settings.get('aiModelOverride') || '').trim();
  return isPlausibleModelId(override) ? override : DEFAULT_MODEL;
}

/** The API key for the currently selected provider, trimmed. Single
 *  source so every AI feature reads the right key when the provider
 *  changes. */
export function activeApiKey(): string {
  const key =
    settings.get('aiProvider') === 'openrouter'
      ? settings.get('openrouterApiKey')
      : settings.get('anthropicApiKey');
  return key.trim();
}

/** Whether AI features are usable right now: master switch on AND the
 *  active provider has a key. (An OpenRouter key with no model still
 *  reads as configured; the missing model surfaces as a friendly error
 *  on use, mirroring how a retired Claude id already behaves.) */
export function aiConfigured(): boolean {
  return settings.get('aiFeaturesEnabled') && activeApiKey() !== '';
}

/** Custom error so callers can branch on AI-specific failures
 *  (missing key, auth error, rate limit, retired model, safety refusal,
 *  generic network) without parsing string messages. */
export class LlmError extends Error {
  constructor(
    message: string,
    /** HTTP status when the call reached the server, else `null`. */
    public readonly status: number | null,
    public readonly kind:
      | 'no-key'
      | 'auth'
      | 'rate-limit'
      | 'server'
      | 'network'
      | 'parse'
      | 'model'
      | 'refusal',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Hard ceiling on any single provider request. Generous — big
 *  generations (tables from images, long repairs) legitimately run for
 *  minutes — but a hung connection no longer spins the AI activity
 *  indicator forever. */
const REQUEST_TIMEOUT_MS = 300_000;

/** Both providers document 429/5xx as retry-with-backoff (Anthropic adds
 *  529 "overloaded"; OpenRouter adds 408/502/503 pass-throughs). One
 *  automatic retry absorbs the transient blips; anything persistent still
 *  surfaces after the second attempt. Returns the delay before the retry,
 *  or null when the status isn't transient — or the server asked for a
 *  longer wait than the caller should silently absorb.
 *
 *  That last cap is what `bulk` moves. An interactive command must not
 *  freeze for half a minute on a keystroke, so a `retry-after` above
 *  `INTERACTIVE_RETRY_CAP_S` fails instead. A whole-document pass is the
 *  opposite case: the user authorized a job measured in minutes, and
 *  turning a "slow down for 30 seconds" into a failed cite wastes the
 *  tokens already spent.
 *
 *  `retryAfter` is often null in the browser regardless of what the
 *  provider sent: `retry-after` is not a CORS-safelisted response header,
 *  so a cross-origin reply only exposes it via
 *  `Access-Control-Expose-Headers`. Both caps then simply never bind and
 *  the flat 2s default applies — which is why the default has to be a
 *  sane backoff on its own. Exported for tests. */
export function transientRetryDelayMs(
  status: number,
  retryAfter: string | null,
  bulk = false,
): number | null {
  if (status === 429) {
    const cap = bulk ? BULK_RETRY_CAP_S : INTERACTIVE_RETRY_CAP_S;
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return s <= cap ? s * 1000 : null;
    return 2000;
  }
  if (status === 408 || status >= 500) return 1500;
  return null;
}

/** Longest `retry-after` an interactive command absorbs silently. */
const INTERACTIVE_RETRY_CAP_S = 8;
/** Longest `retry-after` a bulk pass absorbs. Sized to cover the
 *  per-minute quota windows both providers reset on, so a throttled sweep
 *  slows down instead of failing. */
const BULK_RETRY_CAP_S = 60;
/** Transient retries per request: `BULK_RETRIES` for a bulk pass, whose
 *  throttles are partly self-inflicted (its own concurrency) and clear as
 *  the caller backs off, one for everything else. */
const BULK_RETRIES = 3;

/** Marks a content block as a prompt-cache breakpoint for both providers
 *  (OpenRouter passes Anthropic's annotation through).
 *
 *  Every request in a sweep resends the same system prompt — the cite
 *  formatter's is ~1700 tokens against a ~80-token citation, so ~95% of
 *  the input is one identical prefix. Marking it makes every call after
 *  the first a cache read: 0.1x the input price, and excluded from the
 *  input-tokens-per-minute quota, which is the limit that actually caps a
 *  bulk pass.
 *
 *  It goes on the SYSTEM block deliberately, not at the request's top
 *  level: top-level ("automatic") caching moves the breakpoint to the last
 *  cacheable block, which here is the varying user message, so every call
 *  would write a fresh entry instead of reading the shared prefix.
 *
 *  Applied unconditionally. A prompt under the model's minimum cacheable
 *  length (1024 tokens on Sonnet 4.6) is simply not cached, with no error,
 *  so short-prompt features neither pay the 1.25x write nor break. */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/** djb2, hex. Not a checksum: it only has to map one system prompt to one
 *  stable OpenRouter session key, so collisions between two DIFFERENT
 *  prompts cost at most a cold cache. */
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Test seam: the retry pause. Tests stub `wait` so retries don't
 *  slow the suite down. */
export const llmSleep = {
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `fetch` with the request timeout and uniform network-failure wrapping.
 *  Timeouts and connection failures both become `'network'`-kind errors —
 *  the caller can't tell them apart in any actionable way. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  providerName: string,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    // Shape-check rather than instanceof: DOMException doesn't inherit
    // Error in every runtime (same lesson as `isFileGoneError`).
    if ((e as { name?: string } | null)?.name === 'AbortError') {
      throw new LlmError(
        `The request to ${providerName} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 60_000)} minutes — try again.`,
        null,
        'network',
      );
    }
    throw new LlmError(
      `Network error contacting ${providerName}: ${e instanceof Error ? e.message : String(e)}`,
      null,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
}

type OpenRouterBlock =
  | { type: 'text'; text: string; cache_control?: typeof CACHE_BREAKPOINT }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenRouterMessage {
  role: string;
  content: string | OpenRouterBlock[];
}

function toOpenRouterContent(content: string | LlmContentBlock[]): string | OpenRouterBlock[] {
  if (typeof content === 'string') return content;
  return content.map((b): OpenRouterBlock =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        },
  );
}

/** Translate an Anthropic-shaped request's system + messages into the
 *  OpenRouter (OpenAI-chat) message array: the top-level `system` field
 *  becomes a leading `system` message, image blocks become `image_url`
 *  data URLs. The system message goes as a one-block array carrying
 *  `CACHE_BREAKPOINT` — OpenRouter passes Anthropic's annotation straight
 *  through, and models that don't cache ignore it. Exported for testing. */
export function toOpenRouterMessages(req: LlmRequest): OpenRouterMessage[] {
  const msgs: OpenRouterMessage[] = [];
  if (req.system) {
    msgs.push({
      role: 'system',
      content: [{ type: 'text', text: req.system, cache_control: CACHE_BREAKPOINT }],
    });
  }
  for (const m of req.messages) {
    msgs.push({ role: m.role, content: toOpenRouterContent(m.content) });
  }
  return msgs;
}

/** Parse an OpenRouter chat-completions response into `LlmReply`.
 *  Maps `finish_reason: 'length'` to `'max_tokens'` so callers' truncation
 *  checks (`stopReason === 'max_tokens'`) keep working. OpenRouter can also
 *  deliver failures INSIDE an HTTP 200 — a top-level `error` envelope, a
 *  choice whose `finish_reason` is `'error'` (the upstream provider died
 *  mid-generation), or `'content_filter'` (moderation cut the output) —
 *  all of which must surface as errors, not as a truncated "answer".
 *  Exported for testing. */
export function parseOpenRouterReply(json: unknown): LlmReply {
  const topError = (json as { error?: { message?: string } })?.error;
  if (typeof topError?.message === 'string' && topError.message) {
    throw new LlmError(`OpenRouter reported an error: ${topError.message}`, null, 'server');
  }
  const choice = (
    json as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
        error?: { message?: string };
      }>;
    }
  )?.choices?.[0];
  const text = choice?.message?.content ?? '';
  const fr = choice?.finish_reason;
  if (fr === 'error') {
    const why = choice?.error?.message;
    throw new LlmError(
      `The model provider failed while generating the reply${why ? ` (${why})` : ''} — try again.`,
      null,
      'server',
    );
  }
  if (fr === 'content_filter') {
    throw new LlmError(
      "The reply was cut off by the model provider's content filter. This can misfire on " +
        'sensitive research topics — try rephrasing, trimming the selection, or a different model.',
      null,
      'refusal',
    );
  }
  if (!text) {
    // A reasoning model can spend the entire token budget on hidden
    // thinking and return empty content with finish_reason: 'length'.
    // Point the user at the fix rather than a bare "empty response".
    if (fr === 'length') {
      throw new LlmError(
        'The model used its whole token budget on reasoning and returned no text. ' +
          'Raise "Max output tokens" under Settings -> Comments & AI (reasoning ' +
          'models need a higher value), or pick a non-reasoning model.',
        null,
        'parse',
      );
    }
    throw new LlmError('OpenRouter returned an empty response.', null, 'parse');
  }
  const stopReason = fr === 'length' ? 'max_tokens' : fr;
  return { text, stopReason };
}

/** Sampling parameters the newest Claude models reject with a 400 whose
 *  message names the parameter. Used both to auto-strip `temperature` and
 *  to keep such 400s out of the retired-model heuristic (their messages
 *  often contain the word "model" too). */
const SAMPLING_PARAM = /\btemperature\b|\btop_p\b|\btop_k\b/i;

function throwAnthropicHttpError(
  status: number,
  errType: string,
  detail: string,
  requestedModel: string,
): never {
  // A retired / unknown model id comes back as a 404 not_found_error, or
  // a 4xx whose message names the model. Surface a friendly, actionable
  // message instead of the raw API text. Sampling-parameter rejections
  // also mention "model" — those are not model errors.
  const looksLikeModelError =
    !SAMPLING_PARAM.test(detail) &&
    (errType === 'not_found_error' ||
      status === 404 ||
      (status >= 400 && status < 500 && /\bmodel\b/i.test(detail)));
  if (looksLikeModelError) {
    throw new LlmError(
      `The AI model "${requestedModel}" was rejected by Anthropic — it may have been retired. ` +
        `Update CardMirror to the latest version, or, if you'd rather not update the whole app, ` +
        `set a newer model under Settings → Comments & AI → AI model.`,
      status,
      'model',
    );
  }
  if (status === 529 || errType === 'overloaded_error') {
    throw new LlmError(
      'Anthropic is temporarily overloaded — wait a moment and try again.',
      status,
      'server',
    );
  }
  if (status === 403) {
    throw new LlmError(
      `Anthropic rejected the request as not permitted for this API key (403)${detail ? `: ${detail}` : ''}`,
      status,
      'auth',
    );
  }
  const kind: LlmError['kind'] = status === 401 ? 'auth' : status === 429 ? 'rate-limit' : 'server';
  throw new LlmError(`Anthropic API returned ${status}${detail ? `: ${detail}` : ''}`, status, kind);
}

async function callAnthropicApi(req: LlmRequest): Promise<LlmReply> {
  const requestedModel = req.model ?? resolveAiModel();
  let temperature = req.temperature;
  let transientRetries = req.bulk ? BULK_RETRIES : 1;
  let throttled = false;
  for (;;) {
    const body = {
      model: requestedModel,
      max_tokens: req.maxTokens ?? defaultMaxTokens(),
      ...(temperature != null ? { temperature } : {}),
      ...(req.system
        ? { system: [{ type: 'text', text: req.system, cache_control: CACHE_BREAKPOINT }] }
        : {}),
      messages: req.messages,
    };

    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          // Required for direct-browser calls. Confirms the user opted
          // in to client-side API key exposure (we set it knowingly).
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      },
      'Anthropic',
    );

    if (!res.ok) {
      let detail = '';
      let errType = '';
      try {
        const payload = (await res.json()) as { error?: { message?: string; type?: string } };
        detail = payload?.error?.message ?? '';
        errType = payload?.error?.type ?? '';
      } catch {
        // Body wasn't JSON. Fall back to status text.
      }
      // The newest Claude models reject sampling parameters outright
      // (400 naming `temperature`). Retry once without it rather than
      // failing an otherwise-valid request — the low-temperature ask was
      // best-effort determinism, never a guarantee.
      if (res.status === 400 && temperature != null && SAMPLING_PARAM.test(detail)) {
        temperature = undefined;
        continue;
      }
      const delay =
        transientRetries > 0
          ? transientRetryDelayMs(res.status, res.headers.get('retry-after'), req.bulk)
          : null;
      if (delay !== null) {
        transientRetries--;
        throttled = true;
        req.onThrottle?.(delay);
        await llmSleep.wait(delay);
        continue;
      }
      throwAnthropicHttpError(res.status, errType, detail, requestedModel);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new LlmError(
        `Failed to parse Anthropic response: ${e instanceof Error ? e.message : String(e)}`,
        res.status,
        'parse',
      );
    }

    // Safety classifiers decline with a SUCCESSFUL response carrying
    // `stop_reason: 'refusal'` (content empty, or a partial that must not
    // be passed off as an answer). Check before the empty-text fallback so
    // the user sees why, not "empty response".
    const stopReason = (json as { stop_reason?: string })?.stop_reason;
    if (stopReason === 'refusal') {
      throw new LlmError(
        'Claude declined this request (safety filters). These can misfire on sensitive ' +
          'research topics — try rephrasing, or trimming the selection to just what the task needs.',
        res.status,
        'refusal',
      );
    }

    // Response shape:
    //   { id, type: 'message', role: 'assistant',
    //     content: [{ type: 'text', text: '...' }, ...], ... }
    // We concatenate all text-typed content blocks; tool/structured
    // blocks (none expected for chat) are ignored.
    const content = (json as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    if (!text) {
      throw new LlmError('Anthropic returned an empty response.', res.status, 'parse');
    }
    return { text, stopReason, throttled };
  }
}

function throwOpenRouterHttpError(
  status: number,
  detail: string,
  reasons: string[],
  providerName: string,
  model: string,
): never {
  // 402: out of credits — the one OpenRouter failure the user can fix on
  // their account page, so name the fix instead of echoing the envelope.
  if (status === 402) {
    throw new LlmError(
      `Your OpenRouter account is out of credits (402)${detail ? `: ${detail}` : ''}. ` +
        `Add credits at openrouter.ai and try again.`,
      status,
      'server',
    );
  }
  // 403: the upstream provider's moderation flagged the INPUT. The
  // envelope's metadata says who flagged it and why.
  if (status === 403) {
    const who = providerName ? `${providerName}'s moderation` : "the model provider's moderation";
    const why = reasons.length ? ` Flagged for: ${reasons.join(', ')}.` : '';
    throw new LlmError(
      `The request was declined by ${who}.${why} This can misfire on sensitive research ` +
        `topics — try rephrasing, trimming the selection, or a different model.`,
      status,
      'refusal',
    );
  }
  const looksLikeModelError =
    !SAMPLING_PARAM.test(detail) &&
    (status === 404 || (status >= 400 && status < 500 && /\bmodel\b/i.test(detail)));
  if (looksLikeModelError) {
    throw new LlmError(
      `The AI model "${model}" was rejected by OpenRouter - check the model id under ` +
        `Settings -> Comments & AI -> OpenRouter model.`,
      status,
      'model',
    );
  }
  const kind: LlmError['kind'] = status === 401 ? 'auth' : status === 429 ? 'rate-limit' : 'server';
  throw new LlmError(`OpenRouter API returned ${status}${detail ? `: ${detail}` : ''}`, status, kind);
}

async function callOpenRouter(req: LlmRequest): Promise<LlmReply> {
  const model = req.model ?? resolveAiModel();
  if (!model) {
    throw new LlmError(
      'No OpenRouter model is set - add one under Settings -> Comments & AI -> ' +
        'OpenRouter model (e.g. anthropic/claude-sonnet-4.6).',
      null,
      'model',
    );
  }
  let temperature = req.temperature;
  let transientRetries = req.bulk ? BULK_RETRIES : 1;
  let throttled = false;
  for (;;) {
    const body = {
      model,
      max_tokens: req.maxTokens ?? defaultMaxTokens(),
      ...(temperature != null ? { temperature } : {}),
      // Sticky routing keeps the cached prefix warm. Without a session id
      // OpenRouter derives one by hashing the first system AND first user
      // message, so a sweep's per-item user text would scatter its calls
      // across providers and cold-start the cache on each one. Keyed by
      // the system prompt: every call sharing a prompt shares a session.
      ...(req.system ? { session_id: `cm-${cheapHash(req.system)}` } : {}),
      messages: toOpenRouterMessages(req),
    };

    const res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      'OpenRouter',
    );

    if (!res.ok) {
      let detail = '';
      let reasons: string[] = [];
      let providerName = '';
      try {
        const payload = (await res.json()) as {
          error?: {
            message?: string;
            metadata?: { reasons?: string[]; provider_name?: string };
          };
        };
        detail = payload?.error?.message ?? '';
        reasons = payload?.error?.metadata?.reasons ?? [];
        providerName = payload?.error?.metadata?.provider_name ?? '';
      } catch {
        // Body wasn't JSON. Fall back to status.
      }
      // Sampling-param rejection passed through from the upstream model
      // (the newest Claude models reject `temperature`): retry without it.
      if (res.status === 400 && temperature != null && SAMPLING_PARAM.test(detail)) {
        temperature = undefined;
        continue;
      }
      const delay =
        transientRetries > 0
          ? transientRetryDelayMs(res.status, res.headers.get('retry-after'), req.bulk)
          : null;
      if (delay !== null) {
        transientRetries--;
        throttled = true;
        req.onThrottle?.(delay);
        await llmSleep.wait(delay);
        continue;
      }
      throwOpenRouterHttpError(res.status, detail, reasons, providerName, model);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new LlmError(
        `Failed to parse OpenRouter response: ${e instanceof Error ? e.message : String(e)}`,
        res.status,
        'parse',
      );
    }
    return { ...parseOpenRouterReply(json), throttled };
  }
}

export async function callLlm(req: LlmRequest): Promise<LlmReply> {
  if (!req.apiKey || !req.apiKey.trim()) {
    throw new LlmError('API key is not set - open Settings to add one.', null, 'no-key');
  }
  return settings.get('aiProvider') === 'openrouter'
    ? callOpenRouter(req)
    : callAnthropicApi(req);
}
