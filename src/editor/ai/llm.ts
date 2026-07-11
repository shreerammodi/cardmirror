/**
 * LLM client. Dispatches on the `aiProvider` setting between the
 * Anthropic Messages API and OpenRouter (OpenAI-chat-compatible).
 * Browser-direct calls — the user's API key lives in local settings
 * and is sent on every request from the client. Documented as a
 * security tradeoff in PROJECT.md; users opt in by enabling AI
 * features and pasting their own key.
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
  /** Sampling temperature. Omit to use Anthropic's default (1.0); set
   *  low (e.g. 0) for deterministic, thorough extraction tasks. */
  temperature?: number;
  /** System prompt. Falls back to the explainer-flavored default. */
  system?: string;
  /** Enable provider-native web search: the Anthropic `web_search`
   *  server tool, or the OpenRouter `web` plugin. Used by the cite
   *  researcher; off for everything else. */
  webSearch?: boolean;
  messages: LlmMessage[];
}

export interface LlmReply {
  text: string;
  /** The API's `stop_reason` — `'max_tokens'` means the output was
   *  truncated by the token limit (i.e. likely invalid/cut-off JSON). */
  stopReason?: string;
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
 *  (missing key, auth error, rate limit, retired model, generic network)
 *  without parsing string messages. */
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
      | 'model',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

type OpenRouterBlock =
  | { type: 'text'; text: string }
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
 *  data URLs. Exported for testing. */
export function toOpenRouterMessages(req: LlmRequest): OpenRouterMessage[] {
  const msgs: OpenRouterMessage[] = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    msgs.push({ role: m.role, content: toOpenRouterContent(m.content) });
  }
  return msgs;
}

/** Parse an OpenRouter chat-completions response into `LlmReply`.
 *  Maps `finish_reason: 'length'` to `'max_tokens'` so callers' truncation
 *  checks (`stopReason === 'max_tokens'`) keep working. Exported for testing. */
export function parseOpenRouterReply(json: unknown): LlmReply {
  const choice = (
    json as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    }
  )?.choices?.[0];
  const text = choice?.message?.content ?? '';
  const fr = choice?.finish_reason;
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

async function callAnthropicApi(req: LlmRequest): Promise<LlmReply> {
  const requestedModel = req.model ?? resolveAiModel();
  const body = {
    model: requestedModel,
    max_tokens: req.maxTokens ?? defaultMaxTokens(),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.system ? { system: req.system } : {}),
    ...(req.webSearch
      ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }
      : {}),
    messages: req.messages,
  };

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
    });
  } catch (e) {
    throw new LlmError(
      `Network error contacting Anthropic: ${e instanceof Error ? e.message : String(e)}`,
      null,
      'network',
    );
  }

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
    // A retired / unknown model id comes back as a 404 not_found_error, or
    // a 4xx whose message names the model. Surface a friendly, actionable
    // message instead of the raw API text.
    const looksLikeModelError =
      errType === 'not_found_error' ||
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && /\bmodel\b/i.test(detail));
    if (looksLikeModelError) {
      throw new LlmError(
        `The AI model "${requestedModel}" was rejected by Anthropic — it may have been retired. ` +
          `Update CardMirror to the latest version, or, if you'd rather not update the whole app, ` +
          `set a newer model under Settings → Comments & AI → AI model.`,
        res.status,
        'model',
      );
    }
    const kind: LlmError['kind'] =
      res.status === 401 ? 'auth' : res.status === 429 ? 'rate-limit' : 'server';
    throw new LlmError(
      `Anthropic API returned ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
      kind,
    );
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
  const stopReason = (json as { stop_reason?: string })?.stop_reason;
  return { text, stopReason };
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
  const body = {
    model,
    max_tokens: req.maxTokens ?? defaultMaxTokens(),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.webSearch ? { plugins: [{ id: 'web' }] } : {}),
    messages: toOpenRouterMessages(req),
  };

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LlmError(
      `Network error contacting OpenRouter: ${e instanceof Error ? e.message : String(e)}`,
      null,
      'network',
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      const payload = (await res.json()) as { error?: { message?: string } };
      detail = payload?.error?.message ?? '';
    } catch {
      // Body wasn't JSON. Fall back to status.
    }
    const looksLikeModelError =
      res.status === 404 || (res.status >= 400 && res.status < 500 && /\bmodel\b/i.test(detail));
    if (looksLikeModelError) {
      throw new LlmError(
        `The AI model "${model}" was rejected by OpenRouter - check the model id under ` +
          `Settings -> Comments & AI -> OpenRouter model.`,
        res.status,
        'model',
      );
    }
    const kind: LlmError['kind'] =
      res.status === 401 ? 'auth' : res.status === 429 ? 'rate-limit' : 'server';
    throw new LlmError(
      `OpenRouter API returned ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
      kind,
    );
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
  return parseOpenRouterReply(json);
}

export async function callLlm(req: LlmRequest): Promise<LlmReply> {
  if (!req.apiKey || !req.apiKey.trim()) {
    throw new LlmError('API key is not set - open Settings to add one.', null, 'no-key');
  }
  return settings.get('aiProvider') === 'openrouter'
    ? callOpenRouter(req)
    : callAnthropicApi(req);
}
