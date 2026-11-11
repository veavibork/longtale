import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { generationOptionsSchema } from '../../services/settings-space-registry.js'
import {
  openTrackedStoryDb,
  postMessage,
  continueStory,
  postSetupMessage,
  kickoffStory,
  startOocSession,
} from '../../services/story-ops.js'

export const messagesRoute = new Hono<{ Variables: AppVariables }>()

const messageSchema = z.object({
  content: z.string().optional(),
  generationOptions: generationOptionsSchema.optional(),
})

const continueSchema = z.object({
  guidance: z.string().optional(),
  generationOptions: generationOptionsSchema.optional(),
})

const setupMessageSchema = z.object({
  content: z.string().optional(),
})

messagesRoute.post('/:id/messages', sValidator('json', messageSchema, validationHook), (c) => {
  const body = c.req.valid('json')
  const content = body.content ?? ''
  if (!content.trim()) return c.json({ error: 'content is required' }, 400)

  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = postMessage(
    storyDb,
    c.get('userId'),
    c.req.param('id')!,
    content,
    body.generationOptions,
  )
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/** Generate a continuation from the current position (or the head, if nothing's been rewound) */
messagesRoute.post('/:id/continue', sValidator('json', continueSchema, validationHook), (c) => {
  const body = c.req.valid('json')
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = continueStory(
    storyDb,
    c.get('userId'),
    c.req.param('id')!,
    body.guidance,
    body.generationOptions,
  )
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/** OOC/setup conversation — usable both before the initial kickoff and any time after. */
messagesRoute.post(
  '/:id/setup/messages',
  sValidator('json', setupMessageSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const content = body.content ?? ''
    if (!content.trim()) return c.json({ error: 'content is required' }, 400)

    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const result = postSetupMessage(storyDb, c.get('userId'), c.req.param('id')!, content)
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json(result)
  },
)

/** One-shot kickoff: generates the opening post and immediately moves the story into story phase. */
messagesRoute.post('/:id/kickoff', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = kickoffStory(storyDb, c.get('userId'), c.req.param('id')!)
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/** Marks a fresh post-kickoff OOC "update session" boundary. */
messagesRoute.post('/:id/ooc/start-session', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = startOocSession(storyDb)
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})
