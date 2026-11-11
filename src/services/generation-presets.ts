export const TOGGLE_LENGTH_SPACE = 'toggle-length'
export const TOGGLE_EFFORT_SPACE = 'toggle-effort'

export interface EffortPreset {
  id: string
  label: string
  /** Passed as chat_template_kwargs when the model supports reasoning toggles. */
  enableThinking?: boolean
  thinkingBudget?: number
}

/** 0 = "Auto": no per-post override, the Author agent's configured responseLimit applies. */
export const DEFAULT_TOGGLE_LENGTH = [0, 100, 300, 500]

export const DEFAULT_TOGGLE_EFFORT: EffortPreset[] = [
  { id: 'off', label: 'Off', enableThinking: false },
  { id: 'on', label: 'On', enableThinking: true },
]
