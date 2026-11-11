import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../db/data-paths.js'
import type { ChatMessage } from './featherless.js'

/** Append-only JSON-lines log for inference calls + structured logging. */
const logPath = () => path.join(dataDir(), 'outbound-requests.log')
const MAX_ENTRIES = 50
const MAX_LOG_BYTES = 512 * 1024

// -- Types --

interface OutboundLogEntry {
  at: string
  call: 'streamInference' | 'completeChat'
  model: string
  messages: ChatMessage[]
  /** Response metadata — written after the call completes. */
  response?: OutboundResponse
}

export interface OutboundResponse {
  success: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  retries: number
  error?: string
}

export interface LogContext {
  storyId?: string
  jobId?: string
  jobType?: string
}

interface LogEntry {
  at: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  context: LogContext
  detail?: unknown
}

type LogLine = OutboundLogEntry | LogEntry

// -- File I/O --

function appendLine(obj: LogLine): void {
  try {
    const line = JSON.stringify(obj)
    if (!existsSync(logPath())) writeFileSync(logPath(), '')
    appendFileSync(logPath(), line + '\n')
    const size = statSync(logPath()).size
    if (size > MAX_LOG_BYTES) trimLogFile()
  } catch {
    // Best-effort — never break the caller.
  }
}

function trimLogFile(): void {
  const lines = readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean)
  const trimmed = lines.slice(-MAX_ENTRIES)
  writeFileSync(logPath(), trimmed.join('\n') + (trimmed.length ? '\n' : ''))
}

// -- Public API --

export function logOutboundRequest(entry: Omit<OutboundLogEntry, 'at'>): void {
  appendLine({ at: new Date().toISOString(), ...entry })
}

export function logOutboundResponse(
  call: OutboundLogEntry['call'],
  model: string,
  response: OutboundResponse,
): void {
  appendLine({ at: new Date().toISOString(), call, model, messages: [], response })
}

/** Context-aware logger — every line auto-stamps storyId/jobId/jobType. */
export function createLogger(context: LogContext = {}) {
  return {
    info(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'info', message, context, detail })
    },
    warn(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'warn', message, context, detail })
    },
    error(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'error', message, context, detail })
    },
    debug(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'debug', message, context, detail })
    },
    child(extra: LogContext) {
      return createLogger({ ...context, ...extra })
    },
  }
}
