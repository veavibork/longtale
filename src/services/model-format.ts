/** Format decisions (prefill, idle timeout, splitter tags) driven by a model's probed profile. */
import { getGlobalDb } from '../db/global-db.js'
import { getModelFormatProfile, recordFormatDrift } from '../db/model-format-profile-store.js'
import { runtimeLeakScanTokens } from '../data/format-hypotheses.js'
import { createLogger } from '../inference/outbound-telemetry.js'
import type { ModelFormatProfile } from '../inference/format-probe.js'
import {
  isReasoningModel,
  streamIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  REASONING_IDLE_TIMEOUT_MS,
} from '../inference/featherless.js'
import { DEFAULT_OPEN_TAGS, DEFAULT_CLOSE_TAGS } from '../inference/reasoning-stream.js'

/** Last successfully probed profile for a Featherless model, or null. */
export function getProbedProfile(model: string): ModelFormatProfile | null {
  const row = getModelFormatProfile(getGlobalDb(), 'featherless', model)
  const profile = row?.profile ?? null
  if (!profile || profile.callsSucceeded === 0) return null
  return profile
}

/** Whether to prefill the assistant turn with `<think>\n` (REASONING_ASSISTANT_PREFILL). */
export function shouldPrefillThinkFor(
  profile: ModelFormatProfile | null,
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): boolean {
  if (resolvedKwargs?.enable_thinking !== true) return false
  if (profile) return profile.family === 'deepseek' && profile.thinkingOnProduces !== false
  return isReasoningModel(model)
}

export function shouldPrefillThink(
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): boolean {
  return shouldPrefillThinkFor(getProbedProfile(model), model, resolvedKwargs)
}

/** Idle-timeout budget for a streaming call. */
export function streamIdleTimeoutMsFor(
  profile: ModelFormatProfile | null,
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): number {
  if (!profile) return streamIdleTimeoutMs(model, resolvedKwargs)
  if (resolvedKwargs?.enable_thinking === true) {
    return profile.thinkingOnProduces === false
      ? DEFAULT_IDLE_TIMEOUT_MS
      : REASONING_IDLE_TIMEOUT_MS
  }
  return profile.thinkingOffSuppresses === false
    ? REASONING_IDLE_TIMEOUT_MS
    : DEFAULT_IDLE_TIMEOUT_MS
}

export function profiledStreamIdleTimeoutMs(
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): number {
  return streamIdleTimeoutMsFor(getProbedProfile(model), model, resolvedKwargs)
}

/** Tag lists for ReasoningStreamSplitter: the hardcoded `<think>` pair always stays. */
export function splitterTagsFor(profile: ModelFormatProfile | null): {
  openTags: string[]
  closeTags: string[]
} {
  const openTags = [...DEFAULT_OPEN_TAGS]
  const closeTags = [...DEFAULT_CLOSE_TAGS]
  const tag = profile?.inlineThinkingTag
  if (tag) {
    if (!openTags.includes(tag.open)) openTags.push(tag.open)
    if (!closeTags.includes(tag.close)) closeTags.push(tag.close)
  }
  return { openTags, closeTags }
}

export function splitterTagsForModel(model: string): { openTags: string[]; closeTags: string[] } {
  return splitterTagsFor(getProbedProfile(model))
}

// --------------------------------------------------------------------------- Runtime drift tripwire

/** What one successful stream actually did — collected in streamWithFallback. */
export interface StreamFormatObservation {
  /** Reasoning arrived via a separate delta field (onReasoningToken fired). */
  sawReasoningField: boolean
  /** Reasoning arrived via inline tags the splitter recognized. */
  sawInlineThinking: boolean
  /** Final answer text after splitting. */
  answerText: string
}

/** Compares a live stream against the stored profile and returns human-readable contradictions. */
export function detectFormatDriftFor(
  profile: ModelFormatProfile | null,
  resolvedKwargs: Record<string, unknown> | undefined,
  observed: StreamFormatObservation,
): string[] {
  if (!profile) return []
  const reasons: string[] = []
  const thinkingOn = resolvedKwargs?.enable_thinking === true

  if (
    !thinkingOn &&
    profile.thinkingOffSuppresses === true &&
    (observed.sawReasoningField || observed.sawInlineThinking)
  ) {
    reasons.push(
      'reasoning appeared with thinking off, but the profile says the off switch suppresses it',
    )
  }
  if (observed.sawReasoningField && profile.reasoningFieldName === null) {
    reasons.push('a separate reasoning delta field appeared that the probe never observed')
  }
  if (observed.sawInlineThinking && profile.inlineThinkingTag === null) {
    reasons.push('inline thinking tags appeared that the probe never observed')
  }

  const knownLeaks = new Set(profile.leakTokensSeen)
  for (const token of runtimeLeakScanTokens()) {
    if (!knownLeaks.has(token) && observed.answerText.includes(token)) {
      reasons.push(`template token leaked into the answer: ${token}`)
    }
  }
  return reasons
}

/** Evaluate + persist drift for one finished stream. */
export function reportFormatDrift(
  model: string,
  resolvedKwargs: Record<string, unknown> | undefined,
  observed: StreamFormatObservation,
): void {
  const profile = getProbedProfile(model)
  const reasons = detectFormatDriftFor(profile, resolvedKwargs, observed)
  if (!reasons.length) return
  const firstDetection = recordFormatDrift(getGlobalDb(), 'featherless', model, reasons)
  createLogger({ jobType: 'format-drift' }).warn('stream contradicted stored format profile', {
    model,
    reasons,
    firstDetection,
    answerHead: observed.answerText.slice(0, 200),
  })
}
