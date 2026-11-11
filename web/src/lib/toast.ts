import { toast as sonner } from 'sonner'
import { API_BASE, getSessionId } from '../api'

type ToastSeverity = 'info' | 'warning' | 'error' | 'critical'

/** Fire-and-forget log to the backend for later "run the numbers" analysis. */
function reportToBackend(severity: ToastSeverity, message: string): void {
  if (severity === 'info') return
  const sessionId = getSessionId()
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (sessionId) headers.set('X-Longtale-Session', sessionId)
  fetch(`${API_BASE}/api/client-errors`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      severity,
      message,
      url: location.href,
      userAgent: navigator.userAgent,
    }),
  }).catch(() => {})
}

const SEVERITY_TO_SONNER: Record<ToastSeverity, 'info' | 'warning' | 'error'> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
  critical: 'error',
}

export const toast = {
  info: (message: string, title?: string) => {
    reportToBackend('info', message)
    sonner[SEVERITY_TO_SONNER.info](message, { description: title })
  },
  warning: (message: string, title?: string) => {
    reportToBackend('warning', message)
    sonner[SEVERITY_TO_SONNER.warning](message, { description: title })
  },
  error: (message: string, title?: string) => {
    reportToBackend('error', message)
    sonner[SEVERITY_TO_SONNER.error](message, { description: title })
  },
  critical: (message: string, title?: string) => {
    reportToBackend('critical', message)
    sonner.error(message, {
      description: title,
      duration: Infinity,
      dismissible: true,
    })
  },
}
