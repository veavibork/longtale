import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RATINGS_PATH = path.resolve(__dirname, '../defaults/featherless-tag-ratings.json')
import type { AgentRole } from '../db/model-config-store.js'

export type TagFilterVerdict = 'always' | 'never' | 'neutral'
export interface TagRating {
  filter: TagFilterVerdict
  worker: number
  editor: number
  author: number
  note?: string
}

export type TagCategory =
  | 'capabilities'
  | 'families'
  | 'modalities'
  | 'parameter_bucket'
  | 'domains'
  | 'creative'
  | 'architectures'
  | 'training'

type RatingsTable = Record<TagCategory, Record<string, TagRating>>

let cache: RatingsTable | null = null

function loadRatings(): RatingsTable {
  if (!cache) {
    cache = JSON.parse(readFileSync(RATINGS_PATH, 'utf-8')) as RatingsTable
  }
  return cache
}

/** Structurally required tag values in a category, regardless of role (currently just modalities.text). */
export function getAlwaysTags(category: TagCategory): string[] {
  return Object.entries(loadRatings()[category] ?? {})
    .filter(([, rating]) => rating.filter === 'always')
    .map(([value]) => value)
}

/** Top-rated tag values in a category for a given role. */
export function getTopTagsForRole(
  category: TagCategory,
  role: AgentRole,
  options?: { minStars?: number; limit?: number },
): string[] {
  const minStars = options?.minStars ?? 4
  const scored = Object.entries(loadRatings()[category] ?? {})
    .filter(([, rating]) => rating.filter !== 'never' && rating[role] >= minStars)
    .sort(([, a], [, b]) => b[role] - a[role])
  return (options?.limit ? scored.slice(0, options.limit) : scored).map(([value]) => value)
}
