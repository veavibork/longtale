import type Database from 'better-sqlite3'
import { completeChatWithMeta } from '../../inference/featherless.js'
import { createLogger } from '../../inference/outbound-telemetry.js'

import {
  listStoryToDateSegments,
  getStoryToDateSegment,
  createStoryToDateSegment,
  fillStoryToDateSegment,
  deleteStoryToDateSegment,
} from '../../db/story-to-date-store.js'
import { getAgentProfile } from '../agent-config.js'
import {
  buildFoldSystem,
  selectFoldSet,
  selectFoldBatch,
  selectFoldTierShrinkSet,
  estimateTokens,
  foldCeilingTokens,
  foldDigestTargetWords,
  foldWordCount,
  looksFoldDigestTruncated,
  type FoldableSegment,
} from './engine.js'

/** Large merged segments can legitimately take several minutes — still bounded. */
export const EDITOR_CALL_TIMEOUT_MS = 10 * 60_000

/** Folding keeps total STORY TO DATE memory bounded however long a story runs. */
export async function executeStoryToDateFoldJob(
  db: Database.Database,
  userId: string,
  logbookId: string,
  targetSegmentId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const rows = listStoryToDateSegments(db, logbookId).filter((s) => s.content?.trim() && !s.broken)
  const segments: FoldableSegment[] = rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    content: s.content!.trim(),
    coverageThroughIcPost: s.coverageThroughIcPost,
    coveragePageId: s.coveragePageId,
    seq: s.seq,
  }))

  const editor = getAgentProfile(userId, 'editor')

  const { fold: eligible } = selectFoldSet(segments)
  const appendCandidates = eligible.filter((s) => s.kind !== 'fold')
  let batch = selectFoldBatch(appendCandidates, editor.responseLimit)
  if (!batch.length) {
    batch = selectFoldBatch(selectFoldTierShrinkSet(segments), editor.responseLimit)
  }

  // Deterministic recheck — state may have shifted since enqueue.
  if (!batch.length || batch[0]!.id !== targetSegmentId) return // no-op: nothing worth folding

  const last = batch[batch.length - 1]!
  const { coverageThroughIcPost, coveragePageId } = last
  if (coverageThroughIcPost == null || !coveragePageId) return // can't set digest coverage

  const merged = batch.map((s) => s.content).join('\n\n')
  const foldTokens = estimateTokens(merged)
  const targetWords = foldDigestTargetWords(foldWordCount(merged), editor.responseLimit)
  const messages = [
    { role: 'system' as const, content: buildFoldSystem(targetWords) },
    { role: 'user' as const, content: `Older memory to condense (chronological):\n\n${merged}` },
  ]

  // Tied to the instructed target (not the flat model ceiling) so the target is actually enforced.
  const maxTokens = foldCeilingTokens(targetWords, editor.responseLimit)
  const { content, finishReason } = await completeChatWithMeta(editor, apiKey, messages, {
    maxTokens,
    timeoutMs: EDITOR_CALL_TIMEOUT_MS,
    signal,
  })
  const digest = content.trim()
  if (!digest) throw new Error('fold produced empty digest')
  const foldLog = createLogger({ jobType: 'story-to-date-fold' })
  const foldLogDetail = {
    targetSegmentId,
    batchIds: batch.map((s) => s.id),
    batchSeqs: batch.map((s) => s.seq),
    model: editor.model,
    finishReason,
    targetWords,
    maxTokensSent: maxTokens,
    mergedInputTokens: foldTokens,
    digestEstimatedTokens: estimateTokens(digest),
    digestPreview: digest.slice(0, 1500),
  }
  // finish_reason is ground truth for a max_tokens cutoff.
  if (finishReason === 'length') {
    foldLog.warn('fold digest truncated at Editor max_tokens', foldLogDetail)
    throw new Error(`fold digest truncated at Editor max_tokens (${maxTokens}) — refusing to apply`)
  }
  if (finishReason === null && looksFoldDigestTruncated(digest, maxTokens)) {
    foldLog.warn('fold digest likely truncated at Editor max_tokens', foldLogDetail)
    throw new Error(
      `fold digest likely truncated at Editor max_tokens (${maxTokens}) — refusing to apply`,
    )
  }
  // Guard against a non-compressing result — if the model returned something as large as the input.
  if (estimateTokens(digest) >= foldTokens) {
    foldLog.warn(
      'fold digest did not shrink relative to input — leaving segments unchanged',
      foldLogDetail,
    )
    return
  }

  // Late safety check — the LLM call can take several minutes.
  for (const seg of batch) {
    const row = getStoryToDateSegment(db, seg.id)
    if (!row || row.broken) return
  }

  // One transaction: a crash between the deletes and the new row must not lose this memory.
  db.transaction(() => {
    for (const seg of batch) deleteStoryToDateSegment(db, seg.id)
    // The new fold row takes the oldest folded segment's seq.
    const newSegment = createStoryToDateSegment(db, {
      bookId: logbookId,
      kind: 'fold',
      seq: batch[0]!.seq,
    })
    fillStoryToDateSegment(db, newSegment.id, {
      content: digest,
      coverageThroughIcPost,
      coveragePageId,
      inputCeilingIcPost: coverageThroughIcPost,
      inputCeilingPageId: coveragePageId,
    })
  })()
}
