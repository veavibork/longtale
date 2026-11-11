import { Hono, type Context } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  listModelConfigs,
  createModelConfig,
  getModelConfig,
  updateModelConfig,
  deleteModelConfig,
  reorderModelConfigs,
  type ModelConfigInput,
} from '../db/model-config-store.js'
import { getAgentProfile } from '../services/agent-config.js'
import { listModels, getModel } from '../inference/featherless-models.js'
import { getHfTagsForModel } from '../inference/hf-model-tags.js'
import { listTextModels } from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'
import { getModelFormatProfile, requestModelProbe } from '../db/model-format-profile-store.js'

export const agentsRoute = new Hono<{ Variables: AppVariables }>()

export interface CatalogModel {
  id: string
  contextLength?: number
  concurrencyCost?: number
  toolUse?: boolean
  hfTags?: string[]
}

// Provider-dispatching model catalog lookup, used by Config > Agents' "Fetch models" action.
agentsRoute.get('/models', async (c) => {
  const provider = c.req.query('provider') ?? 'featherless'
  const db = getGlobalDb()
  const userId = c.get('userId')
  if (provider === 'featherless') {
    const apiKey = getDecryptedFeatherlessKey(db, userId)
    if (!apiKey)
      return c.json({ error: 'No Featherless API key configured — set one in the Agents tab' }, 400)
    const models = await listModels(apiKey, { perPage: 200 })
    const configs = listModelConfigs(db, userId).filter((c) => c.provider === 'featherless')
    for (const m of models) {
      if (m.concurrencyCost == null) continue
      for (const cfg of configs.filter(
        (c) => c.model === m.id && c.concurrencyCost !== m.concurrencyCost,
      )) {
        updateModelConfig(db, userId, cfg.id, { concurrencyCost: m.concurrencyCost })
      }
    }
    const catalog: CatalogModel[] = models.map((m) => ({
      id: m.id,
      contextLength: m.contextLength,
      concurrencyCost: m.concurrencyCost,
      toolUse: m.toolUse,
      hfTags: getHfTagsForModel(m.id),
    }))
    return c.json({ models: catalog })
  }
  if (provider === 'horde') {
    const models = await listTextModels(getDecryptedHordeKey(db, userId))
    const catalog: CatalogModel[] = models.map((m) => ({ id: m.name }))
    return c.json({ models: catalog })
  }
  return c.json({ error: `unsupported provider: ${provider}` }, 400)
})

const DEFAULT_NEW_MODEL: ModelConfigInput = {
  provider: 'featherless',
  model: '',
  temperature: 1.0,
  responseLimit: 4096,
  contextLimit: 32000,
  useAuthor: false,
  useEditor: false,
  useWorker: false,
  active: true,
}

const patchSchema = z.object({
  provider: z.enum(['featherless', 'horde']).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(5).optional(),
  responseLimit: z.number().int().positive().max(1_000_000).optional(),
  contextLimit: z.number().int().positive().max(10_000_000).optional(),
  presencePenalty: z.number().min(-5).max(5).nullable().optional(),
  frequencyPenalty: z.number().min(-5).max(5).nullable().optional(),
  repetitionPenalty: z.number().min(0).max(5).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  topK: z.number().min(0).max(100_000).nullable().optional(),
  minP: z.number().min(0).max(1).nullable().optional(),
  concurrencyCost: z.number().min(0).max(100).nullable().optional(),
  useAuthor: z.boolean().optional(),
  useEditor: z.boolean().optional(),
  useWorker: z.boolean().optional(),
  active: z.boolean().optional(),
})

const reorderSchema = z.object({
  orderedIds: z.array(z.string().max(100)).max(500),
})

// Ensures Config > Agents always reflects the current live state.
function ensureSeeded(c: Context<{ Variables: AppVariables }>): {
  db: ReturnType<typeof getGlobalDb>
  userId: string
} {
  const db = getGlobalDb()
  const userId = c.get('userId')
  getAgentProfile(userId, 'author') // triggers ensureModelConfigsSeeded as a side effect
  return { db, userId }
}

agentsRoute.get('/', (c) => {
  const { db, userId } = ensureSeeded(c)
  return c.json({ configs: listModelConfigs(db, userId) })
})

agentsRoute.post('/', (c) => {
  const { db, userId } = ensureSeeded(c)
  const created = createModelConfig(db, userId, DEFAULT_NEW_MODEL)
  return c.json({ config: created })
})

agentsRoute.patch('/:id', sValidator('json', patchSchema, validationHook), async (c) => {
  const body = c.req.valid('json')
  const { db, userId } = ensureSeeded(c)
  const id = c.req.param('id')!
  // Read first: the provider decides whether to look up the model's concurrency cost.
  const current = getModelConfig(db, id)
  if (!current || current.userId !== userId) return c.json({ error: 'model config not found' }, 404)

  const patch: Partial<ModelConfigInput> = { ...body }
  if (typeof patch.model === 'string') patch.model = patch.model.trim()

  // When the model string changes, fetch its actual concurrency cost from Featherless so slot reservations.
  const effectiveProvider = patch.provider ?? current.provider
  if (patch.model && effectiveProvider !== 'horde') {
    const apiKey = getDecryptedFeatherlessKey(db, userId)
    if (apiKey) {
      try {
        const modelInfo = await getModel(apiKey, patch.model)
        if (modelInfo?.concurrencyCost != null) {
          patch.concurrencyCost = modelInfo.concurrencyCost
        }
      } catch {
        // Model lookup failed — leave concurrencyCost as-is (existing value or null).
      }
    }
  }

  const updated = updateModelConfig(db, userId, id, patch)
  if (!updated) return c.json({ error: 'model config not found' }, 404)

  // Queue a format probe the first time a Featherless config is saved with a never-probed model.
  if (
    updated.provider === 'featherless' &&
    updated.model &&
    !getModelFormatProfile(db, 'featherless', updated.model)
  ) {
    requestModelProbe(db, 'featherless', updated.model, userId)
  }

  return c.json({ config: updated })
})

agentsRoute.delete('/:id', (c) => {
  const { db, userId } = ensureSeeded(c)
  const id = c.req.param('id')!
  if (!deleteModelConfig(db, userId, id)) return c.json({ error: 'model config not found' }, 404)
  return c.json({ ok: true })
})

agentsRoute.post('/reorder', sValidator('json', reorderSchema, validationHook), (c) => {
  const { orderedIds } = c.req.valid('json')
  const { db, userId } = ensureSeeded(c)
  reorderModelConfigs(db, userId, orderedIds)
  return c.json({ configs: listModelConfigs(db, userId) })
})
