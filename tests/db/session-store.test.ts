import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createGlobalDb } from './helpers.js'
import { createUser } from '../../src/db/user-store.js'
import {
  createSession,
  getActiveSession,
  getSession,
  touchSession,
  invalidateActiveSession,
  isSessionIdleExpired,
  SESSION_IDLE_TIMEOUT_MS,
} from '../../src/db/session-store.js'

let db: Database.Database
let userId: string

beforeEach(() => {
  db = createGlobalDb()
  userId = createUser(db, 'Test', 'pw').id
})

describe('createSession', () => {
  it('creates a session and evicts previous', () => {
    const s1 = createSession(db, userId)
    expect(s1.id).toBeTruthy()
    expect(s1.userId).toBe(userId)
    expect(s1.revokedAt).toBeNull()

    const s2 = createSession(db, userId)
    expect(s2.userId).toBe(userId)
    expect(s2.revokedAt).toBeNull()
    // s1 should now be revoked.
    expect(getSession(db, s1.id)!.revokedAt).toBeTruthy()
  })
})

describe('getActiveSession', () => {
  it('returns the active session', () => {
    const session = createSession(db, userId)
    const active = getActiveSession(db, userId)
    expect(active).not.toBeNull()
    expect(active!.id).toBe(session.id)
  })

  it('returns null when all sessions revoked', () => {
    invalidateActiveSession(db, userId)
    expect(getActiveSession(db, userId)).toBeNull()
  })
})

describe('touchSession', () => {
  it('touches session without error', () => {
    const session = createSession(db, userId)
    touchSession(db, session.id)
    // touchSession updates lastSeenAt — just verify the call succeeds.
    const updated = getSession(db, session.id)!
    expect(updated.lastSeenAt).toBeTruthy()
  })
})

describe('isSessionIdleExpired', () => {
  const lastSeenAt = '2026-01-01T00:00:00.000Z'
  const lastSeen = Date.parse(lastSeenAt)

  it('keeps a session used within the idle timeout', () => {
    expect(isSessionIdleExpired({ lastSeenAt }, lastSeen + SESSION_IDLE_TIMEOUT_MS)).toBe(false)
  })

  it('expires a session idle for longer than the timeout', () => {
    expect(isSessionIdleExpired({ lastSeenAt }, lastSeen + SESSION_IDLE_TIMEOUT_MS + 1)).toBe(true)
  })

  it('treats a freshly created session as live', () => {
    expect(isSessionIdleExpired(createSession(db, userId))).toBe(false)
  })
})

describe('invalidateActiveSession', () => {
  it('revokes the active session for a user', () => {
    createSession(db, userId)
    invalidateActiveSession(db, userId)
    expect(getActiveSession(db, userId)).toBeNull()
  })
})
