/** Rate limiter for Horde API submissions. */

/** Minimum spacing between Horde submit calls (ms). */
const MIN_SUBMIT_SPACING_MS = 1100
/** Max submissions per 1-second window. */
const MAX_SUBMITS_PER_SECOND = 2

const recentSubmits: number[] = []
let lastSubmitAt = 0

/** Returns true if a new Horde submission is allowed right now (rate-limit check). */
export function canSubmitHorde(): boolean {
  const now = Date.now()
  // Enforce minimum spacing between submits.
  if (now - lastSubmitAt < MIN_SUBMIT_SPACING_MS) return false
  // Prune entries older than 1 second.
  while (recentSubmits.length && recentSubmits[0]! < now - 1000) {
    recentSubmits.shift()
  }
  if (recentSubmits.length >= MAX_SUBMITS_PER_SECOND) return false
  return true
}

/** Records that a submission was made — call right after canSubmitHorde() returns true. */
export function recordHordeSubmit(): void {
  const now = Date.now()
  recentSubmits.push(now)
  lastSubmitAt = now
}
