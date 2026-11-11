import { describe, it, expect } from 'vitest'
import { optionalRetry } from '../../src/services/story-to-date/worker.js'
import { JobCancelledError } from '../../src/inference/featherless.js'

describe('optionalRetry', () => {
  it('returns the response when the call succeeds', async () => {
    expect(await optionalRetry(async () => 'ok')).toBe('ok')
  })

  it('returns null on an ordinary failure so the caller keeps its first answer', async () => {
    const result = await optionalRetry(async () => {
      throw new Error('network down')
    })
    expect(result).toBeNull()
  })

  it('rethrows a user cancel instead of swallowing it', async () => {
    await expect(
      optionalRetry(async () => {
        throw new JobCancelledError()
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
  })

  it('rethrows when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      optionalRetry(async () => {
        throw new Error('aborted')
      }, controller.signal),
    ).rejects.toThrow('aborted')
  })
})
