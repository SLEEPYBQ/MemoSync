// Minimal DeepSeek JSON-mode caller for the server-side memory passes
// (capture / necessity / trace): raw fetch to an OpenAI-compatible
// /chat/completions with response_format json_object, a hard timeout, and
// throw-on-anything so callers degrade gracefully. fetch is injectable so
// tests never touch the network.
//
// Env: DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL (default https://api.deepseek.com),
// DEEPSEEK_MODEL (default deepseek-v4-flash).

export interface DeepSeekJsonRequest {
  system: string;
  user: string;
  /** DeepSeek v4 reasons before answering — leave room or the JSON gets starved. */
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Turn OFF the model's reasoning pass for latency-critical calls. v4 thinks
   * by default (~10s measured on the relevance shape vs ~2.4s without); tiny
   * classification tasks don't need it. With thinking off, the ~4000-token
   * floor for maxTokens (BUG-009) no longer applies — nothing is starved.
   */
  disableThinking?: boolean;
  /**
   * Reasoning intensity when thinking stays ON (official mapping: v4-flash
   * low→low, high→high, max→max; default high). "low" is the middle path —
   * some reasoning, a fraction of the latency and token burn.
   */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** Caller-side cancellation (e.g. Stop during the preview pass) — aborts the fetch and skips retries. */
  signal?: AbortSignal;
}

/** Calls the model and returns the parsed JSON object; throws on any failure. */
export type LlmJsonCaller = (req: DeepSeekJsonRequest) => Promise<Record<string, unknown>>;

/** Safe, bounded diagnostics for provider failures. Raw response bodies and
 * request content must never enter experiment telemetry. */
export type LlmFailureCategory =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'provider_5xx'
  | 'provider_4xx'
  | 'empty_response'
  | 'truncated'
  | 'invalid_json'
  | 'invalid_response'
  | 'unknown';

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly category: LlmFailureCategory,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

export function describeLlmJsonFailure(error: unknown): {
  category: LlmFailureCategory;
  httpStatus?: number;
} {
  if (error instanceof LlmJsonError) {
    return {
      category: error.category,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    };
  }
  return { category: 'unknown' };
}

export interface DeepSeekCallerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Retries on TRANSIENT failures (network error, 5xx, 429, empty body). Default 2. */
  maxRetries?: number;
  /** Base backoff between retries, multiplied by attempt number. Default 500ms. */
  retryDelayMs?: number;
}

// v4 reasons before answering; anything under ~4000 has starved the JSON
// output in practice (trace BUG-009, suggest — twice). Never go lower.
const DEFAULT_MAX_TOKENS = 4000;
// 90s: the sidecars are post-turn/background — landing beats speed (user
// decision 2026-08-05). Latency-critical calls (relevance) override lower.
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

/** A transient failure worth retrying with the SAME prompt (vs. a deterministic one). */
class TransientLlmError extends LlmJsonError {}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Strip an optional ```json fence some models wrap around JSON-mode output. */
function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m ? m[1] : text;
}

/** Build a caller from options/env, or null when no API key is configured. */
export function createDeepSeekJsonCaller(opts: DeepSeekCallerOptions = {}): LlmJsonCaller | null {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) return null;
  const baseUrl = (opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // One attempt. Throws TransientLlmError for failures worth a retry (network,
  // 5xx, 429, empty body) and a plain Error for deterministic ones (4xx,
  // malformed JSON) that retrying the same prompt would never fix.
  const attempt = async (req: DeepSeekJsonRequest): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: req.signal
          ? AbortSignal.any([AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS), req.signal])
          : AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          response_format: { type: 'json_object' },
          ...(req.disableThinking ? { thinking: { type: 'disabled' } } : {}),
          ...(req.reasoningEffort && !req.disableThinking ? { reasoning_effort: req.reasoningEffort } : {}),
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (error) {
      // Network error / timeout — transient.
      if (req.signal?.aborted) {
        throw new LlmJsonError('DeepSeek request cancelled', 'cancelled');
      }
      const category = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'timeout'
        : 'network';
      throw new TransientLlmError(
        category === 'timeout' ? 'DeepSeek request timed out' : 'DeepSeek network request failed',
        category,
      );
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new TransientLlmError(`DeepSeek HTTP ${res.status}`, 'rate_limited', res.status);
      }
      if (res.status >= 500) {
        throw new TransientLlmError(`DeepSeek HTTP ${res.status}`, 'provider_5xx', res.status);
      }
      throw new LlmJsonError(`DeepSeek HTTP ${res.status}`, 'provider_4xx', res.status); // deterministic
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new TransientLlmError('DeepSeek returned empty content', 'empty_response');
    // Token starvation truncates mid-JSON; the parse error it causes reads
    // as model garbage. Name the real cause — and don't retry, the same
    // budget truncates the same way.
    if (body.choices?.[0]?.finish_reason === 'length') {
      throw new LlmJsonError(
        `DeepSeek output truncated at max_tokens=${req.maxTokens ?? DEFAULT_MAX_TOKENS}`,
        'truncated',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(content)); // deterministic → not retried
    } catch {
      throw new LlmJsonError('DeepSeek returned invalid JSON', 'invalid_json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LlmJsonError('DeepSeek returned non-object JSON', 'invalid_response');
    }
    return parsed as Record<string, unknown>;
  };

  return async (req: DeepSeekJsonRequest): Promise<Record<string, unknown>> => {
    let lastError: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await attempt(req);
      } catch (error) {
        lastError = error;
        // A caller-side abort is a decision, not a hiccup — never retried.
        if (req.signal?.aborted) throw error;
        if (!(error instanceof TransientLlmError) || i === maxRetries) throw error;
        await sleep(retryDelayMs * (i + 1));
      }
    }
    throw lastError; // unreachable, keeps the type checker happy
  };
}
