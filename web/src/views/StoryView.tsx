import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  continuePost,
  editPost,
  fetchActiveJobs,
  fetchLog,
  fetchPosition,
  forkStory,
  kickoff,
  postMessage,
  postSetupMessage,
  redoPosition,
  retryPost,
  startOocSession,
  streamJob,
  undoPosition,
  type LogEntry,
  type LogPage,
  type Position,
  type StoryPhase,
} from '../api'
import { DEFAULT_INPUT_BAR } from '../lib/layoutUtils'
import { useStoryToggles } from '../components/StoryToggles'
import {
  loadAllReasoningTraces,
  saveReasoningTrace,
  useReasoningDisplayPrefs,
} from '../components/ReasoningDisplay'
import type { LayoutButton, LayoutRegion } from '../api'
import './StoryView.css'
import StoryLog from '../components/StoryLog'
import StoryFooter from '../components/StoryFooter'
import { useStoryMode } from '../store'
import { estimatePrefillSeconds, jobElapsedAnchor } from './StoryViewHelpers'
import { STREAM_HANDLERS, type StreamHandlerCtx } from './streamHandlers'
import type { StoryViewAction } from './StoryViewReducer'
import { initialStoryViewState, storyViewReducer } from './StoryViewReducer'

/** Raw entries (both IC and hidden OOC pages) kept loaded at once before "load earlier" is needed. */
const LOG_PAGE_SIZE = 80

/** Nav's tab-based layout unmounts a panel entirely when its column is closed. */

/** Maps a click's page coordinates to an offset in the *source* content string. */
function resolveClickOffset(
  clientX: number,
  clientY: number,
  contentEl: HTMLElement,
): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(clientX, clientY)
    if (!range) return null
    node = range.startContainer
    offset = range.startOffset
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(clientX, clientY)
    if (!pos) return null
    node = pos.offsetNode
    offset = pos.offset
  } else {
    return null
  }
  if (!node || !contentEl.contains(node)) return null

  // Hit-testing usually lands inside a text node (offset = character index within it)
  if (node.nodeType !== Node.TEXT_NODE) {
    const children = node.childNodes
    if (children.length === 0) return null
    const landedAfterLastChild = offset >= children.length
    let child: Node = children[Math.min(offset, children.length - 1)]
    while (child.nodeType !== Node.TEXT_NODE && child.childNodes.length > 0) {
      child = landedAfterLastChild
        ? child.childNodes[child.childNodes.length - 1]
        : child.childNodes[0]
    }
    if (child.nodeType !== Node.TEXT_NODE) return null
    node = child
    offset = landedAfterLastChild ? (child.textContent?.length ?? 0) : 0
  }

  let el: HTMLElement | null = node.parentElement
  while (el && el !== contentEl && el.dataset.srcStart === undefined) {
    el = el.parentElement
  }
  if (!el || el.dataset.srcStart === undefined) return null
  return parseInt(el.dataset.srcStart, 10) + offset
}

export default function StoryView({
  storyId,
  phase,
  onKickedOff,
  inputBar,
  onReorder,
}: {
  storyId: string
  phase: StoryPhase
  onKickedOff?: () => void
  inputBar?: LayoutRegion
  onReorder?: (
    region: 'nav' | 'inputBar',
    containerId: string,
    reorderedButtons: LayoutButton[],
  ) => void
}) {
  const toggles = useStoryToggles(storyId)
  const reasoningPrefs = useReasoningDisplayPrefs()
  const { showReasoning, reasoningExpanded, toggleShowReasoning, toggleReasoningExpanded } =
    reasoningPrefs
  const [state, rawDispatch] = useReducer(storyViewReducer, undefined, initialStoryViewState)
  // Toggle from browser console: window.DEBUG_STORY = true.
  const dispatch = (action: StoryViewAction) => {
    if (window.DEBUG_STORY) {
      console.log('[dispatch]', action.type, action)
    }
    rawDispatch(action)
  }
  const {
    entries,
    hasMoreEntries,
    loadingEarlier,
    pendingReplies,
    hiddenPending,
    starting,
    traceCacheVersion,
  } = state
  // streamJob's EventSource outlives the render that created it — without this ref.
  const pendingRepliesRef = useRef(pendingReplies)
  pendingRepliesRef.current = pendingReplies

  /** Accumulates thinking text independently of reducer state. */
  const accumulatedThinkingRef = useRef<Record<string, string>>({})

  /** EventSource cleanup functions keyed by pageId. */
  const activeConnections = useRef<Map<string, () => void>>(new Map())

  // Close all EventSources on unmount.
  useEffect(() => {
    const connections = activeConnections.current
    return () => {
      connections.forEach((fn) => fn())
      connections.clear()
    }
  }, [])
  const reasoningTraces = useMemo(
    () => (showReasoning ? loadAllReasoningTraces(storyId) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- traceCacheVersion is a cache-bust sentinel
    [storyId, showReasoning, traceCacheVersion],
  )
  const toolbarContainers = inputBar?.containers?.length
    ? inputBar.containers
    : DEFAULT_INPUT_BAR.containers
  const [mode, setMode] = useStoryMode(storyId, phase === 'setup' ? 'guide' : 'play')
  const [position, setPosition] = useState<Position | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Keyed by agent pageId so multiple sends can be in flight at once.
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editInitialHeight, setEditInitialHeight] = useState<number | undefined>(undefined)
  // Set on focus so the overlay's Delete button acts on the one box that can be focused.
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Where to drop the cursor once the edit textarea mounts and focuses.
  const pendingCaretRef = useRef<number | null>(null)
  // The Virtuoso scroll container (wired via StoryLog's scrollerRef).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // Scroll position captured at click time so the edit transition can restore it.
  const preEditScrollTopRef = useRef<number | null>(null)

  // Hold the log's scroll position steady across the tap-to-edit transition.
  useLayoutEffect(() => {
    if (!editingPageId) return
    const target = preEditScrollTopRef.current
    const sc = scrollerRef.current
    if (target == null || !sc) return
    sc.scrollTop = target
    const raf1 = requestAnimationFrame(() => {
      sc.scrollTop = target
      requestAnimationFrame(() => {
        sc.scrollTop = target
      })
    })
    return () => cancelAnimationFrame(raf1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPageId])

  /** Only the most recent LOG_PAGE_SIZE raw entries are kept loaded (see loadEarlier) */
  async function refresh(): Promise<LogPage> {
    const oldestLoadedPageId = entries[0]?.pageId
    const page = await fetchLog(
      storyId,
      oldestLoadedPageId ? { throughPageId: oldestLoadedPageId } : { limit: LOG_PAGE_SIZE },
    )
    dispatch({ type: 'LOG_REFRESH', entries: page.entries, hasMore: page.hasMore })
    setPosition(await fetchPosition(storyId))
    return page
  }

  async function loadEarlier() {
    if (!hasMoreEntries || loadingEarlier || entries.length === 0) return
    dispatch({ type: 'LOG_LOAD_EARLIER_START' })
    try {
      const page = await fetchLog(storyId, {
        limit: LOG_PAGE_SIZE,
        beforePageId: entries[0].pageId,
      })
      dispatch({ type: 'LOG_PREPEND', entries: page.entries })
      dispatch({ type: 'LOG_LOAD_EARLIER_DONE', hasMore: page.hasMore })
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      dispatch({ type: 'LOG_LOAD_EARLIER_FAIL' })
    }
  }

  /** Undo/redo can rewind to a page older than whatever's currently loaded. */
  async function ensurePageLoaded(
    pageId: string | null,
    knownEntries: LogEntry[],
    knownHasMore: boolean,
  ) {
    if (!pageId) return
    let current = knownEntries
    let more = knownHasMore
    const fetchedBatches: LogEntry[][] = []
    while (more && current.length > 0 && !current.some((e) => e.pageId === pageId)) {
      const older = await fetchLog(storyId, {
        limit: LOG_PAGE_SIZE,
        beforePageId: current[0].pageId,
      })
      if (older.entries.length === 0) {
        more = false
        break
      }
      fetchedBatches.unshift(older.entries)
      current = [...older.entries, ...current]
      more = older.hasMore
    }
    if (fetchedBatches.length > 0) dispatch({ type: 'LOG_PREPEND', entries: fetchedBatches.flat() })
    dispatch({ type: 'LOG_LOAD_EARLIER_DONE', hasMore: more })
  }

  /** Finds log entries still mid-generation (agent pages with no content yet) and reattaches to whatever job. */
  async function resumeActiveJobs(freshEntries: LogEntry[]) {
    const unresolved = freshEntries.filter(
      (e) => e.role === 'agent' && e.content === null && e.textId,
    )
    if (unresolved.length === 0) return
    try {
      const jobs = await fetchActiveJobs(storyId)
      for (const entry of unresolved) {
        const job = jobs.find((j) => j.targetTextId === entry.textId)
        if (job) watchJob(job.id, entry.pageId, undefined, jobElapsedAnchor(job))
      }
    } catch (err) {
      console.error('failed to resume active jobs', err)
    }
  }

  useEffect(() => {
    void (async () => {
      const page = await refresh()
      await resumeActiveJobs(page.entries)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resumeActiveJobs changes per render; stable when storyId changes
  }, [storyId])

  // True while anything is generating, from any source (a queued send, kickoff, continue, or retry)
  const busy = starting || Object.keys(pendingReplies).length > 0

  function watchJob(jobId: string, pageId: string, onDone?: () => void, startedAt?: number) {
    dispatch({ type: 'PENDING_WATCH', pageId, jobId, startedAt: startedAt ?? Date.now() })
    // Close prior connection for this pageId — followUp chains a new watchJob for the same pageId.
    activeConnections.current.get(pageId)?.()
    const ctx: StreamHandlerCtx = {
      dispatch,
      pendingRef: pendingRepliesRef,
      accumulatedThinkingRef,
      storyId,
      pageId,
      jobId,
      fetchActiveJobs,
      refresh,
      watchJob,
      onDone,
      setError,
      estimatePrefill: estimatePrefillSeconds,
      saveReasoningTrace,
      closeConnection: (pid: string) => {
        activeConnections.current.get(pid)?.()
        activeConnections.current.delete(pid)
      },
    }
    const cleanup = streamJob(storyId, jobId, (event) => {
      if (window.DEBUG_STORY && event.type !== 'token') {
        console.log('[sse]', event.type, event)
      }
      const handler = STREAM_HANDLERS[event.type]
      if (handler) handler(event, ctx)
    })
    activeConnections.current.set(pageId, cleanup)
  }

  /** Shared send-then-stream path used by all four send handlers. */
  async function sendAndWatch(
    apiCall: () => Promise<{ jobId: string; agentPageId?: string }>,
    opts: { starting?: boolean; skipRefresh?: boolean; onDone?: () => void; pageId?: string } = {},
  ) {
    if (opts.starting) dispatch({ type: 'SET_STARTING', value: true })
    setError(null)
    try {
      const { jobId, agentPageId } = await apiCall()
      const targetPageId = opts.pageId ?? agentPageId!
      if (!opts.skipRefresh) await refresh()
      watchJob(jobId, targetPageId, opts.onDone)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      if (opts.starting) dispatch({ type: 'SET_STARTING', value: false })
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!draft.trim() || editingPageId) return
    const content = draft.trim()
    setDraft('')
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() =>
      mode === 'guide'
        ? postSetupMessage(storyId, content)
        : postMessage(storyId, content, genOpts),
    )
  }

  async function handleKickoff() {
    await sendAndWatch(() => kickoff(storyId), {
      starting: true,
      onDone: () => {
        setMode('play')
        onKickedOff?.()
      },
    })
  }

  async function handleContinue(guidance?: string) {
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() => continuePost(storyId, guidance, genOpts), { starting: true })
  }

  async function handleRetry(pageId: string, guidance?: string) {
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() => retryPost(storyId, pageId, guidance, genOpts), {
      starting: true,
      skipRefresh: true,
      pageId,
    })
  }

  function handleContinueClick() {
    const guidance = draft.trim() || undefined
    setDraft('')
    void handleContinue(guidance)
  }

  function handleRetryClick(pageId: string) {
    const guidance = draft.trim() || undefined
    setDraft('')
    void handleRetry(pageId, guidance)
  }

  /** Delegated on .log rather than a per-entry onClick. */
  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    if (editingPageId || busy) return
    const contentEl = (e.target as HTMLElement).closest<HTMLElement>('.entry-content')
    if (!contentEl) return
    const entryEl = contentEl.closest<HTMLElement>('.entry')
    const pageId = entryEl?.dataset.pageId
    if (!entryEl || !pageId) return
    const entry = shown.find((en) => en.pageId === pageId)
    if (!entry) return
    const content = entry.content ?? ''
    const clicked = resolveClickOffset(e.clientX, e.clientY, contentEl)
    pendingCaretRef.current =
      clicked !== null ? Math.max(0, Math.min(clicked, content.length)) : content.length

    // Capture the scroll position before editing so the restore effect can hold it steady.
    preEditScrollTopRef.current = scrollerRef.current?.scrollTop ?? null

    setEditingPageId(pageId)
    setEditDraft(content)
    setEditInitialHeight(contentEl.offsetHeight)
  }

  function cancelEdit() {
    setEditingPageId(null)
    setEditDraft('')
    setEditInitialHeight(undefined)
    editTextareaRef.current = null
    pendingCaretRef.current = null
  }

  async function saveEdit() {
    const pageId = editingPageId
    if (!pageId) return
    const entry = shown.find((en) => en.pageId === pageId)
    const changed = !!entry && editDraft !== (entry.content ?? '')
    cancelEdit()
    if (changed) {
      try {
        await editPost(storyId, pageId, editDraft)
        await refresh()
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** Fork acts on the edited text, not the pre-edit persisted content. */
  async function forkFromEdit() {
    const pageId = editingPageId
    if (!pageId) return
    await saveEdit()
    await handleFork(pageId)
  }

  /** Performs an actual forward-delete in the single open edit box. */
  function handleDeleteKey() {
    const el = editTextareaRef.current
    if (!el) return
    el.focus()
    const hasSelection = el.selectionStart !== el.selectionEnd
    const handled = document.execCommand(hasSelection ? 'delete' : 'forwardDelete')
    if (handled) {
      setEditDraft(el.value)
      return
    }
    // Fallback for environments without execCommand support — same net result, just not undoable.
    const start = el.selectionStart ?? editDraft.length
    const end = el.selectionEnd ?? editDraft.length
    const next =
      start === end
        ? editDraft.slice(0, start) + editDraft.slice(start + 1)
        : editDraft.slice(0, start) + editDraft.slice(end)
    setEditDraft(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start, start)
    })
  }

  async function handleUndo() {
    try {
      const pos = await undoPosition(storyId)
      setPosition(pos)
      const page = await refresh()
      await ensurePageLoaded(pos.currentPageId, page.entries, page.hasMore)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRedo() {
    try {
      const pos = await redoPosition(storyId)
      setPosition(pos)
      const page = await refresh()
      await ensurePageLoaded(pos.currentPageId, page.entries, page.hasMore)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Every Play→OOC switch post-kickoff marks a fresh session boundary so the Editor's context resets instead. */
  async function handleEnterOoc() {
    if (phase !== 'setup') {
      try {
        await startOocSession(storyId)
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    setMode('guide')
  }

  async function handleFork(pageId: string) {
    try {
      const forked = await forkStory(storyId, pageId)
      setError(null)
      alert(`Forked as "${forked.name}". Switch stories to play it (Saves UI isn't built yet).`)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pendingIds = new Set(Object.keys(pendingReplies))
  // Every OOC/setup page is hidden the moment it's created.
  const visible = entries.filter(
    (e) => (mode === 'play' ? !e.hidden : e.hidden) && !pendingIds.has(e.pageId),
  )
  const currentIdx = position?.currentPageId
    ? visible.findIndex((e) => e.pageId === position.currentPageId)
    : -1
  // After an undo, show only the entries up to the current position.
  const shown = currentIdx >= 0 ? visible.slice(0, currentIdx + 1) : visible
  const lastEntry = shown[shown.length - 1]
  const canRetry = !!lastEntry && lastEntry.role === 'agent'
  // Queued sends whose agent page already exists (created synchronously) but hasn't resolved yet.
  const pendingEntries = entries.filter(
    (e) =>
      pendingIds.has(e.pageId) &&
      (mode === 'play' ? !e.hidden : e.hidden) &&
      !hiddenPending.has(e.pageId),
  )

  return (
    <div className="story-view">
      <StoryLog
        onLogClick={handleLogClick}
        hasMoreEntries={hasMoreEntries}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlier()}
        scrollerRef={scrollerRef}
        shown={shown}
        editingPageId={editingPageId}
        editDraft={editDraft}
        onEditDraftChange={setEditDraft}
        editInitialHeight={editInitialHeight}
        editTextareaRef={editTextareaRef}
        pendingCaretRef={pendingCaretRef}
        reasoningTraces={reasoningTraces}
        reasoningExpanded={reasoningExpanded}
        showReasoning={showReasoning}
        mode={mode}
        pendingEntries={pendingEntries}
        pendingReplies={pendingReplies}
        storyId={storyId}
        onHiddenPendingAdd={(pageId) => dispatch({ type: 'HIDE_PENDING', pageId })}
      />

      <StoryFooter
        error={error}
        onDismissError={() => setError(null)}
        scrollerRef={scrollerRef}
        editingPageId={editingPageId}
        onSaveEdit={saveEdit}
        onCancelEdit={cancelEdit}
        onForkFromEdit={forkFromEdit}
        onDeleteEdit={handleDeleteKey}
        busy={busy}
        mode={mode}
        phase={phase}
        canRetry={canRetry}
        lastEntryPageId={lastEntry?.pageId}
        onRetry={handleRetryClick}
        onContinue={handleContinueClick}
        onKickoff={handleKickoff}
        onEnterOoc={handleEnterOoc}
        onSetMode={setMode}
        onUndo={handleUndo}
        onRedo={handleRedo}
        position={position}
        toolbarContainers={toolbarContainers}
        toggleLabels={toggles.labels}
        onCycleLength={toggles.cycleLength}
        onCycleEffort={toggles.cycleEffort}
        showReasoning={showReasoning}
        reasoningExpanded={reasoningExpanded}
        onToggleShowReasoning={toggleShowReasoning}
        onToggleReasoningExpanded={toggleReasoningExpanded}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={handleSubmit}
        onReorder={onReorder}
      />
    </div>
  )
}
