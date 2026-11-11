import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { GLOBAL_SCHEMA_SQL } from './global-schema.js'
import { dataDir, globalDbPath } from './data-paths.js'

let db: Database.Database | null = null

export function getGlobalDb(): Database.Database {
  if (db) return db
  mkdirSync(dataDir(), { recursive: true })
  db = new Database(globalDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(GLOBAL_SCHEMA_SQL)
  return db
}

export function closeGlobalDb(): void {
  db?.close()
  db = null
}
