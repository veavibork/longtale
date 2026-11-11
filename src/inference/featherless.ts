import type { AgentProfile, ModelParams } from '../config.js'
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from './featherless-config.js'
import { getGlobalDb } from '../db/global-db.js'
import { recordModelOutcome } from '../db/model-config-store.js'
import { logOutboundRequest, logOutboundResponse } from './outbound-telemetry.js'
import { formatError } from '../lib/errors.js'
import { stripThinkingTags } from './reasoning-stream.js'

/** Optional sampler params (Config > Agents), omitted entirely rather than sent as null/0 when unset. */
function samplerParams(profile: AgentProfile): Record<string, number> {
  const params: Record<string, number> = {}
  if (profile.presencePenalty !== undefined) params.presence_penalty = profile.presencePenalty
  if (profile.frequencyPenalty !== undefined) params.frequency_penalty = profile.frequencyPenalty
  if (profile.repetitionPenalty !== undefined) params.repetition_penalty = profile.repetitionPenalty
  if (profile.topP !== undefined) params.top_p = profile.topP
  if (profile.topK !== undefined) params.top_k = profile.topK
  if (profile.minP !== undefined) params.min_p = profile.minP
  return params
}

// Same rough chars/4 estimate used throughout the codebase (see history.ts) — not a real tokenizer.
const CHARS_PER_TOKEN_ESTIMATE = 4
function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
function estimateTokens(text: string): number {
  return tokensFromChars(text.length)
}
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
}

/** Best-effort — a stats-write failure must never break the actual inference call it's reporting on. */
function recordOutcome(
  profile: AgentProfile,
  outcome: { success: boolean; inputTokens: number; outputTokens: number },
): void {
  if (!profile.configId) return
  try {
    recordModelOutcome(getGlobalDb(), profile.configId, outcome)
  } catch {
    // ignore.
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': FEATHERLESS_USER_AGENT,
}

/** Carries the HTTP status so callers can tell failure types apart. */
export class FeatherlessError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FeatherlessError'
    this.status = status
  }
}

/** Thrown when an in-flight call is aborted because the user cancelled the job. */
export class JobCancelledError extends Error {
  constructor(message = 'cancelled by user') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

// Statuses that trigger cross-model fallback: 400 (model cold), 403 (gated), 404, 503.
const MODEL_UNAVAILABLE_STATUS_CODES = new Set([400, 403, 404, 503])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TRANSIENT_RETRY_DELAYS_MS = [5000, 15000]

/** Progress notifications from the retry/fallback wrappers. */
export type RetryEvent =
  | { kind: 'transient-retry'; model: string; attempt: number; delayMs: number; status: number }
  | { kind: 'fallback'; fromModel: string; toModel: string; candidateIndex: number }

export type OnRetryEvent = (event: RetryEvent) => void

/** Same-model backoff for Featherless 500/503 before cross-model fallback kicks in. */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  onEvent?: (attempt: number, delayMs: number, status: number) => void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!(err instanceof FeatherlessError) || (err.status !== 500 && err.status !== 503)) {
        throw err
      }
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err
      const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt]!
      onEvent?.(attempt + 1, delayMs, err.status)
      await sleep(delayMs)
    }
  }
  throw lastError
}

/** Name-based guess (prefill, idle timeout) for models with no format profile; streams route by shape. */
export function isReasoningModel(model: string): boolean {
  return /deepseek/i.test(model)
}

/** Assistant-turn prefill that prevents empty first-token stops on reasoning-family models. */
export const REASONING_ASSISTANT_PREFILL = '<think>\n'

// The prefill decision itself lives in src/services/model-format.ts (shouldPrefillThink) — profile-aware.

/** Expands a caller's `chat_template_kwargs` into the full set Featherless's model families actually read. */
export function resolveChatTemplateKwargs(
  chatTemplateKwargs?: Record<string, unknown>,
): Record<string, unknown> {
  const enableThinking = chatTemplateKwargs?.enable_thinking ?? false
  const resolved: Record<string, unknown> = {
    ...chatTemplateKwargs,
    enable_thinking: enableThinking,
    thinking: enableThinking,
  }
  if (enableThinking) {
    resolved.preserve_thinking = true
    resolved.clear_thinking = false
  }
  return resolved
}

/** Tries profile.model, then each fallback model in rank order. */
export async function withModelFallback<T>(
  profile: AgentProfile,
  attempt: (profile: AgentProfile) => Promise<T>,
  onEvent?: OnRetryEvent,
): Promise<T> {
  // Build the candidate list: primary first, then fallbacks.
  const primaryParams: ModelParams = {
    model: profile.model,
    temperature: profile.temperature,
    responseLimit: profile.responseLimit,
    contextLimit: profile.contextLimit,
    presencePenalty: profile.presencePenalty,
    frequencyPenalty: profile.frequencyPenalty,
    repetitionPenalty: profile.repetitionPenalty,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    concurrencyCost: profile.concurrencyCost,
    configId: profile.configId,
  }
  const candidates: ModelParams[] = [
    primaryParams,
    ...(profile.fallbackProfiles ??
      profile.fallbackModels?.map((model, i) => ({
        ...primaryParams,
        model,
        configId: profile.fallbackConfigIds?.[i],
      })) ??
      []),
  ]
  let lastError: unknown

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    try {
      return await withTransientRetry(
        () => attempt({ ...profile, ...candidate }),
        (retryAttempt, delayMs, status) =>
          onEvent?.({
            kind: 'transient-retry',
            model: candidate.model,
            attempt: retryAttempt,
            delayMs,
            status,
          }),
      )
    } catch (err) {
      lastError = err
      const isLast = i === candidates.length - 1
      if (
        isLast ||
        !(err instanceof FeatherlessError) ||
        !MODEL_UNAVAILABLE_STATUS_CODES.has(err.status)
      ) {
        throw err
      }
      onEvent?.({
        kind: 'fallback',
        fromModel: candidate.model,
        toModel: candidates[i + 1]!.model,
        candidateIndex: i + 1,
      })
      // fall through to the next candidate.
    }
  }
  throw lastError
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | null
}

export interface StreamHandlers {
  onToken: (text: string) => void
  /** Reasoning/thinking tokens — Featherless DeepSeek uses `delta.reasoning`. */
  onReasoningToken?: (text: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

export interface StreamOptions {
  signal?: AbortSignal
  /** Aborts if no chunk (including the initial response) arrives within this window. */
  idleTimeoutMs?: number
  chatTemplateKwargs?: Record<string, unknown>
}

export const DEFAULT_IDLE_TIMEOUT_MS = 90_000
/** Reasoning models may sit in a thinking phase with sparse or reasoning-only chunks. */
export const REASONING_IDLE_TIMEOUT_MS = 300_000

/** Guesses, before any response arrives, whether the model will think; used only to size the idle timeout. */
export function usesThinkingMode(
  model: string,
  chatTemplateKwargs?: Record<string, unknown>,
): boolean {
  if (chatTemplateKwargs?.enable_thinking === true) return true
  if (chatTemplateKwargs?.enable_thinking === false) return false
  return isReasoningModel(model)
}

export function streamIdleTimeoutMs(
  model: string,
  chatTemplateKwargs?: Record<string, unknown>,
): number {
  return usesThinkingMode(model, chatTemplateKwargs)
    ? REASONING_IDLE_TIMEOUT_MS
    : DEFAULT_IDLE_TIMEOUT_MS
}

const COMPLETION_TIMEOUT_MS = 60_000

/** A hung or abandoned Featherless request must not be able to hold a concurrency slot forever. */
function armTimeout(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; reset: () => void; cleanup: () => void } {
  const controller = new AbortController()
  let timer: NodeJS.Timeout

  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new Error(`no response for ${timeoutMs}ms`)),
      timeoutMs,
    )
  }

  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', onExternalAbort)
  reset()

  return {
    signal: controller.signal,
    reset,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

export async function streamInference(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options?: StreamOptions,
): Promise<void> {
  if (!apiKey) {
    handlers.onError(new Error('No Featherless API key configured — set one in the Agents tab'))
    return
  }

  const inputTokens = estimateMessageTokens(messages)
  const startedAt = Date.now()
  let outputChars = 0
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  logOutboundRequest({ call: 'streamInference', model: profile.model, messages })
  const timeout = armTimeout(idleTimeoutMs, options?.signal)

  let response: Response
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: true,
        ...samplerParams(profile),
        ...(options?.chatTemplateKwargs
          ? { chat_template_kwargs: options.chatTemplateKwargs }
          : {}),
      }),
      signal: timeout.signal,
    })
  } catch (err) {
    timeout.cleanup()
    recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
    handlers.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok || !response.body) {
    const bodyText = await safeText(response)
    timeout.cleanup()
    recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
    handlers.onError(
      new FeatherlessError(
        response.status,
        `Featherless request failed: ${response.status} ${bodyText}`,
      ),
    )
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      timeout.reset()
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          recordOutcome(profile, {
            success: true,
            inputTokens,
            outputTokens: tokensFromChars(outputChars),
          })
          handlers.onDone()
          return
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                reasoning?: string | null
              }
            }>
          }
          const delta = parsed.choices?.[0]?.delta
          const reasoning =
            delta?.reasoning_content ??
            (typeof delta?.reasoning === 'string' ? delta.reasoning : null)
          if (reasoning) {
            outputChars += reasoning.length
            handlers.onReasoningToken?.(reasoning)
          }
          const content = delta?.content
          if (content) {
            outputChars += content.length
            handlers.onToken(content)
          }
        } catch {
          // ignore malformed SSE chunk.
        }
      }
    }
    const latency = Date.now() - startedAt
    const outTok = tokensFromChars(outputChars)
    logOutboundResponse('streamInference', profile.model, {
      success: true,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
    })
    recordOutcome(profile, { success: true, inputTokens, outputTokens: outTok })
    handlers.onDone()
  } catch (err) {
    const latency = Date.now() - startedAt
    const outTok = tokensFromChars(outputChars)
    logOutboundResponse('streamInference', profile.model, {
      success: false,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
      error: formatError(err),
    })
    recordOutcome(profile, { success: false, inputTokens, outputTokens: outTok })
    if (err instanceof Error && err.name === 'AbortError') {
      handlers.onError(new Error(`stream idle timeout (${idleTimeoutMs}ms without provider data)`))
    } else {
      handlers.onError(err instanceof Error ? err : new Error(String(err)))
    }
  } finally {
    timeout.cleanup()
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export interface CompletionWithMeta {
  content: string
  /** `choices[0].finish_reason` verbatim ("stop", "length", …) */
  finishReason: string | null
}

/** A single non-streaming completion. */
export async function completeChatWithMeta(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    chatTemplateKwargs?: Record<string, unknown>
    maxTokens?: number
  },
): Promise<CompletionWithMeta> {
  if (!apiKey) {
    throw new Error('No Featherless API key configured — set one in the Agents tab')
  }

  const inputTokens = estimateMessageTokens(messages)
  logOutboundRequest({ call: 'completeChat', model: profile.model, messages })
  const startedAt = Date.now()
  const timeout = armTimeout(options?.timeoutMs ?? COMPLETION_TIMEOUT_MS, options?.signal)
  // completeChat has no reasoning/answer split (no streaming, no ReasoningStreamSplitter)
  const chatTemplateKwargs = resolveChatTemplateKwargs(options?.chatTemplateKwargs)
  try {
    const response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: options?.maxTokens ?? profile.responseLimit,
        stream: false,
        ...samplerParams(profile),
        chat_template_kwargs: chatTemplateKwargs,
      }),
      signal: timeout.signal,
    })

    if (!response.ok) {
      const latency = Date.now() - startedAt
      const bodyText = await safeText(response)
      logOutboundResponse('completeChat', profile.model, {
        success: false,
        latencyMs: latency,
        inputTokens,
        outputTokens: 0,
        retries: 0,
        error: `HTTP ${response.status}: ${bodyText}`,
      })
      recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
      throw new FeatherlessError(
        response.status,
        `Featherless request failed: ${response.status} ${bodyText}`,
      )
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
    }
    const rawContent = data.choices?.[0]?.message?.content
    const finishReason = data.choices?.[0]?.finish_reason ?? null
    const content = rawContent ? stripThinkingTags(rawContent) : rawContent
    if (!content) {
      const latency = Date.now() - startedAt
      logOutboundResponse('completeChat', profile.model, {
        success: false,
        latencyMs: latency,
        inputTokens,
        outputTokens: 0,
        retries: 0,
        error: 'model returned empty completion',
      })
      recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
      throw new Error('model returned an empty completion')
    }

    const latency = Date.now() - startedAt
    const outTok = estimateTokens(content)
    logOutboundResponse('completeChat', profile.model, {
      success: true,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
    })
    recordOutcome(profile, { success: true, inputTokens, outputTokens: outTok })
    return { content, finishReason }
  } finally {
    timeout.cleanup()
  }
}

/** completeChatWithMeta minus the metadata — the common case. */
export async function completeChat(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    chatTemplateKwargs?: Record<string, unknown>
    maxTokens?: number
  },
): Promise<string> {
  return (await completeChatWithMeta(profile, apiKey, messages, options)).content
}
