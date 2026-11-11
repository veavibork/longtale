import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { STORY_SCHEMA_SQL } from './story-schema.js'
import { recoverStaleJobs } from './job-store.js'

import { storiesDir, storyDbPath as storyDbPathForId } from './data-paths.js'

export function storyDbPath(storyId: string): string {
  return storyDbPathForId(storyId)
}

const openStoryDbs = new Map<string, Database.Database>()

export function closeStoryDb(storyId: string): void {
  const db = openStoryDbs.get(storyId)
  if (!db) return
  db.close()
  openStoryDbs.delete(storyId)
}

/** skipRecovery is for read-only diagnostic opens, which must not reset running jobs. */
export function getStoryDb(
  storyId: string,
  options?: { skipRecovery?: boolean },
): Database.Database {
  const existing = openStoryDbs.get(storyId)
  if (existing) return existing

  mkdirSync(storiesDir(), { recursive: true })
  const db = new Database(storyDbPath(storyId))
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.exec(STORY_SCHEMA_SQL)
    if (!options?.skipRecovery) recoverStaleJobs(db)
  } catch (err) {
    // Setup threw after the handle was opened but before it was registered in openStoryDbs.
    try {
      db.close()
    } catch {
      // already closed/broken — nothing more we can do.
    }
    throw err
  }
  openStoryDbs.set(storyId, db)
  return db
}
