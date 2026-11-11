import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { generationOptionsSchema } from '../../services/settings-space-registry.js'
import { openTrackedStoryDb, retryPost, editPost } from '../../services/story-ops.js'

export const postsRoute = new Hono<{ Variables: AppVariables }>()

const retrySchema = z.object({
  guidance: z.string().optional(),
  generationOptions: generationOptionsSchema.optional(),
})

const editPostSchema = z.object({
  content: z.string().optional(),
})

/** Regenerate an existing agent post in place — a new text version on the same page. */
postsRoute.post(
  '/:id/posts/:pageId/retry',
  sValidator('json', retrySchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const result = retryPost(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      c.req.param('pageId')!,
      body.guidance,
      body.generationOptions,
    )
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json(result)
  },
)

/** Directly overwrite a post's content — a new text version with user-supplied text, no inference call. */
postsRoute.post(
  '/:id/posts/:pageId/edit',
  sValidator('json', editPostSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const content = body.content ?? ''
    if (!content.trim()) return c.json({ error: 'content is required' }, 400)

    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const result = editPost(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      c.req.param('pageId')!,
      content,
    )
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json({ ok: true, ...result })
  },
)
