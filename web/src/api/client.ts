import { coordinatedFetch } from '../lib/api-limiter.js'
import type { SupersededInfo } from './types.js'

export const API_BASE = ''

export function getSessionId(): string | null {
  return localStorage.getItem('longtale.sessionId')
}

export function setSessionId(id: string): void {
  localStorage.setItem('longtale.sessionId', id)
}

export function getStoredUserName(): string | null {
  return localStorage.getItem('longtale.userName')
}

type SupersededListener = (info: SupersededInfo) => void
const supersededListeners: SupersededListener[] = []

/** App.tsx subscribes once at the top level. */
export function onSuperseded(listener: SupersededListener): () => void {
  supersededListeners.push(listener)
  return () => {
    const i = supersededListeners.indexOf(listener)
    if (i !== -1) supersededListeners.splice(i, 1)
  }
}

/** Every call in this file. */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts?: { background?: boolean },
): Promise<Response> {
  return coordinatedFetch(
    path,
    init,
    async () => {
      // Resolved here, not before queuing — coordinatedFetch may defer this call.
      const sessionId = getSessionId()
      const headers = new Headers(init.headers)
      if (sessionId) headers.set('X-Longtale-Session', sessionId)
      if (opts?.background) headers.set('X-Longtale-Interaction', 'background')

      let res: Response
      try {
        res = await fetch(`${API_BASE}${path}`, { ...init, headers })
      } catch (err) {
        console.error(`apiFetch: ${path} unreachable —`, err)
        throw err
      }
      if (res.status >= 500) {
        console.error(`apiFetch: ${path} returned ${res.status}`)
        const text = await res.text().catch(() => '')
        let message = text
        try {
          const parsed = JSON.parse(text) as { error?: string }
          if (parsed?.error) message = parsed.error
        } catch {
          // not JSON — use the raw text as-is.
        }
        throw new Error(message || `request failed (${res.status})`)
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as Partial<SupersededInfo> & {
          error?: string
        }
        if (body.error === 'unclaimed' || body.error === 'superseded' || body.error === 'expired') {
          const info: SupersededInfo = {
            reason: body.error,
            active: body.active ?? null,
            stale: body.stale ?? null,
          }
          for (const listener of supersededListeners) listener(info)
          throw new Error(`session ${info.reason}`)
        }
        throw new Error(body.error || `request failed (${res.status})`)
      }
      return res
    },
    opts,
  )
}
