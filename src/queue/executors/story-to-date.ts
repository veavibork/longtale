/** Forward-compression wrapper: summarizes recent IC posts into a story-to-date segment. */
import type Database from 'better-sqlite3'
import { finishJob, cancelJob } from '../../db/job-store.js'
import { getStoryToDateSegment } from '../../db/story-to-date-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import {
  executeStoryToDateJob,
  InsufficientCoverageMaterialError,
} from '../../services/story-to-date/worker.js'
import {
  enqueueEligibleStoryToDateJob,
  enqueueStoryToDateNameJob,
  enqueueEligibleFoldJob,
} from '../../services/story-to-date/index.js'
import { JobCancelledError } from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { beginCancellableWorkerJob, endCancellableWorkerJob } from '../cancel.js'

export async function executeStoryToDateJobWrapper(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
  jobId: string,
  segmentId: string,
): Promise<void> {
  const controller = beginCancellableWorkerJob(jobId)
  const startedAt = Date.now()
  try {
    const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    if (!apiKey) throw new Error('no Featherless API key configured')
    await executeStoryToDateJob(
      db,
      userId,
      storyId,
      logbookId,
      segmentId,
      apiKey,
      controller.signal,
    )
    const editor = getAgentProfile(userId, 'editor')
    const filledSegment = getStoryToDateSegment(db, segmentId)
    const tokenEstimate = filledSegment?.content
      ? Math.ceil(filledSegment.content.length / 4)
      : undefined
    finishJob(db, jobId, 'done', undefined, {
      model: editor.model,
      tokenEstimate,
      elapsedMs: Date.now() - startedAt,
    })
    enqueueStoryToDateNameJob(db, userId, segmentId)
    enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
    // A new segment may push total memory over the soft cap; fold if so.
    enqueueEligibleFoldJob(db, userId, logbookId)
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finishJob(db, jobId, 'failed', message)
      if (err instanceof InsufficientCoverageMaterialError) {
        // The window had no valid scene seam to land on — not enough new material yet, not a quality problem.
        enqueueEligibleFoldJob(db, userId, logbookId, { ignoreSoftCap: true })
      }
    }
  } finally {
    endCancellableWorkerJob(jobId)
    releaseSlot(userId, jobId)
  }
}
