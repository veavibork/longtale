import { useQuery } from '@tanstack/react-query'
import { fetchModelConfigs } from '../api'

export function useModelConfigs() {
  return useQuery({
    queryKey: ['model-configs'],
    queryFn: fetchModelConfigs,
  })
}
