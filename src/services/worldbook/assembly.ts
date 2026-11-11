import type Database from 'better-sqlite3'
import { getBookByType } from '../../db/book-store.js'
import { listContentEntries } from '../../db/worldbook-store.js'

/** Parse Register/tone line from CONTENT (Editor schema: "Register: ..."). */
export function resolveRegisterFromContent(db: Database.Database): string | null {
  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) return null

  for (const entry of listContentEntries(db, worldbook.id)) {
    const match = entry.content.match(/^Register:\s*(.+)$/im)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return null
}
