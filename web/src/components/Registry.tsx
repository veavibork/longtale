import type { ComponentType } from 'react'
import WorldbookView from '../views/WorldbookView'
import StoryPanel from '../views/StoryPanel'
import SavesView from '../views/SavesView'
import LogsView from '../views/LogsView'
import QueueView from '../views/QueueView'
import SegmentsView from '../views/SegmentsView'
import AgentsView from '../views/AgentsView'
import ContextView from '../views/ContextView'
import PromptsView from '../views/PromptsView'
import PreferencesView from '../views/PreferencesView'
import type { PanelProps } from '../lib/panel-types'

/** Which component renders for a given tab id is data. */
const REGISTRY: Record<string, ComponentType<PanelProps>> = {
  'story:play': StoryPanel,
  'story:saves': SavesView,
  'story:logs': LogsView,
  'story:queue': QueueView,
  'story:segments': SegmentsView,
  'lore:worldbook': WorldbookView,
  'lore:context': ContextView,
  'config:agents': AgentsView,
  'config:prompts': PromptsView,
  'preferences:': PreferencesView,
}

export function resolvePanel(id: string): ComponentType<PanelProps> | null {
  return REGISTRY[id] ?? null
}
