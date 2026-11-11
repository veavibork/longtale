import { logUnhandledError } from './lib/errors.js'
import {
  startHealthSnapshots,
  stopHealthSnapshots,
  type HealthSnapshot,
} from './lib/pipeline-health.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stopAllConcurrencyFeeds } from './queue/concurrency-feed.js'
import { storiesRoute } from './routes/stories.js'
import { layoutRoute } from './routes/layout.js'
import { agentsRoute } from './routes/agents.js'
import { promptsRoute } from './routes/prompts.js'
import { settingsSpacesRoute } from './routes/settings-spaces.js'
import { clientErrorsRoute } from './routes/client-errors.js'
import { sessionsRoute } from './routes/sessions.js'
import { accountRoute } from './routes/account.js'
import { preferenceProfilesRoute } from './routes/preference-profiles.js'
import { sessionGuard, type AppVariables } from './middleware/session-guard.js'
import {
  startPipelineRunner,
  stopPipelineRunner,
  trackStoryDb,
  getTrackedJobCounts,
  panicStopAllJobs,
} from './queue/dispatch.js'
import { getQueueStatus } from './queue/slots.js'
import { startProbeRunner, stopProbeRunner, panicStopProbes } from './queue/probe-runner.js'
import { modelProfilesRoute } from './routes/model-profiles.js'
import { recoverStaleProbes } from './db/model-format-profile-store.js'
import { getGlobalDb } from './db/global-db.js'
import { listAllStories } from './db/story-store.js'
import { getStoryDb } from './db/story-db.js'
import { listUsers } from './db/user-store.js'

const app = new Hono<{ Variables: AppVariables }>()
// The web app reaches the API same-origin: through the Vite proxy in dev, or a reverse proxy that
// serves web/dist and forwards /api here for a built deployment. This server serves only the API.
app.use(
  '*',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request too large' }, 413),
  }),
)
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cache-Control', 'no-store')
})
// Single-active-session enforcement (src/middleware/session-guard.ts)
app.use('*', sessionGuard)
app.route('/api/sessions', sessionsRoute)
app.route('/api/account', accountRoute)
app.route('/api/stories', storiesRoute)
app.route('/api/layout', layoutRoute)
app.route('/api/agents', agentsRoute)
app.route('/api/prompts', promptsRoute)
app.route('/api/settings', settingsSpacesRoute)
app.route('/api/client-errors', clientErrorsRoute)
app.route('/api/preference-profiles', preferenceProfilesRoute)
app.route('/api/model-profiles', modelProfilesRoute)
app.get('/api/debug/slots', (c) => c.json(getQueueStatus(c.get('userId'))))
app.post('/api/debug/slots/panic', (c) => {
  const userId = c.get('userId')
  const result = panicStopAllJobs(userId)
  return c.json({ ...result, probesAborted: panicStopProbes(userId) })
})
const port = Number(process.env.PORT ?? 4113)

/** The pipeline runner only scans stories it's tracking (src/queue/dispatch.ts) */
function trackAllStoriesAtStartup(): void {
  const db = getGlobalDb()
  for (const story of listAllStories(db)) {
    try {
      trackStoryDb(story.id, getStoryDb(story.id))
    } catch (err) {
      console.error(
        `failed to track story ${story.id} at startup:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

trackAllStoriesAtStartup()
// Probe rows left 'running' by a dead process have no live call to reattach to — re-pend them.
recoverStaleProbes(getGlobalDb())
startPipelineRunner()
startProbeRunner()
// Loopback by default; set HOST=0.0.0.0 behind a reverse proxy.
const hostname = process.env.HOST ?? '127.0.0.1'
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Longtale listening on http://${hostname}:${info.port}`)
})

/** Graceful shutdown on SIGTERM (process managers) or SIGINT (Ctrl+C). */
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} received — stopping pipeline, feeds, and HTTP listener`)
  stopPipelineRunner()
  stopProbeRunner()
  stopHealthSnapshots()
  stopAllConcurrencyFeeds()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// -- Global error handlers --

process.on('unhandledRejection', (reason) => {
  logUnhandledError({ source: 'unhandledRejection' }, reason)
})

process.on('uncaughtException', (err) => {
  logUnhandledError({ source: 'uncaughtException' }, err)
  // Don't exit: one story's or slot's error must not take down the pipeline runner for every story.
})

// -- Pipeline health snapshots --

function buildHealthSnapshot(): Omit<HealthSnapshot, 'at'> {
  const db = getGlobalDb()
  // Slots are per provider account, so total them across every user.
  const queues = listUsers(db).map((u) => getQueueStatus(u.id))
  const { activeJobs, pendingJobs, hordeJobsRunning } = getTrackedJobCounts()
  return {
    activeJobs,
    pendingJobs,
    slotsUsed: queues.reduce((n, q) => n + q.used, 0),
    slotsMax: queues.reduce((n, q) => n + q.max, 0),
    hordeJobsRunning,
    trackedStories: listAllStories(db).length,
  }
}

startHealthSnapshots(buildHealthSnapshot)
