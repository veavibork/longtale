/** Shared pipeline helpers — post-generation side effects called from multiple executors and the Horde poll. */
import type Database from 'better-sqlite3'
import { createJob } from '../db/job-store.js'
import { getStory } from '../db/story-store.js'
import { getGlobalDb } from '../db/global-db.js'
import { getAgentProfile } from '../services/agent-config.js'
import { isOpeningPostPage } from '../services/story-transition.js'
import { enqueueEligibleStoryToDateJob } from '../services/story-to-date/index.js'
import { publishStoryDataChanged } from './story-events.js'
import { DEFAULT_STORY_NAME } from '../db/story-store.js'
import type { PageRow } from '../db/page-store.js'

/** Fires once, right when the kickoff post's generation lands (OOC -> IC) */
export function maybeQueueStoryNameJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  targetPage: PageRow,
  targetTextId: string,
): void {
  if (!isOpeningPostPage(db, targetPage.bookId, targetPage.id)) return

  const story = getStory(getGlobalDb(), storyId)
  if (!story || story.name !== DEFAULT_STORY_NAME) return
  createJob(db, {
    targetTextId,
    jobType: 'story-name',
    slotCost: getAgentProfile(userId, 'worker').concurrencyCost,
    priority: -1,
  })
  publishStoryDataChanged(storyId, 'jobs')
}

export function maybeEnqueueStoryToDateJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
): void {
  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
}

/** Counts forward story-to-date, fold, AND coverage-audit jobs — each is a full-cost Editor call. */
export function countRunningStoryToDateJobsForUser(
  globalDb: ReturnType<typeof getGlobalDb>,
  userId: string,
  trackedDbs: Map<string, Database.Database>,
): number {
  let count = 0
  for (const [storyId, db] of trackedDbs) {
    const story = getStory(globalDb, storyId)
    if (!story || story.ownerUserId !== userId) continue
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE job_type IN ('story-to-date', 'story-to-date-fold', 'segment-audit') AND status = 'running'`,
      )
      .get() as { n: number }
    count += row.n
  }
  return count
}
