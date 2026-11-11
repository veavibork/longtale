import {
  EDITOR_SETUP_OPENING,
  EDITOR_SETUP_PROMPT,
  EDITOR_SETUP_WORLDBOOK,
  AUTHOR_KICKOFF_PROMPT,
  AUTHOR_SYSTEM_PROMPT,
  EDITOR_UPDATE_PROMPT,
  NAMING_PROMPT,
  SEGMENT_NAMING_PROMPT,
  WORLDBOOK_COMPACT_SYSTEM_PROMPT,
  buildIcProseSteering,
} from '../prompts.js'
import {
  buildDefaultBeginsSystemPrompt,
  buildFoldSystem,
  buildNextSceneContinuesSystemPrompt,
} from './story-to-date/engine.js'
import { buildAuditJudgeMessages } from './story-to-date/audit.js'

export interface PromptCatalogEntry {
  id: string
  name: string
  usedBy: string
  kind: 'system-prompt' | 'instruction'
  sourceFile: string
  content: string
}

/** Every system prompt and instruction the agents run on. Templates are rendered with sample values. */
export function getPromptCatalog(): PromptCatalogEntry[] {
  return [
    {
      id: 'author-system-prompt',
      name: 'Author — core system prompt',
      usedBy: 'Author',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: AUTHOR_SYSTEM_PROMPT,
    },
    {
      id: 'author-kickoff-prompt',
      name: 'Author — kickoff prompt',
      usedBy: 'Author (kickoff)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: AUTHOR_KICKOFF_PROMPT,
    },
    {
      id: 'author-ic-prose-steering',
      name: 'Author — IC prose steering (template)',
      usedBy: 'Author (every IC generation; Register injected at runtime)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: buildIcProseSteering({
        register: 'Lighthearted fantasy adventure. Vivid, wry, direct.',
        tenseGuard: true,
      }),
    },
    {
      id: 'editor-worldbook-compact-prompt',
      name: 'Editor — worldbook entry compaction',
      usedBy: 'Editor (manual Crunch worldbook)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: WORLDBOOK_COMPACT_SYSTEM_PROMPT,
    },
    {
      id: 'editor-setup-opening',
      name: 'Editor — new story opening line',
      usedBy: 'Editor (setup, canned)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_OPENING,
    },
    {
      id: 'editor-setup-prompt',
      name: 'Editor — setup conversation prompt',
      usedBy: 'Editor (setup conversation)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_PROMPT,
    },
    {
      id: 'editor-setup-worldbook',
      name: 'Editor — setup worldbook-authoring prompt',
      usedBy: 'Editor (setup worldbook pass)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_WORLDBOOK,
    },
    {
      id: 'editor-update-prompt',
      name: 'Editor — update session prompt',
      usedBy: 'Editor (update session)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_UPDATE_PROMPT,
    },
    {
      id: 'story-to-date-begins',
      name: 'Editor — first memory recap (template)',
      usedBy: 'Editor (story-to-date, first segment; sample input ceiling: post 24)',
      kind: 'system-prompt',
      sourceFile: 'src/services/story-to-date/engine.ts',
      content: buildDefaultBeginsSystemPrompt(24),
    },
    {
      id: 'story-to-date-continues',
      name: 'Editor — next-scene memory recap (template)',
      usedBy: 'Editor (story-to-date, later segments; sample: prior coverage 24, ceiling 36)',
      kind: 'system-prompt',
      sourceFile: 'src/services/story-to-date/engine.ts',
      content: buildNextSceneContinuesSystemPrompt(36, 24),
    },
    {
      id: 'story-to-date-fold',
      name: 'Editor — memory fold digest (template)',
      usedBy: 'Editor (story-to-date-fold; sample target: 200 words)',
      kind: 'system-prompt',
      sourceFile: 'src/services/story-to-date/engine.ts',
      content: buildFoldSystem(200),
    },
    {
      id: 'segment-audit',
      name: 'Editor — memory audit judge (template)',
      usedBy: 'Editor (segment-audit, manual; sample: posts 25 to 36)',
      kind: 'system-prompt',
      sourceFile: 'src/services/story-to-date/audit.ts',
      content: buildAuditJudgeMessages('', [], 25, 36)[0]?.content ?? '',
    },
    {
      id: 'worker-naming-prompt',
      name: 'Worker — story naming prompt',
      usedBy: 'Worker (story-name)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: NAMING_PROMPT,
    },
    {
      id: 'worker-segment-naming-prompt',
      name: 'Worker — scene naming prompt',
      usedBy: 'Worker (segment-name, from the recap text)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: SEGMENT_NAMING_PROMPT,
    },
  ]
}
