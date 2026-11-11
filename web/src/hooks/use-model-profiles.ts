import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchModelProfiles, requestModelProbe, cancelModelProbe } from '../api'

/** Model format profiles + probe-queue state. */
export function useModelProfiles() {
  return useQuery({
    queryKey: ['model-profiles'],
    queryFn: () => fetchModelProfiles({ background: true }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((p) => p.status === 'running' || p.status === 'pending')
        ? 2000
        : false,
  })
}

export function useRequestModelProbe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      requestModelProbe(provider, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-profiles'] }),
  })
}

export function useCancelModelProbe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      cancelModelProbe(provider, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-profiles'] }),
  })
}
