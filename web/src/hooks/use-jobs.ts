import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJobs, fetchSlots, cancelJob, panicStopAllJobs } from '../api'

export function useJobs(
  storyId: string | null,
  opts?: { background?: boolean; refetchInterval?: number; pollOnlyWhileActive?: boolean },
) {
  return useQuery({
    queryKey: ['jobs', storyId],
    queryFn: () => fetchJobs(storyId!, opts),
    enabled: !!storyId,
    // pollOnlyWhileActive: interval polling runs only while something is pending/running.
    refetchInterval: opts?.pollOnlyWhileActive
      ? (query) =>
          (query.state.data ?? []).some((j) => j.status === 'running' || j.status === 'pending')
            ? (opts.refetchInterval ?? 2000)
            : false
      : opts?.refetchInterval,
  })
}

export function useSlots(opts?: { background?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: ['slots'],
    queryFn: () => fetchSlots(opts),
    refetchInterval: opts?.refetchInterval,
  })
}

export function useCancelJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, jobId }: { storyId: string; jobId: string }) =>
      cancelJob(storyId, jobId),
    onSuccess: (_data, { storyId }) => {
      qc.invalidateQueries({ queryKey: ['story-to-date', storyId] })
      qc.invalidateQueries({ queryKey: ['jobs', storyId] })
    },
  })
}

/** Panic button — stops every pending/running job for this user, across every story. */
export function usePanicStopAllJobs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => panicStopAllJobs(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['active-jobs'] })
      qc.invalidateQueries({ queryKey: ['slots'] })
      qc.invalidateQueries({ queryKey: ['story-to-date'] })
    },
  })
}
