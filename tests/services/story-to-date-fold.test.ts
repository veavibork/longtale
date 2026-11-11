/** Fold digest sizing invariants. */
import { describe, it, expect } from 'vitest'
import {
  foldCeilingTokens,
  foldDigestTargetWords,
  looksFoldDigestTruncated,
  selectFoldBatch,
  selectFoldSet,
  selectFoldTierShrinkSet,
  estimateTokens,
  CHARS_PER_TOKEN_ESTIMATE,
  FOLD_CEILING_MULTIPLIER,
  FOLD_KEEP_RECENT_TOKENS,
  FOLD_MAX_OUTPUT_TOKEN_RATIO,
  FOLD_PROSE_CHARS_PER_WORD,
  type FoldableSegment,
  type SegmentKind,
} from '../../src/services/story-to-date/engine.js'

const RESPONSE_LIMITS = [1024, 2048, 4096, 8192]

/** Synthetic prose of exactly `words` words at `charsPerWord` chars each (incl. trailing space). */
function proseOfWords(words: number, charsPerWord = FOLD_PROSE_CHARS_PER_WORD): string {
  return ('x'.repeat(charsPerWord - 1) + ' ').repeat(words).trim()
}

describe('fold digest sizing', () => {
  it.each(RESPONSE_LIMITS)(
    'a digest written exactly at the instructed target is not flagged truncated (limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      expect(looksFoldDigestTruncated(proseOfWords(targetWords), limit)).toBe(false)
    },
  )

  it.each(RESPONSE_LIMITS)(
    'tolerates wordier-than-average prose at target length (7 chars/word, limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      expect(looksFoldDigestTruncated(proseOfWords(targetWords, 7), limit)).toBe(false)
    },
  )

  it.each(RESPONSE_LIMITS)(
    'instructed target estimates below the backstop rejection line (limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      const targetEstTokens = estimateTokens(proseOfWords(targetWords))
      expect(targetEstTokens).toBeLessThan(Math.floor(limit * FOLD_MAX_OUTPUT_TOKEN_RATIO))
    },
  )

  it.each(RESPONSE_LIMITS)(
    'still flags a digest that actually ran to max_tokens (limit=%d)',
    (limit) => {
      // A real cutoff at max_tokens: ~limit real tokens of prose ≈ limit × 4 chars.
      const nearCapWords = Math.floor((limit * 4) / FOLD_PROSE_CHARS_PER_WORD)
      expect(looksFoldDigestTruncated(proseOfWords(nearCapWords), limit)).toBe(true)
    },
  )

  it('small inputs floor at 200; larger inputs target 20% of their word count', () => {
    expect(foldDigestTargetWords(300, 4096)).toBe(200)
    expect(foldDigestTargetWords(1000, 4096)).toBe(200) // 1000*0.2=200, floor and ratio agree here
    expect(foldDigestTargetWords(3000, 4096)).toBe(600) // 3000*0.2=600, ratio binds
  })

  const seg = (id: string, words: number, kind: SegmentKind = 'continues'): FoldableSegment => ({
    id,
    kind,
    content: proseOfWords(words),
    coverageThroughIcPost: 1,
    coveragePageId: 'p1',
    seq: 0,
  })

  it('selectFoldBatch packs segments until the target would exceed one Editor call', () => {
    const batch = selectFoldBatch(
      Array.from({ length: 25 }, (_, i) => seg(`s${i}`, 500)),
      4096,
    )
    // maxTargetWords ≈ 1911 → at ratio 0.2, 19 × 500-word segments (target 1900) fit.
    expect(batch.map((s) => s.id)).toEqual(Array.from({ length: 19 }, (_, i) => `s${i}`))
  })

  it('whatever batch is selected, the instructed target still fits one response', () => {
    const maxTargetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, 4096)
    for (const batch of [
      selectFoldBatch(
        Array.from({ length: 8 }, (_, i) => seg(`s${i}`, 500)),
        4096,
      ),
      selectFoldBatch([seg('a', 3000), seg('b', 3000)], 4096),
    ]) {
      const mergedWords = batch.reduce((n, s) => n + s.content.split(/\s+/).length, 0)
      expect(foldDigestTargetWords(mergedWords, 4096)).toBeLessThanOrEqual(maxTargetWords)
    }
  })

  // A second oversized segment must not be forced into the batch.
  it("doesn't force a second oversized segment into the batch", () => {
    // 5000+5000 words at ratio 0.2 -> target 2000, over maxTargetWords (1911)
    const batch = selectFoldBatch([seg('a', 5000), seg('b', 5000)], 4096)
    expect(batch.map((s) => s.id)).toEqual(['a'])
  })

  // The same old `< 2` fallback also rejected a fold set of exactly 1 segment outright.
  it('folds a lone oversized segment on its own instead of refusing to act', () => {
    const lone = seg('deep-past', 3000)
    const recent = seg('recent', 100)
    const { fold } = selectFoldSet([lone, { ...recent, seq: 1 }])
    expect(fold.map((s) => s.id)).toEqual(['deep-past'])

    const batch = selectFoldBatch(fold, 4096)
    expect(batch.map((s) => s.id)).toEqual(['deep-past'])
  })
})

// Folding must not re-merge an existing deep-past fold with new material.
describe('fold tier: append vs. shrink split', () => {
  const seg = (id: string, words: number, kind: SegmentKind, seq: number): FoldableSegment => ({
    id,
    kind,
    content: proseOfWords(words),
    coverageThroughIcPost: seq + 1,
    coveragePageId: `p${seq}`,
    seq,
  })

  // tokens ≈ words * FOLD_PROSE_CHARS_PER_WORD / CHARS_PER_TOKEN_ESTIMATE for proseOfWords' default char.
  const wordsForTokens = (tokens: number): number =>
    Math.round((tokens * CHARS_PER_TOKEN_ESTIMATE) / FOLD_PROSE_CHARS_PER_WORD)

  it('selectFoldTierShrinkSet is empty when no fold row exists yet', () => {
    const segments = [seg('c0', 100, 'continues', 0), seg('c1', 100, 'continues', 1)]
    expect(selectFoldTierShrinkSet(segments)).toEqual([])
  })

  it('selectFoldTierShrinkSet is empty while the fold tier is under the recent-tier threshold', () => {
    const segments = [
      seg('fold0', wordsForTokens(FOLD_KEEP_RECENT_TOKENS - 200), 'fold', 0),
      seg('c1', 100, 'continues', 1),
    ]
    expect(selectFoldTierShrinkSet(segments)).toEqual([])
  })

  it('selectFoldTierShrinkSet returns fold rows, oldest first, once their total crosses threshold', () => {
    const segments = [
      seg('fold1', wordsForTokens(200), 'fold', 5),
      seg('fold0', wordsForTokens(FOLD_KEEP_RECENT_TOKENS + 200), 'fold', 0),
      seg('c2', 100, 'continues', 10),
    ]
    expect(selectFoldTierShrinkSet(segments).map((s) => s.id)).toEqual(['fold0', 'fold1'])
  })

  it('an existing fold row is never merged into a case-1 append batch alongside new material', () => {
    // Mirrors fold-worker.ts/index.ts's actual filtering: selectFoldSet finds everything outside the recent.
    const segments = [
      seg('fold0', wordsForTokens(3000), 'fold', 0),
      seg('c29', 400, 'continues', 29),
      seg('c30', wordsForTokens(FOLD_KEEP_RECENT_TOKENS + 200), 'continues', 30),
      seg('recent', 100, 'continues', 31),
    ]
    const { fold: eligible, keep } = selectFoldSet(segments)
    expect(eligible.map((s) => s.id)).toEqual(['fold0', 'c29', 'c30'])
    expect(keep.map((s) => s.id)).toEqual(['recent'])

    const appendCandidates = eligible.filter((s) => s.kind !== 'fold')
    expect(appendCandidates.map((s) => s.id)).toEqual(['c29', 'c30'])

    const batch = selectFoldBatch(appendCandidates, 4096)
    expect(batch.some((s) => s.kind === 'fold')).toBe(false)
  })
})

// The ceiling must derive from the target, not the flat response limit.
describe('foldCeilingTokens', () => {
  it('computes a ceiling from the target, not the flat responseLimit', () => {
    const targetWords = 200
    const targetTokens = Math.ceil(
      (targetWords * FOLD_PROSE_CHARS_PER_WORD) / CHARS_PER_TOKEN_ESTIMATE,
    )
    const ceiling = foldCeilingTokens(targetWords, 4096)
    expect(ceiling).toBe(Math.ceil(targetTokens * FOLD_CEILING_MULTIPLIER))
    expect(ceiling).toBeLessThan(4096) // meaningfully tighter than the full model ceiling
  })

  it('never exceeds the model responseLimit even for a very large target', () => {
    expect(foldCeilingTokens(100_000, 4096)).toBe(4096)
  })

  it('gives a compliant response real headroom above the bare target', () => {
    // FOLD_CEILING_MULTIPLIER should leave room for a response that lands somewhat over target without getting.
    const targetWords = 500
    const targetTokens = Math.ceil(
      (targetWords * FOLD_PROSE_CHARS_PER_WORD) / CHARS_PER_TOKEN_ESTIMATE,
    )
    const ceiling = foldCeilingTokens(targetWords, 4096)
    expect(ceiling).toBeGreaterThan(targetTokens)
  })
})
