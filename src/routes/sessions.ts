import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import { getUserByDisplayName } from '../db/user-store.js'
import { createSession } from '../db/session-store.js'
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../lib/login-throttle.js'
import { displayNameSchema, PASSWORD_MAX_LENGTH } from '../lib/credentials.js'

// Compared against when the user id is unknown, so a miss costs the same as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('longtale-timing-equalizer', 10)

export const sessionsRoute = new Hono()

const claimSchema = z.object({
  displayName: displayNameSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

// Deliberately exempt from src/middleware/session-guard.ts.
sessionsRoute.post('/claim', sValidator('json', claimSchema, validationHook), async (c) => {
  const { displayName, password } = c.req.valid('json')

  const throttleKey = displayName.toLowerCase()
  const gate = checkLoginAllowed(throttleKey)
  if (!gate.allowed) {
    c.header('Retry-After', String(gate.retryAfterSec))
    return c.json({ error: 'too many failed attempts, try again later' }, 429)
  }

  const db = getGlobalDb()
  const user = getUserByDisplayName(db, displayName)
  const matches = await bcrypt.compare(password, user?.passwordVerifier ?? DUMMY_HASH)
  if (!user || !matches) {
    recordLoginFailure(throttleKey)
    return c.json({ error: 'invalid credentials' }, 401)
  }
  recordLoginSuccess(throttleKey)

  const session = createSession(db, user.id)
  return c.json({
    sessionId: session.id,
    claimedAt: session.createdAt,
    displayName: user.displayName,
  })
})
