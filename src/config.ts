try {
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is.
}

/** Per-model parameters that can differ across fallback candidates. */
export interface ModelParams {
  model: string
  temperature: number
  responseLimit: number
  contextLimit: number
  /** Optional sampler params (Featherless completions API) */
  presencePenalty?: number
  frequencyPenalty?: number
  repetitionPenalty?: number
  topP?: number
  topK?: number
  minP?: number
  /** Featherless-reported per-call concurrency cost (src/queue/slots.ts) — a property of the model. */
  concurrencyCost?: number
  /** The model_configs row backing `model` above, when built from Config > Agents' DB-backed list. */
  configId?: string
}

export interface AgentProfile extends ModelParams {
  /** Absent/undefined treated as "featherless" everywhere — every pre-Horde call site keeps working unchanged. */
  provider?: 'featherless' | 'horde'
  /** Ranked-choice fallback (docs/architecture.md's Provider Abstraction section) */
  fallbackModels?: string[]
  /** Parallel to fallbackModels — the model_configs row id for each fallback candidate, same order. */
  fallbackConfigIds?: string[]
  /** Full per-candidate params for ranked fallback — each carries its own temperature, sampler params. */
  fallbackProfiles?: ModelParams[]
}

// Defaults, used when Config > Agents has no saved override yet.
export const DEFAULT_AUTHOR_PROFILE: AgentProfile = {
  model: process.env.AUTHOR_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
  temperature: 1.0,
  responseLimit: 4096,
  contextLimit: 32000,
  provider: 'featherless',
  concurrencyCost: 1,
}

// The worker only summarizes existing text, so it favors tool-calling reliability over creative range.
export const DEFAULT_WORKER_PROFILE: AgentProfile = {
  model: process.env.WORKER_MODEL ?? 'NousResearch/Hermes-3-Llama-3.1-8B',
  temperature: 0.5,
  responseLimit: 2048,
  contextLimit: 16000,
  provider: 'featherless',
  concurrencyCost: 1,
}

export const DEFAULT_EDITOR_PROFILE: AgentProfile = {
  model: process.env.EDITOR_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
  temperature: 0.7,
  responseLimit: 4096,
  contextLimit: 32000,
  provider: 'featherless',
  concurrencyCost: 1,
}
