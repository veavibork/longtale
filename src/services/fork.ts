import { copyFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { getStoryDb, storyDbPath } from '../db/story-db.js'
import { createStory, type StoryRow } from '../db/story-store.js'
import { getBookByType } from '../db/book-store.js'
import { findHeadPageId, getPage, setSelectedFork, setPageHidden } from '../db/page-store.js'
import { setCurrentPageId } from '../db/story-state-store.js'
import { pruneStoryToDateOffActiveChain } from '../services/context/invalidation.js'

/** "Fork" per the schema-design decision: a genuinely new save slot. */
export function forkStory(
  globalDb: Database.Database,
  sourceDb: Database.Database,
  input: {
    ownerUserId: string
    sourceStoryId: string
    sourceName: string
    name?: string
    forkPageId?: string | null
  },
): StoryRow {
  const logbook = getBookByType(sourceDb, 'logbook')
  if (!logbook) throw new Error('logbook not found')

  const headPageId = findHeadPageId(sourceDb, logbook.id)
  if (!headPageId) throw new Error('story has no posts yet')
  const forkPageId = input.forkPageId ?? headPageId
  if (!getPage(sourceDb, forkPageId)) throw new Error('fork point page not found')

  // Flush WAL into the main file so the copy below captures everything committed so far.
  sourceDb.pragma('wal_checkpoint(TRUNCATE)')

  const newStory = createStory(globalDb, {
    ownerUserId: input.ownerUserId,
    name: input.name?.trim() || defaultForkName(input.sourceName),
    parentStoryId: input.sourceStoryId,
  })
  copyFileSync(storyDbPath(input.sourceStoryId), storyDbPath(newStory.id))

  const newDb = getStoryDb(newStory.id)

  // Hide everything after the fork point, then sever its forward pointer.
  let cursor = getPage(newDb, forkPageId)?.selectedForkPageId ?? null
  while (cursor) {
    setPageHidden(newDb, cursor, true)
    cursor = getPage(newDb, cursor)?.selectedForkPageId ?? null
  }
  setSelectedFork(newDb, forkPageId, null)
  setCurrentPageId(newDb, null)
  pruneStoryToDateOffActiveChain(newDb, input.ownerUserId, logbook.id, newStory.id)

  return newStory
}

function defaultForkName(sourceName: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${sourceName} — Fork — ${stamp}`
}
