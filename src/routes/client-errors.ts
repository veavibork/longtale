import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import { createClientError, listClientErrors } from '../db/client-error-store.js'

import type { AppVariables } from '../middleware/session-guard.js'

export const clientErrorsRoute = new Hono<{ Variables: AppVariables }>()

// Stream URLs carry the session id as a query parameter; never store it.
const redactSession = (text: string | undefined) =>
  text?.replace(/([?&]session=)[^&\s"']*/gi, '$1[redacted]')

const createErrorSchema = z.object({
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  message: z.string().min(1).max(4000),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
})

clientErrorsRoute.post('/', sValidator('json', createErrorSchema, validationHook), async (c) => {
  const body = c.req.valid('json')

  const db = getGlobalDb()
  const created = createClientError(db, c.get('userId'), {
    severity: body.severity,
    message: redactSession(body.message) ?? '',
    url: redactSession(body.url),
    userAgent: body.userAgent,
  })
  return c.json({ clientError: created })
})

clientErrorsRoute.get('/', (c) => {
  const limitParam = c.req.query('limit')
  const parsed = limitParam ? Number(limitParam) : NaN
  // listClientErrors defaults to 200 when no limit is given.
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  const db = getGlobalDb()
  return c.json({
    errors: listClientErrors(db, c.get('userId'), {
      limit: limit ? Math.min(limit, 500) : undefined,
    }),
  })
})
