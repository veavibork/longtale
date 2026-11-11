import type { ActiveJob, JobStreamEvent, LogPage } from '../api'
import type { PendingReply, StoryViewAction } from './StoryViewReducer'

// --------------------------------------------------------------------------- Context passed to every handler

export interface StreamHandlerCtx {
  dispatch: (action: StoryViewAction) => void
  /** Mutable snapshot of pendingReplies kept current every render. */
  pendingRef: { current: Record<string, PendingReply> }
  /** Accumulates thinking text independently of reducer state. */
  accumulatedThinkingRef: { current: Record<string, string> }
  /** Called by terminal handlers (done/error/cancelled) to close the EventSource. */
  closeConnection: (pageId: string) => void
  storyId: string
  pageId: string
  jobId: string
  refresh: () => Promise<LogPage>
  fetchActiveJobs: (storyId: string) => Promise<ActiveJob[]>
  /** Self-reference for followUp chaining — the done handler calls this when the server signals a follow-up. */
  watchJob: (jobId: string, pageId: string, onDone?: () => void, startedAt?: number) => void
  onDone: (() => void) | undefined
  setError: (error: string | null) => void
  estimatePrefill: (inputTokens: number | null | undefined) => number
  saveReasoningTrace: (storyId: string, pageId: string, thinking: string) => void
}

export type StreamEventHandler = (event: JobStreamEvent, ctx: StreamHandlerCtx) => void

// --------------------------------------------------------------------------- Individual handlers

function handleToken(
  event: { type: 'token'; text: string },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_TOKEN', pageId, text: event.text })
}

function handleThinking(
  event: { type: 'thinking'; text: string },
  { dispatch, pageId, accumulatedThinkingRef }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_THINKING', pageId, thinking: event.text })
  accumulatedThinkingRef.current[pageId] =
    (accumulatedThinkingRef.current[pageId] ?? '') + event.text
}

function handleMeta(
  event: { type: 'meta'; inputTokenEstimate: number },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_META', pageId, inputTokenEstimate: event.inputTokenEstimate })
}

function handleReset(
  event: { type: 'reset'; thinking: boolean; text: boolean; label?: string },
  { dispatch, pageId, accumulatedThinkingRef }: StreamHandlerCtx,
): void {
  dispatch({
    type: 'PENDING_RESET',
    pageId,
    text: event.text,
    thinking: event.thinking,
    label: event.label,
  })
  // A thinking reset means the attempt so far is being discarded.
  if (event.thinking) delete accumulatedThinkingRef.current[pageId]
}

function handleProgress(
  event: { type: 'progress'; label: string },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: event.label })
}

function handleSync(
  event: {
    type: 'sync'
    text: string
    thinking?: string
    progress?: string
    inputTokenEstimate?: number
  },
  { dispatch, pageId, pendingRef, estimatePrefill }: StreamHandlerCtx,
): void {
  const cur = pendingRef.current[pageId]
  if (!cur) return
  const hasText = !!event.text.trim()
  const hasThinking = !!event.thinking?.trim()
  const waitPhase = hasText ? 'generating' : hasThinking ? 'reasoning' : cur.waitPhase
  const prefillEstimateSec =
    event.inputTokenEstimate != null
      ? estimatePrefill(event.inputTokenEstimate)
      : cur.prefillEstimateSec
  dispatch({
    type: 'PENDING_TEXT_SNAPSHOT',
    pageId,
    text: event.text,
    thinking: event.thinking,
    progress: event.progress,
    inputTokenEstimate: event.inputTokenEstimate,
    prefillEstimateSec,
    waitPhase,
  })
}
function handleDone(
  event: { type: 'done'; fullText: string; followUp?: { jobId: string; pageId: string } },
  {
    dispatch,
    pageId,
    pendingRef,
    accumulatedThinkingRef,
    storyId,
    refresh,
    watchJob,
    onDone,
    setError,
    saveReasoningTrace,
    closeConnection,
  }: StreamHandlerCtx,
): void {
  const cur = pendingRef.current[pageId]
  const thinking = accumulatedThinkingRef.current[pageId] ?? cur?.thinking
  if (thinking?.trim()) saveReasoningTrace(storyId, pageId, thinking)
  // Job finished: clear the accumulator so a later Retry on this page starts empty.
  delete accumulatedThinkingRef.current[pageId]
  // Don't drop the pending entry yet — entries[] still has this page's content as null.
  dispatch({ type: 'PENDING_DONE', pageId })
  void refresh()
    .then(() => {
      dispatch({ type: 'PENDING_REMOVE', pageId })
    })
    .catch((err) => {
      console.error('refresh after job done failed', err)
      setError(err instanceof Error ? err.message : String(err))
      dispatch({ type: 'PENDING_REMOVE', pageId })
    })
  // This job is finished, so close its own connection unconditionally.
  closeConnection(pageId)
  // Pre-kickoff setup turns are dual-pass — a second.
  if (event.followUp) watchJob(event.followUp.jobId, event.followUp.pageId)
  onDone?.()
}

function handleError(
  event: { type: 'error'; message: string },
  {
    dispatch,
    pageId,
    setError,
    closeConnection,
    storyId,
    jobId,
    watchJob,
    refresh,
    fetchActiveJobs,
  }: StreamHandlerCtx,
): void {
  closeConnection(pageId)
  // Check if the job is still alive server-side before giving up.
  void (async () => {
    try {
      const jobs = await fetchActiveJobs(storyId)
      const job = jobs.find((j) => j.id === jobId)
      if (job && (job.status === 'running' || job.status === 'pending')) {
        watchJob(jobId, pageId)
        return
      }
      // Job is terminal — pull final content and remove.
      await refresh()
    } catch {
      // fetch failed — treat as terminal.
    }
    dispatch({ type: 'PENDING_FAIL', pageId })
    setError(event.message)
  })()
}

function handleCancelled(
  _event: { type: 'cancelled' },
  { dispatch, pageId, closeConnection }: StreamHandlerCtx,
): void {
  closeConnection(pageId)
  dispatch({ type: 'PENDING_CANCELLED', pageId })
}

function handleQueued(_event: { type: 'queued' }, { dispatch, pageId }: StreamHandlerCtx): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: 'Queued…' })
}

function handlePrefill(
  event: { type: 'prefill'; inputTokenEstimate?: number },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: undefined })
  // 'prefill' fires when the worker actually starts the job — anchor the prefill countdown here.
  dispatch({
    type: 'PENDING_META',
    pageId,
    inputTokenEstimate: event.inputTokenEstimate,
    runningStartedAt: Date.now(),
  })
}

// --------------------------------------------------------------------------- Switch-table

export const STREAM_HANDLERS: Record<string, StreamEventHandler> = {
  token: handleToken as StreamEventHandler,
  thinking: handleThinking as StreamEventHandler,
  meta: handleMeta as StreamEventHandler,
  reset: handleReset as StreamEventHandler,
  progress: handleProgress as StreamEventHandler,
  sync: handleSync as StreamEventHandler,
  done: handleDone as StreamEventHandler,
  error: handleError as StreamEventHandler,
  cancelled: handleCancelled as StreamEventHandler,
  queued: handleQueued as StreamEventHandler,
  prefill: handlePrefill as StreamEventHandler,
}
