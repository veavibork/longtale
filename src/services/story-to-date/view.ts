import type Database from 'better-sqlite3'
import { listActiveJobs, type JobRow, type JobType } from '../../db/job-store.js'
import { listStoryToDateSegments } from '../../db/story-to-date-store.js'
import { estimateTokens, countChainPosts, sanitizeStoryBlockContent } from './engine.js'

export type StoryToDateViewStatus = 'ready' | 'pending' | 'broken'

const MEMORY_JOB_TYPES = new Set<JobType>([
  'story-to-date',
  'story-to-date-fold',
  'segment-name',
  'segment-audit',
])

export interface ActiveMemoryJobView {
  id: string
  jobType: JobType
  status: 'pending' | 'running'
  createdAt: string
  startedAt: string | null
  targetSegmentId: string | null
}

export interface StoryToDateViewEntry {
  id: string
  kind: 'begins' | 'continues' | 'fold'
  seq: number
  createdAt: string
  content: string | null
  name: string | null
  coverageThroughIcPost: number | null
  coveragePageId: string | null
  hidden: boolean
  broken: boolean
  status: StoryToDateViewStatus
  tokenCount: number | null
  jobActive: boolean
  foldJobActive: boolean
  nameJobActive: boolean
  auditJobActive: boolean
  auditVerdict: 'pass' | 'flagged' | null
  auditMissing: string[] | null
  auditAt: string | null
}

export interface StoryToDateView {
  segments: StoryToDateViewEntry[]
  activeMemoryJobs: ActiveMemoryJobView[]
  mergedCoverageThroughPost: number | null
  icPostCount: number
  total: number
  withContent: number
  pending: number
  broken: number
}

export function buildStoryToDateView(db: Database.Database, logbookId: string): StoryToDateView {
  const rows = listStoryToDateSegments(db, logbookId, { includeHidden: true, includeBroken: true })
  const activeJobs = listActiveJobs(db)
  const activeTypesBySegment = new Map<string, Set<JobType>>()
  for (const j of activeJobs) {
    if (!j.targetStoryToDateId) continue
    const types = activeTypesBySegment.get(j.targetStoryToDateId) ?? new Set<JobType>()
    types.add(j.jobType)
    activeTypesBySegment.set(j.targetStoryToDateId, types)
  }

  const segments: StoryToDateViewEntry[] = rows.map((s) => {
    const activeTypes = activeTypesBySegment.get(s.id)
    let status: StoryToDateViewStatus = 'pending'
    if (s.broken) status = 'broken'
    else if (s.content?.trim()) status = 'ready'

    const content = s.content?.trim() ? sanitizeStoryBlockContent(s.content.trim()) : null
    return {
      id: s.id,
      kind: s.kind,
      seq: s.seq,
      createdAt: s.createdAt,
      content,
      name: s.name?.trim() || null,
      coverageThroughIcPost: s.coverageThroughIcPost,
      coveragePageId: s.coveragePageId,
      hidden: s.hidden,
      broken: s.broken,
      status,
      tokenCount: content ? estimateTokens(content) : null,
      jobActive: !!activeTypes?.has('story-to-date'),
      foldJobActive: !!activeTypes?.has('story-to-date-fold'),
      nameJobActive: !!activeTypes?.has('segment-name'),
      auditJobActive: !!activeTypes?.has('segment-audit'),
      auditVerdict: s.auditVerdict,
      auditMissing: s.auditMissing,
      auditAt: s.auditAt,
    }
  })

  const activeMemoryJobs: ActiveMemoryJobView[] = activeJobs
    .filter((j) => MEMORY_JOB_TYPES.has(j.jobType))
    .map((j: JobRow) => ({
      id: j.id,
      jobType: j.jobType,
      status: j.status as 'pending' | 'running',
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      targetSegmentId: j.targetStoryToDateId,
    }))

  segments.sort((a, b) => b.seq - a.seq)

  const ready = segments.filter((s) => s.status === 'ready')
  const last = ready.sort((a, b) => b.seq - a.seq)[0]

  return {
    segments,
    activeMemoryJobs,
    mergedCoverageThroughPost: last?.coverageThroughIcPost ?? null,
    icPostCount: countChainPosts(db, logbookId),
    total: segments.length,
    withContent: segments.filter((s) => s.status === 'ready').length,
    pending: segments.filter((s) => s.status === 'pending').length,
    broken: segments.filter((s) => s.status === 'broken').length,
  }
}
