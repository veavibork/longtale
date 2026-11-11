import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import {
  DisplayNameTakenError,
  getMaskedKeys,
  getUserById,
  setFeatherlessKey,
  setHordeKey,
  updateDisplayName,
  updatePassword,
} from '../db/user-store.js'
import { invalidateActiveSession } from '../db/session-store.js'
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../lib/login-throttle.js'
import type { AppVariables } from '../middleware/session-guard.js'
import { displayNameSchema, newPasswordSchema, PASSWORD_MAX_LENGTH } from '../lib/credentials.js'

export const accountRoute = new Hono<{ Variables: AppVariables }>()

const renameSchema = z.object({ displayName: displayNameSchema })
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
})
const keySchema = z.object({ key: z.string().trim().min(1).max(500) })

// Every handler below trusts only c.get("userId") (set by sessionGuard from the caller's own session)

accountRoute.get('/', (c) => {
  const db = getGlobalDb()
  const user = getUserById(db, c.get('userId'))
  if (!user) return c.json({ error: 'user not found' }, 404)
  return c.json({ id: user.id, displayName: user.displayName, ...getMaskedKeys(db, user.id) })
})

// Release the caller's own claim (single-active-session eviction runs off this — see session-store).
accountRoute.post('/logout', (c) => {
  invalidateActiveSession(getGlobalDb(), c.get('userId'))
  return c.json({ ok: true })
})

accountRoute.patch('/display-name', sValidator('json', renameSchema, validationHook), async (c) => {
  const { displayName } = c.req.valid('json')

  const db = getGlobalDb()
  try {
    const user = updateDisplayName(db, c.get('userId'), displayName)
    return c.json({ id: user.id, displayName: user.displayName })
  } catch (err) {
    if (err instanceof DisplayNameTakenError) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
})

accountRoute.post('/password', sValidator('json', passwordSchema, validationHook), async (c) => {
  const { currentPassword, newPassword } = c.req.valid('json')

  const db = getGlobalDb()
  const user = getUserById(db, c.get('userId'))
  if (!user) return c.json({ error: 'user not found' }, 404)
  const gate = checkLoginAllowed(user.id)
  if (!gate.allowed) {
    c.header('Retry-After', String(gate.retryAfterSec))
    return c.json({ error: 'too many failed attempts, try again later' }, 429)
  }
  if (!(await bcrypt.compare(currentPassword, user.passwordVerifier))) {
    recordLoginFailure(user.id)
    return c.json({ error: 'current password is incorrect' }, 401)
  }
  recordLoginSuccess(user.id)

  updatePassword(db, user.id, await bcrypt.hash(newPassword, 10))
  return c.json({ ok: true })
})

accountRoute.put('/featherless-key', sValidator('json', keySchema, validationHook), async (c) => {
  const { key } = c.req.valid('json')

  const db = getGlobalDb()
  setFeatherlessKey(db, c.get('userId'), key)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.delete('/featherless-key', (c) => {
  const db = getGlobalDb()
  setFeatherlessKey(db, c.get('userId'), null)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.put('/horde-key', sValidator('json', keySchema, validationHook), async (c) => {
  const { key } = c.req.valid('json')

  const db = getGlobalDb()
  setHordeKey(db, c.get('userId'), key)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.delete('/horde-key', (c) => {
  const db = getGlobalDb()
  setHordeKey(db, c.get('userId'), null)
  return c.json(getMaskedKeys(db, c.get('userId')))
})
