/** Story-to-date corpus windowing + coverage-sprint gate. */
import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from '../db/helpers.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText } from '../../src/db/content-store.js'
import {
  buildStoryCorpus,
  extractStoryBlockMissingOpenTag,
  looksLikeMidSceneEnding,
  looksNextSceneCoverageSprint,
  sanitizeStoryBlockContent,
  NEXT_SCENE_INPUT_WINDOW_POSTS,
  NEXT_SCENE_MAX_COVERAGE_DELTA,
} from '../../src/services/story-to-date/engine.js'

let db: Database.Database
let logbookId: string
let pageIds: string[]

const STORY_ID = 'test-story'
const POST_COUNT = 60

/** Wide budget so the token cutoff never binds — these tests isolate the post window. */
const CORPUS_OPTS = { contextLimit: 200_000, responseLimit: 2_000 }

beforeEach(() => {
  db = createStoryDb()
  logbookId = createBook(db, { bookType: 'logbook' }).id
  pageIds = []
  let prevId: string | null = null
  for (let i = 1; i <= POST_COUNT; i++) {
    const { page } = createPageWithText(db, {
      bookId: logbookId,
      prevPageId: prevId,
      role: i % 2 === 1 ? 'user' : 'agent',
      genPackage: `Post ${i} prose content for the scene in progress.`,
    })
    prevId = page.id
    pageIds.push(page.id)
  }
})

describe('buildStoryCorpus maxIncludedPosts', () => {
  it('caps included posts and the input ceiling at the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9], // prior coverage through post 10
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts).toHaveLength(NEXT_SCENE_INPUT_WINDOW_POSTS)
    expect(corpus.includedPosts[0]!.icPostNumber).toBe(11)
    expect(corpus.inputCeilingPost).toBe(10 + NEXT_SCENE_INPUT_WINDOW_POSTS)
    // The claimable delta is structurally capped regardless of what the model reports.
    expect(corpus.inputCeilingPost! - 10).toBeLessThanOrEqual(NEXT_SCENE_MAX_COVERAGE_DELTA)
  })

  it('includes the full backlog when no window is set', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9],
    })
    expect(corpus.includedPosts).toHaveLength(POST_COUNT - 10)
    expect(corpus.inputCeilingPost).toBe(POST_COUNT)
  })

  it('returns the remaining tail when the backlog is smaller than the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[POST_COUNT - 5], // 4 posts left
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts).toHaveLength(4)
    expect(corpus.inputCeilingPost).toBe(POST_COUNT)
  })

  it('counts only visible posts toward the window while numbering stays absolute', () => {
    // Hide posts 12 and 13: they occupy chain numbers but are excluded from Editor input.
    db.prepare('UPDATE page SET hidden = 1 WHERE id IN (?, ?)').run(pageIds[11], pageIds[12])
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9],
      maxIncludedPosts: 5,
    })
    expect(corpus.includedPosts.map((p) => p.icPostNumber)).toEqual([11, 14, 15, 16, 17])
    expect(corpus.inputCeilingPost).toBe(17)
  })

  it('token budget still binds inside the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      contextLimit: 100, // usable budget 50 tokens ≈ 4 posts of ~12 tokens
      responseLimit: 50,
      inputCutoff: 1,
      afterPageId: pageIds[9],
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts.length).toBeGreaterThan(0)
    expect(corpus.includedPosts.length).toBeLessThan(NEXT_SCENE_INPUT_WINDOW_POSTS)
  })
})

describe('looksNextSceneCoverageSprint', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

  it('rejects any delta over the hard cap regardless of block length', () => {
    expect(looksNextSceneCoverageSprint(words(2000), NEXT_SCENE_MAX_COVERAGE_DELTA + 1)).toBe(true)
  })

  it('rejects the live failure shape: 236 words claiming 56 posts', () => {
    expect(looksNextSceneCoverageSprint(words(236), 56)).toBe(true)
  })

  it('accepts a normal single-scene block', () => {
    expect(looksNextSceneCoverageSprint(words(150), 12)).toBe(false)
  })

  it('accepts a full-window claim with proportionate length', () => {
    expect(looksNextSceneCoverageSprint(words(120), NEXT_SCENE_MAX_COVERAGE_DELTA)).toBe(false)
  })

  it('still catches thin blocks inside the cap', () => {
    expect(looksNextSceneCoverageSprint(words(40), 20)).toBe(true)
  })
})

// Same shapes as observed model outputs where the coverage boundary landed mid-scene.
describe('looksLikeMidSceneEnding', () => {
  it('catches the three observed failure shapes', () => {
    expect(looksLikeMidSceneEnding('The beat is still settling as X moves to comfort Y.')).toBe(
      true,
    )
    expect(
      looksLikeMidSceneEnding(
        "X's response - the demand for a recount rather than a concession - is in progress.",
      ),
    ).toBe(true)
    expect(looksLikeMidSceneEnding('Her answers hang unresolved as the beat continues.')).toBe(true)
  })

  it('accepts a normal resolved ending', () => {
    expect(
      looksLikeMidSceneEnding('She agreed to the terms, and the two of them shook hands.'),
    ).toBe(false)
  })

  it('only looks at the trailing sentence(s), not earlier scene-setting prose', () => {
    const block =
      'The negotiation was still unfolding when Elena arrived. By the end, both sides signed the treaty.'
    expect(looksLikeMidSceneEnding(block)).toBe(false)
  })

  it('does not flag a standing narrative fact framed as already-resolved prose', () => {
    // Deliberately conservative: "remains unresolved" can describe a long-standing plot thread.
    expect(
      looksLikeMidSceneEnding('They shook hands and parted, their old rivalry remains unresolved.'),
    ).toBe(false)
  })
})

// The model sometimes appends a meta-note about the coverage ceiling; it must be stripped.
describe('sanitizeStoryBlockContent coverage-ended trailing sentence', () => {
  it('strips the trailing sentence verbatim', () => {
    const block =
      'Ada found the note and read it twice. The conversation was still ongoing when coverage ended.'
    expect(sanitizeStoryBlockContent(block)).toBe('Ada found the note and read it twice.')
  })

  it('only strips it from the end, not mid-block', () => {
    const block =
      'It was unclear when coverage ended for the prior scene, but Ada pressed on regardless. They reached the dock by nightfall.'
    expect(sanitizeStoryBlockContent(block)).toBe(block)
  })

  it('leaves a normal resolved ending untouched', () => {
    const block = 'She agreed to the terms, and the two of them shook hands.'
    expect(sanitizeStoryBlockContent(block)).toBe(block)
  })

  // Other observed shapes of the same meta-note.
  it('strips the other coverage-ceiling meta-note shapes', () => {
    expect(
      sanitizeStoryBlockContent('The border dispute remained unresolved when the scene closed.'),
    ).toBe('')
    expect(
      sanitizeStoryBlockContent(
        'Ada went quiet. The beat was still open — the apology unresolved, no scene-closing transition.',
      ),
    ).toBe('Ada went quiet.')
    expect(sanitizeStoryBlockContent('MOBY reached the seabed. The inspection was ongoing.')).toBe(
      'MOBY reached the seabed.',
    )
  })

  it('does not strip "the scene"/"ongoing" used as ordinary resolved narrative prose', () => {
    const endings = [
      "Dov relays the warning, then leaves them to rest, hinting at Esme's ongoing watch.",
      'The scene is set for the next round of the festival, a quiet bridge to what comes next.',
      "The ferry departs, the harbourmaster left agog at the scene he's witnessed.",
      "The scene's emotional climax is now fully articulated between them.",
    ]
    for (const block of endings) expect(sanitizeStoryBlockContent(block)).toBe(block)
  })

  // Present-tense and bare-state variants.
  it('strips present-tense "when coverage ends" and bare "remains pending"/"remains unresolved" endings', () => {
    expect(sanitizeStoryBlockContent('The question was still hanging when coverage ends.')).toBe('')
    expect(sanitizeStoryBlockContent('Fen made her case. The council vote remains pending.')).toBe(
      'Fen made her case.',
    )
    expect(
      sanitizeStoryBlockContent(
        'Ada shrugged it off. The inheritance question remains unresolved.',
      ),
    ).toBe('Ada shrugged it off.')
  })
})

// Some models omit the opening story tag but give clean prose and a closing coverage tag.
describe('extractStoryBlockMissingOpenTag', () => {
  it('repairs the observed GLM-5.2 failure shape: clean prose and coverage, no opening tag', () => {
    const raw =
      'The harbour standoff between Bram and Ada resolved into an uneasy truce. ' +
      'Ada named her price directly, and Bram paid without haggling. Corin watched ' +
      'from the rigging.\n\n[COVERAGE]38[/COVERAGE]'
    expect(extractStoryBlockMissingOpenTag(raw)).toBe(
      'The harbour standoff between Bram and Ada resolved into an uneasy truce. ' +
        'Ada named her price directly, and Bram paid without haggling. Corin watched ' +
        'from the rigging.',
    )
  })

  it('does not repair when a stray marker fragment suggests messier corruption', () => {
    const raw = 'Something happened. [STORY ENDS] but here is more.\n\n[COVERAGE]12[/COVERAGE]'
    expect(extractStoryBlockMissingOpenTag(raw)).toBeNull()
  })

  it('does not repair when there is no valid closing coverage tag', () => {
    const raw = 'Something happened, with no coverage tag anywhere in sight.'
    expect(extractStoryBlockMissingOpenTag(raw)).toBeNull()
  })

  it('does not repair an empty body before the coverage tag', () => {
    const raw = '[COVERAGE]12[/COVERAGE]'
    expect(extractStoryBlockMissingOpenTag(raw)).toBeNull()
  })
})
