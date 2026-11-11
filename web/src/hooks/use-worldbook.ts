import { useQuery } from '@tanstack/react-query'
import { fetchWorldbook } from '../api'

export function useWorldbook(storyId: string | null, opts?: { background?: boolean }) {
  // No refetchInterval: freshness comes from mutation-hook invalidations (local edits) and the story events.
  return useQuery({
    queryKey: ['worldbook', storyId],
    queryFn: () => fetchWorldbook(storyId!, opts),
    enabled: !!storyId,
  })
}
