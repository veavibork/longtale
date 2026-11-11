import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getStoryDb, closeStoryDb } from '../../src/db/story-db.js'

const STORY = 'story-db-test'
let dataDir: string
let originalDataDir: string | undefined

beforeEach(() => {
  originalDataDir = process.env.LONGTALE_DATA_DIR
  dataDir = mkdtempSync(path.join(tmpdir(), 'longtale-story-db-'))
  process.env.LONGTALE_DATA_DIR = dataDir
})

afterEach(() => {
  closeStoryDb(STORY)
  if (originalDataDir === undefined) delete process.env.LONGTALE_DATA_DIR
  else process.env.LONGTALE_DATA_DIR = originalDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function seedSegmentAndJob(db: ReturnType<typeof getStoryDb>, status: string) {
  db.prepare(`INSERT INTO book (id, created_at, book_type) VALUES ('b1', 'now', 'logbook')`).run()
  db.prepare(
    `INSERT INTO story_to_date_segment (id, created_at, book_id, kind, content, seq) VALUES ('s1', 'now', 'b1', 'fold', 'x', 0)`,
  ).run()
  db.prepare(
    `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('j1', 'now', 's1', 'story-to-date-fold', ?)`,
  ).run(status)
}

describe('getStoryDb', () => {
  it('creates the full schema and enforces foreign keys', () => {
    const db = getStoryDb(STORY)
    const jobColumns = (db.pragma('table_info(jobs)') as { name: string }[]).map((c) => c.name)
    expect(jobColumns).toEqual(
      expect.arrayContaining(['input_token_estimate', 'horde_request_id', 'result_summary']),
    )

    expect(() => seedSegmentAndJob(db, 'pending')).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('bad', 'now', 'missing', 'story-to-date', 'pending')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('keeps data on reopen and re-pends jobs left running by a crash', () => {
    const db = getStoryDb(STORY)
    seedSegmentAndJob(db, 'running')
    closeStoryDb(STORY)

    const reopened = getStoryDb(STORY)
    const job = reopened.prepare(`SELECT status FROM jobs WHERE id = 'j1'`).get() as {
      status: string
    }
    expect(job.status).toBe('pending')
  })

  it('leaves running jobs alone when recovery is skipped', () => {
    const db = getStoryDb(STORY)
    seedSegmentAndJob(db, 'running')
    closeStoryDb(STORY)

    const reopened = getStoryDb(STORY, { skipRecovery: true })
    const job = reopened.prepare(`SELECT status FROM jobs WHERE id = 'j1'`).get() as {
      status: string
    }
    expect(job.status).toBe('running')
  })
})
