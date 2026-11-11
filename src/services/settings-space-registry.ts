import { z } from 'zod'
import { BANNED_PHRASES_SPACE, DEFAULT_BANNED_PHRASES } from './banned-phrases.js'
import { GLOBAL_CSS_SPACE, DEFAULT_GLOBAL_CSS } from '../defaults/global-css.js'
import { PLAY_TAB_SPACE, DEFAULT_PLAY_TAB_SETTINGS } from './display-preferences.js'
import {
  TOGGLE_LENGTH_SPACE,
  TOGGLE_EFFORT_SPACE,
  DEFAULT_TOGGLE_LENGTH,
  DEFAULT_TOGGLE_EFFORT,
} from './generation-presets.js'

export const SETTINGS_SPACE_DEFAULTS: Record<string, unknown> = {
  [BANNED_PHRASES_SPACE]: DEFAULT_BANNED_PHRASES,
  [GLOBAL_CSS_SPACE]: DEFAULT_GLOBAL_CSS,
  [PLAY_TAB_SPACE]: DEFAULT_PLAY_TAB_SETTINGS,
  [TOGGLE_LENGTH_SPACE]: DEFAULT_TOGGLE_LENGTH,
  [TOGGLE_EFFORT_SPACE]: DEFAULT_TOGGLE_EFFORT,
}

export function getSpaceDefault(space: string): unknown {
  if (!(space in SETTINGS_SPACE_DEFAULTS)) return undefined
  return SETTINGS_SPACE_DEFAULTS[space]
}

export function isKnownSpace(space: string): boolean {
  return space in SETTINGS_SPACE_DEFAULTS
}

/** Per-post generation overrides from the input-bar Length and Effort toggles. */
export const generationOptionsSchema = z
  .object({
    responseLimit: z.number().int().positive().max(1_000_000).optional(),
    effort: z
      .object({
        enableThinking: z.boolean().optional(),
        thinkingBudget: z.number().int().nonnegative().max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type GenerationOptions = z.infer<typeof generationOptionsSchema>
