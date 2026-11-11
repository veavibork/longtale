import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchModelConfigs,
  fetchModelProfiles,
  fetchSettingsSpace,
  type GenerationOptions,
  type ModelConfig,
  type ModelProfileRow,
} from '../api'
import { getStoryToggles, setStoryToggles, type ToggleIndices } from '../store'

export const TOGGLE_LENGTH_SPACE = 'toggle-length'
export const TOGGLE_EFFORT_SPACE = 'toggle-effort'

export interface EffortPreset {
  id: string
  label: string
  enableThinking: boolean
  thinkingBudget?: number
}

/** 0 = "Auto": no per-post override, the Author agent's configured responseLimit applies. */
const DEFAULT_LENGTH = [0, 100, 300, 500]
const DEFAULT_EFFORT: EffortPreset[] = [
  { id: 'standard', label: 'Standard', enableThinking: false },
  { id: 'thinking', label: 'Thinking', enableThinking: true, thinkingBudget: 4096 },
  { id: 'deep', label: 'Deep', enableThinking: true, thinkingBudget: 16384 },
]

/** Effort label that carries the primary Author model's probed caveats. */
function effortLabelFor(effort: EffortPreset, profile: ModelProfileRow | undefined): string {
  const p = profile?.profile
  if (!p || (p.callsSucceeded ?? 0) === 0) return effort.label
  if (effort.enableThinking && p.thinkingOnProduces === false) return `${effort.label} (no effect)`
  if (!effort.enableThinking && p.thinkingOffSuppresses === false) {
    return `${effort.label} (thinks anyway)`
  }
  if (effort.enableThinking && effort.thinkingBudget != null && p.thinkingBudgetHonored === false) {
    return `${effort.label} (budget ignored)`
  }
  return effort.label
}

export function useStoryToggles(storyId: string) {
  const [lengthSteps, setLengthSteps] = useState<number[]>(DEFAULT_LENGTH)
  const [efforts, setEfforts] = useState<EffortPreset[]>(DEFAULT_EFFORT)
  const [authorModels, setAuthorModels] = useState<ModelConfig[]>([])
  const [modelProfiles, setModelProfiles] = useState<ModelProfileRow[]>([])
  const [indices, setIndices] = useState<ToggleIndices>(() => getStoryToggles(storyId))

  useEffect(() => {
    setIndices(getStoryToggles(storyId))
  }, [storyId])

  useEffect(() => {
    void Promise.all([
      fetchSettingsSpace<number[]>(TOGGLE_LENGTH_SPACE),
      fetchSettingsSpace<EffortPreset[]>(TOGGLE_EFFORT_SPACE),
      fetchModelConfigs(),
      fetchModelProfiles().catch(() => [] as ModelProfileRow[]),
    ])
      .then(([len, effort, configs, profiles]) => {
        if (len?.length) setLengthSteps(len)
        if (effort?.length) setEfforts(effort)
        setAuthorModels(configs.filter((c) => c.active && c.useAuthor))
        setModelProfiles(profiles)
      })
      .catch(() => {})
  }, [])

  const persist = useCallback(
    (next: ToggleIndices) => {
      setIndices(next)
      setStoryToggles(storyId, next)
    },
    [storyId],
  )

  function cycle(field: keyof ToggleIndices, max: number) {
    persist({ ...indices, [field]: (indices[field] + 1) % Math.max(max, 1) })
  }

  const labels = useMemo(() => {
    const len = lengthSteps[indices.length % lengthSteps.length] ?? lengthSteps[0]
    const effort = efforts[indices.effort % efforts.length]
    // Effort caveats come from the primary Author config (first in fallback order), which generates.
    const primaryAuthor = authorModels[0]
    const authorProfile = primaryAuthor
      ? modelProfiles.find(
          (p) => p.provider === primaryAuthor.provider && p.modelId === primaryAuthor.model,
        )
      : undefined
    return {
      length: len != null ? (len === 0 ? 'Auto' : `${len}t`) : 'Length',
      effort: effort ? effortLabelFor(effort, authorProfile) : 'Effort',
    }
  }, [indices, lengthSteps, efforts, authorModels, modelProfiles])

  const generationOptions = useCallback((): GenerationOptions | undefined => {
    const options: GenerationOptions = {}
    const len = lengthSteps[indices.length % lengthSteps.length]
    // 0 = "Auto": send no override, the Author agent's configured responseLimit applies.
    if (len != null && len > 0) options.responseLimit = len
    const effort = efforts[indices.effort % efforts.length]
    if (effort) {
      options.effort = {
        enableThinking: effort.enableThinking,
        thinkingBudget: effort.thinkingBudget,
      }
    }
    return Object.keys(options).length ? options : undefined
  }, [indices.length, indices.effort, lengthSteps, efforts])

  return {
    labels,
    cycleLength: () => cycle('length', lengthSteps.length),
    cycleEffort: () => cycle('effort', efforts.length),
    generationOptions,
  }
}
