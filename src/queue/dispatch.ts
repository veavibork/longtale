import type Database from 'better-sqlite3'
import {
  claimNextJob,
  cancelJob,
  finishJob,
  setHordeRequestId,
  setJobModel,
  listRunningHordeJobs,
  listActiveJobs,
  hasActiveJobByType,
  agentRoleForJobType,
  type JobRow,
  type JobType,
} from '../db/job-store.js'
import { fillTextGeneration, getText } from '../db/text-store.js'
import { getPage } from '../db/page-store.js'
import { getBookByType } from '../db/book-store.js'
import { getGlobalDb } from '../db/global-db.js'
import { getStory } from '../db/story-store.js'
import { tryAcquireSlot, releaseSlot, type SlotHolderMeta } from './slots.js'

import { canSubmitHorde, recordHordeSubmit } from '../inference/horde-rate-limiter.js'
import { ensureConcurrencyFeedForUser } from './concurrency-feed.js'
import {
  getJobBuffer,
  publishProgress,
  publishDone,
  publishError,
  publishJobClaimed,
  publishJobStarted,
  publishCancelled,
} from './job-events.js'
import { publishStoryDataChanged, type StoryDataKind } from './story-events.js'
import { runningControllers, requestJobCancel } from './cancel.js'
import {
  maybeQueueStoryNameJob,
  maybeEnqueueStoryToDateJob,
  countRunningStoryToDateJobsForUser,
} from './helpers.js'
import { executeStoryToDateNameJob } from './executors/segment-name.js'
import { executeStoryNameJob } from './executors/story-name.js'
import { executeWorldbookCompactJob } from './executors/worldbook-compact.js'
import { executeStoryToDateJobWrapper } from './executors/story-to-date.js'
import { executeStoryToDateFoldJobWrapper } from './executors/story-to-date-fold.js'
import { executeSegmentAuditJobWrapper } from './executors/segment-audit.js'
import { executeProseJob } from './executors/prose.js'
import { executeSetupJob } from './executors/setup.js'
import { executeSetupWorldbookJob } from './executors/setup-worldbook.js'
import { createLogger } from '../inference/outbound-telemetry.js'
import {
  submitTextGeneration,
  pollTextGeneration,
  HordeKudosUpfrontError,
} from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'
import { buildProseHistory } from '../services/history.js'
import { getAgentProfile } from '../services/agent-config.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'

const SCAN_INTERVAL_MS = 500
/** Shown on a queued prose post while a story-to-date job blocks it (see dispatchProseJob's gate). */
const MEMORY_WAIT_LABEL = 'Waiting for memory update…'
const WORKER_JOB_TYPES: JobType[] = [
  'story-to-date',
  'story-to-date-fold',
  'story-name',
  'segment-name',
  'worldbook-compact',
  'segment-audit',
]
const PROSE_JOB_TYPES: JobType[] = ['prose', 'setup', 'setup-worldbook']

/** Which story-scoped data view a finished job may have written to. */
const JOB_DATA_KINDS: Partial<Record<JobType, StoryDataKind>> = {
  'story-to-date': 'segments',
  'story-to-date-fold': 'segments',
  'segment-name': 'segments',
  'segment-audit': 'segments',
  'worldbook-compact': 'worldbook',
  setup: 'worldbook',
  'setup-worldbook': 'worldbook',
}

function publishJobDataChanged(storyId: string, jobType: JobType): void {
  const kind = JOB_DATA_KINDS[jobType]
  if (kind) publishStoryDataChanged(storyId, kind)
  // Every dispatch-start/completion is also a jobs-list change.
  publishStoryDataChanged(storyId, 'jobs')
}

/** Guided retry's direction text is explicitly not stored as a post. */
type GuidanceIntent = 'regenerate' | 'continue'
const jobGuidance = new Map<string, { text: string; intent: GuidanceIntent }>()
export function setJobGuidance(jobId: string, guidance: string, intent: GuidanceIntent): void {
  jobGuidance.set(jobId, { text: guidance, intent })
}

const jobGenerationOptions = new Map<string, GenerationOptions>()
export function setJobGenerationOptions(jobId: string, options: GenerationOptions): void {
  jobGenerationOptions.set(jobId, options)
}

/** Drops a job's ephemeral in-memory state (guidance + generation options). */
export function clearJobEphemeralState(jobId: string): void {
  jobGuidance.delete(jobId)
  jobGenerationOptions.delete(jobId)
}

// Deliberately not gated by src/middleware/session-guard.ts — this loop isn't an HTTP request.
let timer: NodeJS.Timeout | null = null
const trackedDbs = new Map<string, Database.Database>()

/** The pipeline runner only scans stories the API has actually touched this process lifetime. */
export function trackStoryDb(storyId: string, db: Database.Database): void {
  trackedDbs.set(storyId, db)
}

/** Call when a story DB handle closes (e.g. deletion), or the next scan hits a closed connection. */
export function untrackStoryDb(storyId: string): void {
  trackedDbs.delete(storyId)
}

/** Aggregate job counts across every tracked story DB. */
export function getTrackedJobCounts(): {
  activeJobs: number
  pendingJobs: number
  hordeJobsRunning: number
} {
  let activeJobs = 0
  let pendingJobs = 0
  let hordeJobsRunning = 0
  for (const db of trackedDbs.values()) {
    if (!db.open) continue
    for (const job of listActiveJobs(db)) {
      if (job.status === 'running') activeJobs++
      else pendingJobs++
    }
    hordeJobsRunning += listRunningHordeJobs(db).length
  }
  return { activeJobs, pendingJobs, hordeJobsRunning }
}

/** Panic button: stop every pending/running job across every story this user owns, right now. */
export function panicStopAllJobs(userId: string): { aborted: number; reaped: number } {
  const globalDb = getGlobalDb()
  let aborted = 0
  let reaped = 0
  for (const [storyId, db] of trackedDbs) {
    const story = getStory(globalDb, storyId)
    if (!story || story.ownerUserId !== userId) continue
    for (const job of listActiveJobs(db)) {
      if (job.status === 'running' && requestJobCancel(job.id)) {
        aborted++
        continue
      }
      clearJobEphemeralState(job.id)
      cancelJob(db, job.id)
      publishCancelled(job.id)
      reaped++
    }
  }
  return { aborted, reaped }
}

export function startPipelineRunner(): void {
  if (timer) return
  timer = setInterval(scanOnce, SCAN_INTERVAL_MS)
}

export function stopPipelineRunner(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function scanOnce(): void {
  const globalDb = getGlobalDb()
  for (const [storyId, db] of trackedDbs) {
    try {
      const story = getStory(globalDb, storyId)
      if (!story) {
        trackedDbs.delete(storyId)
        continue
      }
      scanHordeJobs(db, storyId, story.ownerUserId)
    } catch (err) {
      if (!db.open) trackedDbs.delete(storyId)
      createLogger({ storyId, jobType: 'scan-horde' }).error('pipeline horde scan failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Prose dispatches first so interactive generation claims slots before background workers.
  for (const [storyId, db] of trackedDbs) {
    try {
      const story = getStory(globalDb, storyId)
      if (!story) {
        trackedDbs.delete(storyId)
        continue
      }
      dispatchProseJob(db, story.ownerUserId, storyId)
    } catch (err) {
      createLogger({ storyId, jobType: 'scan-prose' }).error('pipeline prose scan failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  dispatchWorkerJobs(globalDb)
}

function unclaimJob(db: Database.Database, jobId: string): void {
  db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(jobId)
}

/** Attribution carried on the slot reservation so the Queue tab can show what holds each slot. */
function slotMeta(job: JobRow, storyId: string): SlotHolderMeta {
  return {
    jobType: job.jobType,
    agentRole: agentRoleForJobType(job.jobType),
    storyId,
    storyName: getStory(getGlobalDb(), storyId)?.name ?? '',
  }
}

/** Worker dispatch — slots.ts is the sole gatekeeper. */
function dispatchWorkerJobs(globalDb: ReturnType<typeof getGlobalDb>): void {
  while (true) {
    let dispatched = false
    for (const [storyId, db] of trackedDbs) {
      const story = getStory(globalDb, storyId)
      if (!story) continue

      const job = claimNextJob(db, WORKER_JOB_TYPES)
      if (!job) continue
      publishJobClaimed(job.id)

      // Editor memory jobs cost the full account limit, so only one runs per user at a time.
      if (
        (job.jobType === 'story-to-date' ||
          job.jobType === 'story-to-date-fold' ||
          job.jobType === 'segment-audit') &&
        countRunningStoryToDateJobsForUser(globalDb, story.ownerUserId, trackedDbs) > 1
      ) {
        unclaimJob(db, job.id)
        continue
      }

      ensureConcurrencyFeedForUser(
        story.ownerUserId,
        getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? '',
      )
      if (!tryAcquireSlot(story.ownerUserId, job.id, job.slotCost, slotMeta(job, storyId))) {
        unclaimJob(db, job.id)
        continue
      }

      dispatched = true
      // Ping at dispatch-start too, not just completion.
      publishJobDataChanged(storyId, job.jobType)
      if (job.jobType === 'story-to-date' && job.targetStoryToDateId) {
        const logbook = getBookByType(db, 'logbook')
        if (!logbook) {
          finishJob(db, job.id, 'failed', 'logbook not found')
          releaseSlot(story.ownerUserId, job.id)
          continue
        }
        publishJobStarted(job.id)
        void executeStoryToDateJobWrapper(
          db,
          story.ownerUserId,
          storyId,
          logbook.id,
          job.id,
          job.targetStoryToDateId,
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else if (job.jobType === 'story-to-date-fold' && job.targetStoryToDateId) {
        const logbook = getBookByType(db, 'logbook')
        if (!logbook) {
          finishJob(db, job.id, 'failed', 'logbook not found')
          releaseSlot(story.ownerUserId, job.id)
          continue
        }
        publishJobStarted(job.id)
        void executeStoryToDateFoldJobWrapper(
          db,
          story.ownerUserId,
          logbook.id,
          job.id,
          job.targetStoryToDateId,
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else if (job.jobType === 'story-name' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeStoryNameJob(db, story.ownerUserId, job.id, job.targetTextId, storyId).finally(
          () => publishJobDataChanged(storyId, job.jobType),
        )
      } else if (job.jobType === 'segment-name' && job.targetStoryToDateId) {
        publishJobStarted(job.id)
        void executeStoryToDateNameJob(
          db,
          story.ownerUserId,
          job.id,
          job.targetStoryToDateId,
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else if (job.jobType === 'worldbook-compact' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeWorldbookCompactJob(db, story.ownerUserId, job.id).finally(() =>
          publishJobDataChanged(storyId, job.jobType),
        )
      } else if (job.jobType === 'segment-audit' && job.targetStoryToDateId) {
        const logbook = getBookByType(db, 'logbook')
        if (!logbook) {
          finishJob(db, job.id, 'failed', 'logbook not found')
          releaseSlot(story.ownerUserId, job.id)
          continue
        }
        publishJobStarted(job.id)
        void executeSegmentAuditJobWrapper(
          db,
          story.ownerUserId,
          storyId,
          logbook.id,
          job.id,
          job.targetStoryToDateId,
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else {
        finishJob(db, job.id, 'failed', `job ${job.id} (${job.jobType}) has no valid target`)
        releaseSlot(story.ownerUserId, job.id)
      }
      break
    }

    if (!dispatched) break
  }
}

function dispatchProseJob(db: Database.Database, userId: string, storyId: string): void {
  const job = claimNextJob(db, PROSE_JOB_TYPES)
  if (!job) return

  // Hold prose while a story-to-date job is in flight; the memory segment must land first.
  if (job.jobType === 'prose' && hasActiveJobByType(db, 'story-to-date')) {
    if (getJobBuffer(job.id)?.progress !== MEMORY_WAIT_LABEL) {
      publishProgress(job.id, MEMORY_WAIT_LABEL)
    }
    unclaimJob(db, job.id)
    return
  }

  publishJobClaimed(job.id)

  // Horde prose: submit-then-poll — does not hold a slot (workers may run while queued).
  if (
    job.jobType === 'prose' &&
    job.targetTextId &&
    getAgentProfile(userId, 'author').provider === 'horde'
  ) {
    if (!canSubmitHorde()) {
      unclaimJob(db, job.id)
      return
    }
    recordHordeSubmit()
    jobGenerationOptions.delete(job.id)
    publishJobDataChanged(storyId, job.jobType)
    void executeHordeProseSubmit(db, userId, job.id, job.targetTextId)
    return
  }

  ensureConcurrencyFeedForUser(userId, getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? '')
  if (!tryAcquireSlot(userId, job.id, job.slotCost, slotMeta(job, storyId))) {
    unclaimJob(db, job.id)
    return
  }

  // pending→running just happened for whichever branch below dispatches — ping the jobs list.
  publishJobDataChanged(storyId, job.jobType)

  if (job.jobType === 'prose' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    const guidance = jobGuidance.get(job.id)
    if (guidance) jobGuidance.delete(job.id)
    const genOptions = jobGenerationOptions.get(job.id)
    jobGenerationOptions.delete(job.id)
    void executeProseJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
      guidance,
      genOptions,
    ).finally(() => publishJobDataChanged(storyId, job.jobType))
  } else if (job.jobType === 'setup' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    const guidance = jobGuidance.get(job.id)
    if (guidance) jobGuidance.delete(job.id)
    void executeSetupJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
      guidance,
    ).finally(() => publishJobDataChanged(storyId, job.jobType))
  } else if (job.jobType === 'setup-worldbook' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeSetupWorldbookJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
    ).finally(() => publishJobDataChanged(storyId, job.jobType))
  } else {
    finishJob(db, job.id, 'failed', `job ${job.id} (${job.jobType}) has no valid target`)
    releaseSlot(userId, job.id)
  }
}

/** Submits a Horde prose job and returns; scanHordeJobs polls it to completion. */
async function executeHordeProseSubmit(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
): Promise<void> {
  try {
    const guidance = jobGuidance.get(jobId)
    if (guidance) jobGuidance.delete(jobId)
    const { history } = buildProseHistory(db, userId, targetTextId, guidance)
    const profile = getAgentProfile(userId, 'author')
    const hordeKey = getDecryptedHordeKey(getGlobalDb(), userId)
    try {
      const { id: requestId } = await submitTextGeneration(profile, hordeKey, history)
      setHordeRequestId(db, jobId, requestId)
      setJobModel(db, jobId, profile.model)
    } catch (err) {
      if (err instanceof HordeKudosUpfrontError) {
        // Retry with capped max_length — the model works, just with shorter output.
        const { id: requestId } = await submitTextGeneration(profile, hordeKey, history, {
          maxLengthOverride: 512,
        })
        setHordeRequestId(db, jobId, requestId)
        setJobModel(db, jobId, profile.model)
      } else {
        throw err
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finishJob(db, jobId, 'failed', message)
    publishError(jobId, message)
  }
}

// Fail a Horde request that has reported is_possible: false for this long.
const HORDE_IMPOSSIBLE_TIMEOUT_MS = 5 * 60_000
const hordeImpossibleSince = new Map<string, number>()

/** Floor between upstream status polls per Horde job — the 500ms scan tick is dispatch cadence. */
const HORDE_POLL_MIN_INTERVAL_MS = 2500
const hordePollInFlight = new Set<string>()
const hordeLastPollAt = new Map<string, number>()

function hordeJobTerminal(jobId: string): void {
  hordeImpossibleSince.delete(jobId)
  hordeLastPollAt.delete(jobId)
}

/** Polls submitted Horde jobs on each scan tick; each poll is fire-and-forget. */
function scanHordeJobs(db: Database.Database, storyId: string, userId: string): void {
  const now = Date.now()
  for (const job of listRunningHordeJobs(db)) {
    if (hordePollInFlight.has(job.id)) continue
    if (now - (hordeLastPollAt.get(job.id) ?? 0) < HORDE_POLL_MIN_INTERVAL_MS) continue
    hordePollInFlight.add(job.id)
    hordeLastPollAt.set(job.id, now)
    void resolveHordeJob(db, job, storyId, userId).finally(() => {
      hordePollInFlight.delete(job.id)
    })
  }
}

async function resolveHordeJob(
  db: Database.Database,
  job: JobRow,
  storyId: string,
  userId: string,
): Promise<void> {
  if (!job.hordeRequestId || !job.targetTextId) return
  const targetTextId = job.targetTextId

  let status
  try {
    status = await pollTextGeneration(
      job.hordeRequestId,
      getDecryptedHordeKey(getGlobalDb(), userId),
    )
  } catch (err) {
    // Transient poll failure: leave the job running and retry next tick.
    createLogger({ jobId: job.id, jobType: 'horde-poll' }).error('horde poll failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (status.faulted) {
    hordeJobTerminal(job.id)
    finishJob(db, job.id, 'failed', 'Horde generation faulted')
    publishError(job.id, 'Horde generation faulted')
    return
  }

  if (status.done) {
    const fullText = status.text ?? ''
    const tokenEstimate = Math.ceil(fullText.length / 4)
    try {
      const targetText = getText(db, targetTextId)
      const targetPage = targetText ? getPage(db, targetText.pageId) : null

      fillTextGeneration(db, targetTextId, {
        genPackage: fullText,
        genMetrics: JSON.stringify({ tokenEstimate }),
      })

      // Follow-up bookkeeping (story-name + story-to-date enqueue) is secondary to delivering the reply.
      try {
        if (targetPage) {
          maybeQueueStoryNameJob(db, userId, storyId, targetPage, targetTextId)
          const logbook = getBookByType(db, 'logbook')
          if (logbook) maybeEnqueueStoryToDateJob(db, userId, storyId, logbook.id)
        }
      } catch (err) {
        createLogger({ jobId: job.id, jobType: 'horde-resolve' }).error(
          'horde post-completion follow-up failed (reply still delivered)',
          { error: err instanceof Error ? err.message : String(err) },
        )
      }

      hordeJobTerminal(job.id)
      // Attribute to the model recorded at submit time, not the current config.
      finishJob(db, job.id, 'done', undefined, { model: job.model ?? undefined, tokenEstimate })
      publishDone(job.id, fullText)
    } catch (err) {
      // Delivering the reply failed: fail the job so it is not re-polled forever.
      const message = err instanceof Error ? err.message : String(err)
      createLogger({ jobId: job.id, jobType: 'horde-resolve' }).error(
        'horde job completion failed',
        {
          error: message,
        },
      )
      hordeJobTerminal(job.id)
      finishJob(db, job.id, 'failed', message)
      publishError(job.id, message)
    }
    return
  }

  if (!status.isPossible) {
    const firstSeen = hordeImpossibleSince.get(job.id) ?? Date.now()
    hordeImpossibleSince.set(job.id, firstSeen)
    if (Date.now() - firstSeen > HORDE_IMPOSSIBLE_TIMEOUT_MS) {
      hordeJobTerminal(job.id)
      finishJob(db, job.id, 'failed', 'no worker currently available for this model')
      publishError(job.id, 'no worker currently available for this model')
      return
    }
    publishProgress(job.id, 'No worker currently available for this model…')
    return
  }

  hordeImpossibleSince.delete(job.id)
  publishProgress(
    job.id,
    `Queued on AI Horde — position ${status.queuePosition}, ~${status.waitTime}s`,
  )
}
