import Database from 'better-sqlite3'
import { STORY_SCHEMA_SQL } from '../../src/db/story-schema.js'
import { GLOBAL_SCHEMA_SQL } from '../../src/db/global-schema.js'

/** Fresh in-memory DB with the story schema. */
export function createStoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(STORY_SCHEMA_SQL)
  return db
}

/** Fresh in-memory DB with global schema. */
export function createGlobalDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(GLOBAL_SCHEMA_SQL)
  return db
}
