import type { Context, Next } from 'hono'
import { getGlobalDb } from '../db/global-db.js'
import {
  getActiveSession,
  getSession,
  isSessionIdleExpired,
  touchSession,
} from '../db/session-store.js'

export type AppVariables = { userId: string }

try {
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is.
}

const CLAIM_PATH = '/api/sessions/claim'
// EventSource cannot set headers, so these two GET streams may carry the session id in the URL.
const STREAM_PATH = /^\/api\/stories\/[^/]+\/(events|jobs\/[^/]+\/stream)$/

// Dev-only escape hatch for scripts and tests. Honored only when NODE_ENV is explicitly
// development or test, so a server started without NODE_ENV always enforces sessions.
const BYPASS_SESSION_GUARD =
  process.env.DEV_BYPASS_SESSION_GUARD === 'true' &&
  (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
if (process.env.DEV_BYPASS_SESSION_GUARD === 'true' && !BYPASS_SESSION_GUARD) {
  console.error(
    '[session-guard] DEV_BYPASS_SESSION_GUARD is ignored unless NODE_ENV is development or test.',
  )
}
if (BYPASS_SESSION_GUARD) {
  console.warn(
    '[session-guard] DEV_BYPASS_SESSION_GUARD is set — session enforcement is OFF for all requests.',
  )
}

/** Global single-active-session enforcement. */
export async function sessionGuard(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') return next()
  if (c.req.method === 'POST' && c.req.path === CLAIM_PATH) return next()

  const db = getGlobalDb()

  if (BYPASS_SESSION_GUARD) {
    // Dev escape hatch still needs *some* userId downstream.
    const fallback = db.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get() as
      { id: string } | undefined
    if (fallback) c.set('userId', fallback.id)
    return next()
  }

  const streamQuery =
    c.req.method === 'GET' && STREAM_PATH.test(c.req.path) ? c.req.query('session') : undefined
  const sessionId = c.req.header('X-Longtale-Session') ?? streamQuery

  if (!sessionId) {
    return c.json({ error: 'unclaimed' }, 409)
  }

  const session = getSession(db, sessionId)

  if (!session || session.revokedAt) {
    const active = session ? getActiveSession(db, session.userId) : null
    return c.json(
      {
        error: 'superseded',
        active: active ? { lastSeenAt: active.lastSeenAt } : null,
        stale: session ? { lastSeenAt: session.lastSeenAt } : null,
      },
      409,
    )
  }

  // Rejected requests never touch the session, so it stays expired until the next login replaces it.
  if (isSessionIdleExpired(session)) {
    return c.json({ error: 'expired' }, 409)
  }

  if (c.req.header('X-Longtale-Interaction') !== 'background') {
    touchSession(db, session.id)
  }
  c.set('userId', session.userId)
  return next()
}
