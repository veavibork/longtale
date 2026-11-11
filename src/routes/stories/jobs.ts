import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppVariables } from '../../middleware/session-guard.js'
import {
  getJob,
  listRecentJobs,
  listActiveJobs,
  cancelJob,
  agentRoleForJobType,
} from '../../db/job-store.js'
import { getText } from '../../db/text-store.js'
import { requestJobCancel } from '../../queue/cancel.js'
import { clearJobEphemeralState } from '../../queue/dispatch.js'
import {
  subscribeJob,
  getJobBuffer,
  publishCancelled,
  type JobEvent,
} from '../../queue/job-events.js'
import { publishStoryDataChanged } from '../../queue/story-events.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const jobsRoute = new Hono<{ Variables: AppVariables }>()

jobsRoute.get('/:id/jobs', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  return c.json({
    jobs: listRecentJobs(storyDb).map((j) => ({
      ...j,
      agentRole: agentRoleForJobType(j.jobType),
      // Live wait/retry label for an in-flight job (memory-wait, provider-busy backoff, model fallback)
      progress: j.status === 'running' ? (getJobBuffer(j.id)?.progress ?? null) : null,
    })),
  })
})

/** Jobs still in flight for this story, so a freshly (re)mounted client can reattach to a running generation. */
jobsRoute.get('/:id/jobs/active', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  return c.json({ jobs: listActiveJobs(storyDb) })
})

jobsRoute.get('/:id/jobs/:jobId', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const job = getJob(storyDb, c.req.param('jobId'))
  if (!job) return c.json({ error: 'job not found' }, 404)
  return c.json({ job })
})

/** Pending jobs (not yet claimed) have no in-flight call to abort — mark cancelled directly. */
jobsRoute.post('/:id/jobs/:jobId/cancel', (c) => {
  const storyId = c.req.param('id')
  const storyDb = openTrackedStoryDb(storyId)
  const jobId = c.req.param('jobId')
  const job = getJob(storyDb, jobId)
  if (!job) return c.json({ error: 'job not found' }, 404)
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return c.json({ job })
  }
  if (job.status === 'pending') {
    cancelJob(storyDb, jobId)
    // Pending jobs never reach dispatch (where guidance/options are normally consumed and cleared)
    clearJobEphemeralState(jobId)
    publishCancelled(jobId)
    publishStoryDataChanged(storyId, 'jobs')
    return c.json({ ok: true })
  }
  const aborted = requestJobCancel(jobId)
  if (!aborted) {
    // Running but has no in-memory controller to abort.
    if (job.hordeRequestId) {
      return c.json({ error: "this job type can't be cancelled mid-generation" }, 409)
    }
    cancelJob(storyDb, jobId)
    publishCancelled(jobId)
    publishStoryDataChanged(storyId, 'jobs')
    return c.json({ ok: true, reaped: true })
  }
  return c.json({ ok: true })
})

/** Subscribes to the job's event bus BEFORE checking its current status. */
jobsRoute.get('/:id/jobs/:jobId/stream', (c) => {
  const storyId = c.req.param('id')
  const jobId = c.req.param('jobId')
  const storyDb = openTrackedStoryDb(storyId)

  return streamSSE(c, async (sse) => {
    let settled = false
    const finish = async (event: JobEvent | { type: 'error'; message: string }) => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      await sse.writeSSE({ data: JSON.stringify(event) })
      await sse.writeSSE({ data: '[DONE]' })
    }

    // Long generations can sit silent between tokens for a while.
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n')
    }, 15000)

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeJob(jobId, (event) => {
        // Only genuinely terminal events end the stream.
        if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
          unsubscribe()
          void finish(event).then(resolve)
          return
        }
        void sse.writeSSE({ data: JSON.stringify(event) })
      })

      // Client gone (tab closed or EventSource.close()).
      sse.onAbort(() => {
        if (settled) return
        settled = true
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })

      const job = getJob(storyDb, jobId)
      if (!job) {
        unsubscribe()
        void finish({ type: 'error', message: 'job not found' }).then(resolve)
        return
      }
      if (job.status === 'cancelled') {
        unsubscribe()
        void finish({ type: 'cancelled' }).then(resolve)
        return
      }
      // A failed job must surface as an error, not a silent 'done'.
      if (job.status === 'failed') {
        unsubscribe()
        void finish({ type: 'error', message: job.error ?? 'job failed' }).then(resolve)
        return
      }
      if (job.status === 'done') {
        unsubscribe()
        const text = job.targetTextId ? getText(storyDb, job.targetTextId) : null
        void finish({ type: 'done', fullText: text?.genPackage ?? '' }).then(resolve)
        return
      }
      if (job.inputTokenEstimate != null) {
        void sse.writeSSE({
          data: JSON.stringify({ type: 'meta', inputTokenEstimate: job.inputTokenEstimate }),
        })
      }
      const buffered = getJobBuffer(jobId)
      if (job.status === 'pending' && !buffered) {
        void sse.writeSSE({ data: JSON.stringify({ type: 'queued' }) })
      }
      if (buffered && (buffered.text || buffered.thinking || buffered.progress)) {
        void sse.writeSSE({
          data: JSON.stringify({
            type: 'sync',
            text: buffered.text,
            thinking: buffered.thinking,
            progress: buffered.progress,
          }),
        })
      }
    })
  })
})
