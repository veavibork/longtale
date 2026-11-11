import type Database from 'better-sqlite3'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'

export interface PageRow {
  id: string
  createdAt: string
  bookId: string
  prevPageId: string | null
  selectedForkPageId: string | null
  selectedTextId: string | null
  selectTime: string | null
  hidden: boolean
  broken: boolean
  /** SHA-256 of normalized canonical gen_package for integrity comparison. */
  contentHash: string | null
}

interface RawPageRow {
  id: string
  created_at: string
  book_id: string
  prev_page_id: string | null
  selected_fork_page_id: string | null
  selected_text_id: string | null
  select_time: string | null
  hidden: number
  broken: number
  content_hash: string | null
}

function mapPageRow(row: RawPageRow): PageRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    bookId: row.book_id,
    prevPageId: row.prev_page_id,
    selectedForkPageId: row.selected_fork_page_id,
    selectedTextId: row.selected_text_id,
    selectTime: row.select_time,
    hidden: !!row.hidden,
    broken: !!row.broken,
    contentHash: row.content_hash ?? null,
  }
}

/** Creating a page with a prevPageId always makes it that parent's active fork. */
export function createPage(
  db: Database.Database,
  input: { bookId: string; prevPageId?: string | null },
): PageRow {
  const id = newId()
  const prevPageId = input.prevPageId ?? null
  db.prepare(
    `INSERT INTO page (id, created_at, book_id, prev_page_id, selected_fork_page_id, selected_text_id, select_time, hidden, broken)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0)`,
  ).run(id, nowIso(), input.bookId, prevPageId)
  if (prevPageId) setSelectedFork(db, prevPageId, id)
  return getPage(db, id)!
}

export function getPage(db: Database.Database, id: string): PageRow | null {
  const row = db.prepare(`SELECT * FROM page WHERE id = ?`).get(id) as RawPageRow | undefined
  return row ? mapPageRow(row) : null
}

/** The one page in a book with no prev_page_id — the start of its chain. */
export function findRootPageId(db: Database.Database, bookId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM page WHERE book_id = ? AND prev_page_id IS NULL LIMIT 1`)
    .get(bookId) as { id: string } | undefined
  return row?.id ?? null
}

/** The tip of the currently active path: walk forward from the root via selected_fork_page_id until a page. */
export function findHeadPageId(db: Database.Database, bookId: string): string | null {
  let current = findRootPageId(db, bookId)
  while (current) {
    const page = getPage(db, current)
    if (!page?.selectedForkPageId) return current
    current = page.selectedForkPageId
  }
  return null
}

/** Every page on the currently active path, oldest first — see findHeadPageId for what "active" means. */
export function listChronologicalPages(db: Database.Database, bookId: string): PageRow[] {
  const pages: PageRow[] = []
  let currentId: string | null = findRootPageId(db, bookId)
  while (currentId) {
    const page = getPage(db, currentId)
    if (!page) break
    pages.push(page)
    currentId = page.selectedForkPageId
  }
  return pages
}

/** Every page in a book, oldest first, by created_at directly. */
export function listPagesForBook(db: Database.Database, bookId: string): PageRow[] {
  const rows = db
    .prepare(`SELECT * FROM page WHERE book_id = ? ORDER BY created_at ASC`)
    .all(bookId) as RawPageRow[]
  return rows.map(mapPageRow)
}

export function setSelectedText(db: Database.Database, pageId: string, textId: string): void {
  db.prepare(`UPDATE page SET selected_text_id = ?, select_time = ? WHERE id = ?`).run(
    textId,
    nowIso(),
    pageId,
  )
}

export function setSelectedFork(
  db: Database.Database,
  pageId: string,
  forkPageId: string | null,
): void {
  db.prepare(`UPDATE page SET selected_fork_page_id = ?, select_time = ? WHERE id = ?`).run(
    forkPageId,
    nowIso(),
    pageId,
  )
}

/** Every page from the given one back to the root, via prev_page_id. */
export function collectAncestorIds(db: Database.Database, pageId: string): Set<string> {
  const ids = new Set<string>()
  let current: string | null = pageId
  while (current) {
    ids.add(current)
    const page: PageRow | null = getPage(db, current)
    current = page?.prevPageId ?? null
  }
  return ids
}

export function setPageHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE page SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id)
}

export function setContentHash(db: Database.Database, pageId: string, stamp: string | null): void {
  db.prepare(`UPDATE page SET content_hash = ? WHERE id = ?`).run(stamp, pageId)
}
