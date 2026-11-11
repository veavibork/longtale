import { useReasoningPrefs, getReasoningTraces, setReasoningTrace } from '../store'

/** Whether reasoning trace UI renders at all (pending stream + cached traces). */
export function useReasoningDisplayPrefs() {
  return useReasoningPrefs()
}

export function loadAllReasoningTraces(storyId: string): Record<string, string> {
  return getReasoningTraces(storyId)
}

export function ReasoningTracePanel({
  thinking,
  expanded,
  autoScroll,
}: {
  thinking: string
  expanded: boolean
  /** While prose hasn't started yet, keep the pre scrolled to the latest tokens. */
  autoScroll?: boolean
}) {
  return (
    <details className="pending-reasoning" open={expanded}>
      <summary>Reasoning trace</summary>
      <pre
        className="pending-reasoning-body"
        ref={(el) => {
          if (el && autoScroll) el.scrollTop = el.scrollHeight
        }}
      >
        {thinking}
      </pre>
    </details>
  )
}

/** Persist a completed agent reasoning trace for replay when Trace: On. */
export function saveReasoningTrace(storyId: string, pageId: string, thinking: string): void {
  setReasoningTrace(storyId, pageId, thinking)
}
