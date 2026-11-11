/** Cancel handling for the pipeline runner — extracted from dispatch.ts so that route handlers. */
import type Database from 'better-sqlite3'
import { cancelJob, finishJob } from '../db/job-store.js'
import { fillTextGeneration } from '../db/text-store.js'
import { getJobBuffer, publishDone, publishCancelled } from './job-events.js'
import { JobCancelledError } from '../inference/featherless.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'

/** Tracks which fallback candidate is actively streaming for a job. */
export const streamingModels = new Map<string, string>()

/** One AbortController per currently-running job. */
export const runningControllers = new Map<string, AbortController>()

export function beginCancellableWorkerJob(jobId: string): AbortController {
  const controller = new AbortController()
  runningControllers.set(jobId, controller)
  return controller
}

export function endCancellableWorkerJob(jobId: string): void {
  runningControllers.delete(jobId)
}

/** Aborts a running job's in-flight call. */
export function requestJobCancel(jobId: string): boolean {
  const controller = runningControllers.get(jobId)
  if (!controller) return false
  controller.abort(new JobCancelledError())
  return true
}

/** User hit Stop. */
export function handleStreamingCancel(
  db: Database.Database,
  jobId: string,
  targetTextId: string,
  startedAt: number,
  options?: {
    genOptions?: GenerationOptions
    onPartialCommit?: (partial: string) => void
  },
): void {
  const partial = getJobBuffer(jobId)?.text?.trim()
  if (partial) {
    const model = streamingModels.get(jobId) ?? 'unknown'
    streamingModels.delete(jobId)
    const tokenEstimate = Math.ceil(partial.length / 4)
    const metrics: Record<string, unknown> = {
      elapsedMs: Date.now() - startedAt,
      tokenEstimate,
      truncated: true,
    }
    if (options?.genOptions) metrics.toggles = options.genOptions
    fillTextGeneration(db, targetTextId, {
      genPackage: partial,
      genMetrics: JSON.stringify(metrics),
    })
    options?.onPartialCommit?.(partial)
    finishJob(db, jobId, 'done', undefined, {
      model,
      tokenEstimate,
      elapsedMs: Date.now() - startedAt,
    })
    publishDone(jobId, partial)
  } else {
    streamingModels.delete(jobId)
    cancelJob(db, jobId)
    publishCancelled(jobId)
  }
}
