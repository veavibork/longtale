const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

interface Entry {
  failures: number
  firstFailureAt: number
}

const entries = new Map<string, Entry>()

function live(key: string, now: number): Entry | null {
  const entry = entries.get(key)
  if (!entry) return null
  if (now - entry.firstFailureAt >= WINDOW_MS) {
    entries.delete(key)
    return null
  }
  return entry
}

/** After MAX_FAILURES failures inside the window, the key is locked until the window ends. */
export function checkLoginAllowed(
  key: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const entry = live(key, now)
  if (!entry || entry.failures < MAX_FAILURES) return { allowed: true }
  return {
    allowed: false,
    retryAfterSec: Math.ceil((entry.firstFailureAt + WINDOW_MS - now) / 1000),
  }
}

/** Drops expired entries, so failures for names that are never retried do not accumulate. */
function pruneExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.firstFailureAt >= WINDOW_MS) entries.delete(key)
  }
}

/** Names with failures inside the current window (for tests and diagnostics). */
export function trackedFailureKeyCount(): number {
  return entries.size
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  pruneExpired(now)
  const entry = live(key, now)
  if (entry) entry.failures++
  else entries.set(key, { failures: 1, firstFailureAt: now })
}

export function recordLoginSuccess(key: string): void {
  entries.delete(key)
}
