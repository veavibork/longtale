import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { streamStoryEvents } from '../api'

const KIND_QUERY_KEYS: Record<'worldbook' | 'segments' | 'jobs', string> = {
  worldbook: 'worldbook',
  segments: 'story-to-date',
  // 'jobs' pings fire on creation, claim (pending→running), completion, and cancel.
  jobs: 'jobs',
}

/** One SSE connection per loaded story that turns server-side data changes. */
export function useStoryEvents(storyId: string | null): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!storyId) return
    return streamStoryEvents(
      storyId,
      (event) => {
        if (event.type !== 'data-changed') return
        void queryClient.invalidateQueries({ queryKey: [KIND_QUERY_KEYS[event.kind], storyId] })
      },
      () => {
        // Reconnected after a drop — refetch both views to cover anything missed while offline.
        for (const key of Object.values(KIND_QUERY_KEYS)) {
          void queryClient.invalidateQueries({ queryKey: [key, storyId] })
        }
      },
    )
  }, [storyId, queryClient])
}
