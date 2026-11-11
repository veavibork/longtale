/** Provider dispatch — Featherless streaming with model fallback. */
import type { AgentProfile } from '../config.js'
import {
  streamInference,
  withModelFallback,
  FeatherlessError,
  JobCancelledError,
  resolveChatTemplateKwargs,
  REASONING_ASSISTANT_PREFILL,
  type ChatMessage,
} from '../inference/featherless.js'
import {
  shouldPrefillThink,
  profiledStreamIdleTimeoutMs,
  splitterTagsForModel,
  reportFormatDrift,
} from '../services/model-format.js'
import { ReasoningStreamSplitter } from '../inference/reasoning-stream.js'
import {
  publishToken,
  publishThinking,
  publishStreamReset,
  retryProgressPublisher,
} from './job-events.js'
import { streamingModels } from './cancel.js'

const EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE = 2

/** Streams a reply with model fallback, treating an empty-but-error-free completion as a retriable failure. */
export async function streamWithFallback(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  jobId: string,
  signal?: AbortSignal,
  chatTemplateKwargs?: Record<string, unknown>,
): Promise<{ text: string; model: string }> {
  const effectiveKwargs = resolveChatTemplateKwargs(chatTemplateKwargs)
  let reply = ''
  let usedModel = profile.model
  let isFirstStream = true
  const onRetryEvent = retryProgressPublisher(jobId)
  await withModelFallback(
    profile,
    async (candidate) => {
      usedModel = candidate.model
      streamingModels.set(jobId, candidate.model)
      const usePrefill = shouldPrefillThink(candidate.model, effectiveKwargs)
      const candidateMessages = usePrefill
        ? [...messages, { role: 'assistant' as const, content: REASONING_ASSISTANT_PREFILL }]
        : messages
      const splitterTags = splitterTagsForModel(candidate.model)

      for (let attempt = 1; attempt <= EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE; attempt++) {
        if (!isFirstStream) {
          publishStreamReset(
            jobId,
            { thinking: true, text: true },
            `Retrying… (attempt ${attempt})`,
          )
        }
        isFirstStream = false

        const splitter = new ReasoningStreamSplitter({ startsInThinking: false, ...splitterTags })
        reply = ''
        // Field vs inline tracked separately — the drift tripwire below needs to know HOW reasoning arrived.
        let sawReasoningField = false
        let sawInlineThinking = false
        const emitInlineThinking = (text: string) => {
          sawInlineThinking = true
          publishThinking(jobId, text)
        }
        const emitFieldThinking = (text: string) => {
          sawReasoningField = true
          publishThinking(jobId, text)
        }
        const emitAnswer = (text: string) => {
          reply += text
          publishToken(jobId, text)
        }
        try {
          await new Promise<void>((resolve, reject) => {
            void streamInference(
              candidate,
              apiKey,
              candidateMessages,
              {
                onToken: (text) => {
                  splitter.push(text, emitInlineThinking, emitAnswer)
                },
                onReasoningToken: emitFieldThinking,
                onDone: () => {
                  splitter.flush(emitInlineThinking, emitAnswer)
                  if (reply.trim()) {
                    resolve()
                  } else if (sawReasoningField || sawInlineThinking) {
                    reject(
                      new FeatherlessError(
                        503,
                        `${candidate.model} returned reasoning but no answer content`,
                      ),
                    )
                  } else {
                    reject(
                      new FeatherlessError(503, `${candidate.model} returned an empty completion`),
                    )
                  }
                },
                onError: reject,
              },
              {
                signal,
                chatTemplateKwargs: effectiveKwargs,
                idleTimeoutMs: profiledStreamIdleTimeoutMs(candidate.model, effectiveKwargs),
              },
            )
          })
          // Drift tripwire: a successful stream that contradicts the stored profile flags the model for re-probe.
          try {
            reportFormatDrift(candidate.model, effectiveKwargs, {
              sawReasoningField,
              sawInlineThinking,
              answerText: reply,
            })
          } catch {
            /* diagnostics only; never fail a generation that already succeeded */
          }
          return
        } catch (err) {
          if (err instanceof JobCancelledError) throw err
          const isEmptyCompletion =
            err instanceof FeatherlessError &&
            (err.message.includes('empty completion') || err.message.includes('no answer content'))
          if (!isEmptyCompletion || attempt === EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE) throw err
        }
      }
    },
    onRetryEvent,
  )
  return { text: reply, model: usedModel }
}
