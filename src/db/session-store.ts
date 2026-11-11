import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { nowIso } from '../lib/time.js'

export interface SessionRow {
  id: string
  userId: string
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
}

interface RawSessionRow {
  id: string
  user_id: string
  created_at: string
  last_seen_at: string
  revoked_at: string | null
}

function mapRow(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

/** Atomically evicts whichever session currently holds the claim (if any) and installs a new one. */
export function createSession(db: Database.Database, userId: string): SessionRow {
  const id = randomBytes(32).toString('hex')
  const now = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(
      now,
      userId,
    )
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
    ).run(id, userId, now, now)
  })
  tx()
  return getSession(db, id)!
}

/** The currently-live claim, if any. */
export function getActiveSession(db: Database.Database, userId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as RawSessionRow | undefined
  return row ? mapRow(row) : null
}

/** Any session by id, revoked or not; shows a superseded session's last-seen time after eviction. */
export function getSession(db: Database.Database, id: string): SessionRow | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as RawSessionRow | undefined
  return row ? mapRow(row) : null
}

/** A session unused (no foreground request) for this long must log in again. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60_000

export function isSessionIdleExpired(
  session: Pick<SessionRow, 'lastSeenAt'>,
  now = Date.now(),
): boolean {
  return now - Date.parse(session.lastSeenAt) > SESSION_IDLE_TIMEOUT_MS
}

export function touchSession(db: Database.Database, id: string): void {
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(nowIso(), id)
}

/** Revokes the active claim without installing a new one. */
export function invalidateActiveSession(db: Database.Database, userId: string): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(
    nowIso(),
    userId,
  )
}
