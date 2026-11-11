import { describe, it, expect } from 'vitest'
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  trackedFailureKeyCount,
} from '../../src/lib/login-throttle.js'

describe('login throttle', () => {
  it('locks a key after five failures and reports the wait', () => {
    const t = 1_000_000
    for (let i = 0; i < 4; i++) recordLoginFailure('a', t)
    expect(checkLoginAllowed('a', t).allowed).toBe(true)
    recordLoginFailure('a', t)
    const gate = checkLoginAllowed('a', t + 60_000)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.retryAfterSec).toBe(14 * 60)
  })

  it('unlocks once the window has passed', () => {
    const t = 2_000_000
    for (let i = 0; i < 5; i++) recordLoginFailure('b', t)
    expect(checkLoginAllowed('b', t + 15 * 60_000).allowed).toBe(true)
  })

  it('clears the count on success and keeps keys independent', () => {
    const t = 3_000_000
    for (let i = 0; i < 4; i++) recordLoginFailure('c', t)
    recordLoginSuccess('c')
    recordLoginFailure('c', t)
    expect(checkLoginAllowed('c', t).allowed).toBe(true)
    for (let i = 0; i < 5; i++) recordLoginFailure('d', t)
    expect(checkLoginAllowed('d', t).allowed).toBe(false)
    expect(checkLoginAllowed('e', t).allowed).toBe(true)
  })

  it('forgets expired failures for names that are never tried again', () => {
    const t = 10_000_000
    for (let i = 0; i < 50; i++) recordLoginFailure(`one-off-${i}`, t)
    expect(trackedFailureKeyCount()).toBeGreaterThanOrEqual(50)
    recordLoginFailure('later', t + 15 * 60_000)
    expect(trackedFailureKeyCount()).toBe(1)
  })
})
