import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// --------------------------------------------------------------------------- Types

interface ToggleIndices {
  length: number
  effort: number
}

interface ClientState {
  // App-level.
  selectedStoryId: string | null
  openTabs: string[]

  // Reasoning display prefs.
  reasoningShow: boolean
  reasoningExpanded: boolean

  // Story-scoped (keyed by storyId)
  storyModes: Record<string, 'guide' | 'play'>
  storyToggles: Record<string, ToggleIndices>
  reasoningTraces: Record<string, Record<string, string>>

  // Container collapse state (keyed by "scope.containerId")
  containerCollapsed: Record<string, boolean>
}

// --------------------------------------------------------------------------- Store

export const useClientStore = create<ClientState>()(
  persist(
    (): ClientState => ({
      selectedStoryId: null,
      openTabs: [],
      reasoningShow: true,
      reasoningExpanded: false,
      storyModes: {},
      storyToggles: {},
      reasoningTraces: {},
      containerCollapsed: {},
    }),
    {
      name: 'longtale.ui',
      version: 1,
      // Only persist UI state, not auth (session/user IDs stay in api/client.ts)
      partialize: (state) => ({
        selectedStoryId: state.selectedStoryId,
        openTabs: state.openTabs,
        reasoningShow: state.reasoningShow,
        reasoningExpanded: state.reasoningExpanded,
        storyModes: state.storyModes,
        storyToggles: state.storyToggles,
        reasoningTraces: state.reasoningTraces,
        containerCollapsed: state.containerCollapsed,
      }),
    },
  ),
)

export function useReasoningPrefs() {
  const show = useClientStore((s) => s.reasoningShow)
  const expanded = useClientStore((s) => s.reasoningExpanded)
  return {
    showReasoning: show,
    reasoningExpanded: expanded,
    toggleShowReasoning: () =>
      useClientStore.setState((s) => ({ reasoningShow: !s.reasoningShow })),
    toggleReasoningExpanded: () =>
      useClientStore.setState((s) => ({ reasoningExpanded: !s.reasoningExpanded })),
  }
}

export function useStoryMode(
  storyId: string,
  fallback: 'guide' | 'play' = 'play',
): ['guide' | 'play', (mode: 'guide' | 'play') => void] {
  const mode = useClientStore((s) => s.storyModes[storyId] ?? fallback)
  const setMode = (next: 'guide' | 'play') =>
    useClientStore.setState((s) => ({ storyModes: { ...s.storyModes, [storyId]: next } }))
  return [mode, setMode]
}

export function useContainerCollapsed(scope: string, containerId: string): [boolean, () => void] {
  const key = `${scope}.${containerId}`
  const collapsed = useClientStore((s) => s.containerCollapsed[key] ?? false)
  const toggle = () =>
    useClientStore.setState((s) => ({
      containerCollapsed: { ...s.containerCollapsed, [key]: !s.containerCollapsed[key] },
    }))
  return [collapsed, toggle]
}

// --- Imperative accessors (for non-hook contexts like saveReasoningTrace) ---

export function getReasoningTraces(storyId: string): Record<string, string> {
  return useClientStore.getState().reasoningTraces[storyId] ?? {}
}

export function setReasoningTrace(storyId: string, pageId: string, thinking: string) {
  const trimmed = thinking.trim()
  if (!trimmed) return
  const state = useClientStore.getState()
  const map = { ...(state.reasoningTraces[storyId] ?? {}) }
  // Delete-then-reinsert so a re-recorded pageId moves to the end of key order (most recent)
  delete map[pageId]
  map[pageId] = trimmed
  // Cap at 80 entries per story, evicting the least-recently-written first.
  const ids = Object.keys(map)
  if (ids.length > 80) {
    for (const id of ids.slice(0, ids.length - 80)) delete map[id]
  }
  useClientStore.setState({
    reasoningTraces: { ...state.reasoningTraces, [storyId]: map },
  })
}

export function getStoryToggles(storyId: string): ToggleIndices {
  return (
    useClientStore.getState().storyToggles[storyId] ?? {
      length: 1,
      effort: 0,
    }
  )
}

export function setStoryToggles(storyId: string, indices: ToggleIndices) {
  const state = useClientStore.getState()
  useClientStore.setState({
    storyToggles: { ...state.storyToggles, [storyId]: indices },
  })
}

export function setSelectedStoryId(id: string | null) {
  useClientStore.setState({ selectedStoryId: id })
}

export function setOpenTabs(ids: string[]) {
  useClientStore.setState({ openTabs: ids })
}

export type { ToggleIndices }
