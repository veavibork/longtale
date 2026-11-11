import type Database from 'better-sqlite3'
import {
  createWorldbookEntry,
  type WorldbookEntry,
  type WorldbookEntryType,
} from '../../db/worldbook-store.js'

export interface ExtractedBlock {
  entryType: WorldbookEntryType
  content: string
}

// Same pattern as web/src/lib/worldbookBlocks.ts; backend and frontend share no module, so keep both in sync.
const BLOCK_PATTERN = /\[(CONTENT|ROSTER|MEMORY)\]([\s\S]*?)\[\/\1\]/g

/** Pulls [CONTENT]/[ROSTER]/[MEMORY] blocks out of raw Editor prose. */
export function extractWorldbookBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    const entryType = match[1].toLowerCase() as WorldbookEntryType
    const content = match[2].trim()
    if (content) blocks.push({ entryType, content })
  }
  return blocks
}

/** Extracts blocks from Editor output and creates a worldbook entry for each. */
export function applyExtractedWorldbookBlocks(
  db: Database.Database,
  worldbookBookId: string,
  text: string,
): WorldbookEntry[] {
  const created: WorldbookEntry[] = []
  for (const block of extractWorldbookBlocks(text)) {
    const entry = createWorldbookEntry(db, {
      bookId: worldbookBookId,
      entryType: block.entryType,
      content: block.content,
    })
    created.push(entry)
  }
  return created
}
