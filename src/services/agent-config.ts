import type Database from 'better-sqlite3'
import { getGlobalDb } from '../db/global-db.js'
import {
  listModelConfigs,
  createModelConfig,
  type ModelConfigRow,
  type AgentRole,
} from '../db/model-config-store.js'
import {
  DEFAULT_AUTHOR_PROFILE,
  DEFAULT_WORKER_PROFILE,
  DEFAULT_EDITOR_PROFILE,
  type AgentProfile,
  type ModelParams,
} from '../config.js'

export type { AgentRole } from '../db/model-config-store.js'

const DEFAULTS: Record<AgentRole, AgentProfile> = {
  author: DEFAULT_AUTHOR_PROFILE,
  worker: DEFAULT_WORKER_PROFILE,
  editor: DEFAULT_EDITOR_PROFILE,
}

const ROLE_ORDER: AgentRole[] = ['author', 'worker', 'editor']

/** Seeds a new user's model list from the built-in defaults. */
function ensureModelConfigsSeeded(db: Database.Database, userId: string): void {
  if (listModelConfigs(db, userId).length > 0) return

  for (const role of ROLE_ORDER) {
    const profile = DEFAULTS[role]
    const roleFlags = {
      useAuthor: role === 'author',
      useEditor: role === 'editor',
      useWorker: role === 'worker',
    }
    createModelConfig(db, userId, {
      provider: 'featherless',
      model: profile.model,
      temperature: profile.temperature,
      responseLimit: profile.responseLimit,
      contextLimit: profile.contextLimit,
      active: true,
      ...roleFlags,
    })
    for (const fallbackModel of profile.fallbackModels ?? []) {
      createModelConfig(db, userId, {
        provider: 'featherless',
        model: fallbackModel,
        temperature: profile.temperature,
        responseLimit: profile.responseLimit,
        contextLimit: profile.contextLimit,
        active: true,
        ...roleFlags,
      })
    }
  }
}

function roleFlag(row: ModelConfigRow, role: AgentRole): boolean {
  if (role === 'author') return row.useAuthor
  if (role === 'editor') return row.useEditor
  return row.useWorker
}

/** Ranked-fallback profile for a role: active rows with its flag in sort order, else the config default. */
export function getAgentProfile(userId: string, role: AgentRole): AgentProfile {
  const db = getGlobalDb()
  ensureModelConfigsSeeded(db, userId)

  const rows = listModelConfigs(db, userId).filter((r) => r.active && roleFlag(r, role))
  if (!rows.length) return DEFAULTS[role]

  const [primary, ...fallbacks] = rows
  return {
    provider: primary.provider,
    model: primary.model,
    temperature: primary.temperature,
    responseLimit: primary.responseLimit,
    contextLimit: primary.contextLimit,
    presencePenalty: primary.presencePenalty ?? undefined,
    frequencyPenalty: primary.frequencyPenalty ?? undefined,
    repetitionPenalty: primary.repetitionPenalty ?? undefined,
    topP: primary.topP ?? undefined,
    topK: primary.topK ?? undefined,
    minP: primary.minP ?? undefined,
    concurrencyCost: primary.concurrencyCost ?? DEFAULTS[role].concurrencyCost,
    configId: primary.id,
    fallbackModels: fallbacks.map((f) => f.model),
    fallbackConfigIds: fallbacks.map((f) => f.id),
    fallbackProfiles: fallbacks.map((f): ModelParams => ({
      model: f.model,
      temperature: f.temperature,
      responseLimit: f.responseLimit,
      contextLimit: f.contextLimit,
      presencePenalty: f.presencePenalty ?? undefined,
      frequencyPenalty: f.frequencyPenalty ?? undefined,
      repetitionPenalty: f.repetitionPenalty ?? undefined,
      topP: f.topP ?? undefined,
      topK: f.topK ?? undefined,
      minP: f.minP ?? undefined,
      concurrencyCost: f.concurrencyCost ?? DEFAULTS[role].concurrencyCost,
      configId: f.id,
    })),
  }
}
