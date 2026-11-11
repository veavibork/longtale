import { API_BASE, setSessionId } from './client.js'

/** Deliberately raw fetch, not apiFetch — this route is guard-exempt server-side (src/routes/sessions.ts) */
export async function claimSession(
  displayName: string,
  password: string,
): Promise<{ sessionId: string; claimedAt: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, password }),
  })
  const data = (await res.json()) as {
    sessionId?: string
    claimedAt?: string
    displayName?: string
    error?: string
  }
  if (!data.sessionId) throw new Error(data.error ?? 'claim failed')
  setSessionId(data.sessionId)
  localStorage.setItem('longtale.userName', data.displayName ?? displayName)
  return { sessionId: data.sessionId, claimedAt: data.claimedAt! }
}

export { getSessionId, setSessionId, getStoredUserName, onSuperseded } from './client.js'
export type { SupersededInfo, SupersededReason } from './types.js'
