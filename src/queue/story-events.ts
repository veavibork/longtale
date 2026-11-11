import { EventEmitter } from 'node:events'

/** Story-scoped data-change bus — the invalidation counterpart to job-events.ts's per-job streams. */
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

export type StoryDataKind = 'worldbook' | 'segments' | 'jobs'

export interface StoryDataEvent {
  type: 'data-changed'
  kind: StoryDataKind
}

export function publishStoryDataChanged(storyId: string, kind: StoryDataKind): void {
  emitter.emit(storyId, { type: 'data-changed', kind } satisfies StoryDataEvent)
}

export function subscribeStoryEvents(
  storyId: string,
  onEvent: (event: StoryDataEvent) => void,
): () => void {
  emitter.on(storyId, onEvent)
  return () => emitter.off(storyId, onEvent)
}
