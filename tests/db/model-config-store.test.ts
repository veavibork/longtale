import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createGlobalDb } from './helpers.js'
import { createUser } from '../../src/db/user-store.js'
import {
  createModelConfig,
  deleteModelConfig,
  getModelConfig,
  updateModelConfig,
  type ModelConfigInput,
} from '../../src/db/model-config-store.js'

const INPUT: ModelConfigInput = {
  provider: 'featherless',
  model: 'Qwen/Qwen3-8B',
  temperature: 1,
  responseLimit: 1024,
  contextLimit: 16384,
  useAuthor: true,
  useEditor: false,
  useWorker: false,
  active: true,
}

let db: Database.Database
let owner: string
let other: string

beforeEach(() => {
  db = createGlobalDb()
  owner = createUser(db, 'Owner', 'pw').id
  other = createUser(db, 'Other', 'pw').id
})

describe('model config ownership', () => {
  it('does not let another user update a config', () => {
    const cfg = createModelConfig(db, owner, INPUT)
    expect(updateModelConfig(db, other, cfg.id, { temperature: 0.2 })).toBeNull()
    expect(getModelConfig(db, cfg.id)!.temperature).toBe(1)
    expect(updateModelConfig(db, owner, cfg.id, { temperature: 0.2 })!.temperature).toBe(0.2)
  })

  it('does not let another user delete a config', () => {
    const cfg = createModelConfig(db, owner, INPUT)
    expect(deleteModelConfig(db, other, cfg.id)).toBe(false)
    expect(getModelConfig(db, cfg.id)).not.toBeNull()
    expect(deleteModelConfig(db, owner, cfg.id)).toBe(true)
    expect(getModelConfig(db, cfg.id)).toBeNull()
  })
})
