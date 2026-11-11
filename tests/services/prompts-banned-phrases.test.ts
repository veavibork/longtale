import { describe, it, expect } from 'vitest'
import { buildIcProseSteering } from '../../src/prompts.js'
import { DEFAULT_BANNED_PHRASES } from '../../src/services/banned-phrases.js'

describe('banned phrases in the steering note', () => {
  it('seeds "impossibly" by default', () => {
    expect(DEFAULT_BANNED_PHRASES).toEqual(['impossibly'])
  })

  it('lists each phrase, skipping blank entries', () => {
    const note = buildIcProseSteering({ bannedPhrases: ['impossibly', '  ', 'suddenly'] })
    expect(note).toContain('Never use these words or phrases: "impossibly", "suddenly".')
  })

  it('adds nothing when the list is empty or missing', () => {
    expect(buildIcProseSteering({ bannedPhrases: [] })).not.toContain('Never use')
    expect(buildIcProseSteering()).not.toContain('Never use')
  })
})
