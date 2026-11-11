/** Periodic pipeline health snapshots written to data/pipeline-health.log. */
import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../db/data-paths.js'

const logPath = () => path.join(dataDir(), 'pipeline-health.log')
const MAX_ENTRIES = 200
const MAX_LOG_BYTES = 256 * 1024

export interface HealthSnapshot {
  at: string
  activeJobs: number
  pendingJobs: number
  slotsUsed: number
  slotsMax: number
  hordeJobsRunning: number
  trackedStories: number
}

function appendLine(obj: HealthSnapshot): void {
  try {
    const line = JSON.stringify(obj)
    if (!existsSync(logPath())) writeFileSync(logPath(), '')
    appendFileSync(logPath(), line + '\n')
    const size = statSync(logPath()).size
    if (size > MAX_LOG_BYTES) trimLog()
  } catch {
    // Best-effort — never break the caller.
  }
}

function trimLog(): void {
  const lines = readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean)
  const trimmed = lines.slice(-MAX_ENTRIES)
  writeFileSync(logPath(), trimmed.join('\n') + (trimmed.length ? '\n' : ''))
}

let interval: ReturnType<typeof setInterval> | null = null

/** Start periodic snapshots. */
export function startHealthSnapshots(
  getSnapshot: () => Omit<HealthSnapshot, 'at'>,
  intervalMs = 60_000,
): void {
  if (interval) return
  interval = setInterval(() => {
    appendLine({ at: new Date().toISOString(), ...getSnapshot() })
  }, intervalMs)
  interval.unref() // don't keep the process alive
}

export function stopHealthSnapshots(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
}
