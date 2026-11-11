import type { AgentProfile } from '../config.js'
import type { ChatMessage } from './featherless.js'
import { HORDE_ANONYMOUS_KEY, HORDE_BASE_URL, HORDE_USER_AGENT } from './horde-config.js'

/** Carries the HTTP status, mirroring FeatherlessError — see featherless.ts. */
export class HordeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HordeError'
    this.status = status
  }
}

/** Horde returns HTTP 403 with `rc=KudosUpfront` when the user's kudos balance is too low for the requested. */
export class HordeKudosUpfrontError extends Error {
  constructor(message = 'insufficient kudos for requested max_length') {
    super(message)
    this.name = 'HordeKudosUpfrontError'
  }
}

/** Models that have hit the KudosUpfront cap — future submissions use max_length=512. */
const kudosCappedModels = new Set<string>()

/** Returns true if this model has previously hit the KudosUpfront cap. */
export function isModelKudosCapped(model: string): boolean {
  return kudosCappedModels.has(model)
}

/** `is_possible: false` is a live, continuously-recomputed flag (not a one-time submit rejection) */
export class HordeImpossibleError extends Error {
  constructor(message = 'no worker currently available for this request') {
    super(message)
    this.name = 'HordeImpossibleError'
  }
}

function headers(apiKey: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': HORDE_USER_AGENT,
    apikey: apiKey ?? HORDE_ANONYMOUS_KEY,
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

// A hung request must not be able to hold a Horde submission forever.
const DEFAULT_TIMEOUT_MS = 30_000

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new HordeError(0, `Horde request timed out after ${timeoutMs}ms`)
    }
    throw err
  }
}

/** No chat-template concept in Horde's plain-text completion API — a role-prefixed transcript join. */
function buildPrompt(messages: ChatMessage[]): string {
  const transcript = messages.map((m) => `${m.role}: ${m.content ?? ''}`).join('\n\n')
  return `${transcript}\n\nassistant:`
}

/** Omits sampler fields Horde has no equivalent for (presence/frequency penalty) rather than sending. */
function hordeParams(profile: AgentProfile): Record<string, number> {
  const params: Record<string, number> = {
    max_context_length: profile.contextLimit,
    max_length: profile.responseLimit,
    temperature: profile.temperature,
  }
  if (profile.topP !== undefined) params.top_p = profile.topP
  if (profile.topK !== undefined) params.top_k = profile.topK
  if (profile.repetitionPenalty !== undefined) params.rep_pen = profile.repetitionPenalty
  return params
}

export interface HordeSubmitResult {
  id: string
  kudos: number
}

/** Submit-then-return — Horde has no synchronous completion endpoint. */
export async function submitTextGeneration(
  profile: AgentProfile,
  apiKey: string | null,
  messages: ChatMessage[],
  options?: { maxLengthOverride?: number },
): Promise<HordeSubmitResult> {
  let params = hordeParams(profile)
  if (options?.maxLengthOverride !== undefined) {
    params = { ...params, max_length: options.maxLengthOverride }
  } else if (isModelKudosCapped(profile.model)) {
    params = { ...params, max_length: 512 }
  }

  const response = await fetchWithTimeout(`${HORDE_BASE_URL}/v2/generate/text/async`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      prompt: buildPrompt(messages),
      params,
      models: [profile.model],
    }),
  })

  if (!response.ok) {
    const body = await safeText(response)
    // Detect KudosUpfront: HTTP 403 with rc=KudosUpfront in the response body.
    if (response.status === 403 && body.includes('KudosUpfront')) {
      kudosCappedModels.add(profile.model)
      throw new HordeKudosUpfrontError(
        `insufficient kudos for ${profile.model} at max_length=${params.max_length}`,
      )
    }
    throw new HordeError(response.status, `Horde submit failed: ${response.status} ${body}`)
  }

  const data = (await response.json()) as { id: string; kudos: number }
  return { id: data.id, kudos: data.kudos }
}

export interface HordeStatus {
  done: boolean
  faulted: boolean
  isPossible: boolean
  queuePosition: number
  waitTime: number
  text: string | null
}

/** One status check per call — the caller (the queue's poll loop) owns the looping/interval. */
export async function pollTextGeneration(
  requestId: string,
  apiKey: string | null,
): Promise<HordeStatus> {
  const response = await fetchWithTimeout(
    `${HORDE_BASE_URL}/v2/generate/text/status/${requestId}`,
    {
      headers: headers(apiKey),
    },
  )

  if (!response.ok) {
    throw new HordeError(
      response.status,
      `Horde status poll failed: ${response.status} ${await safeText(response)}`,
    )
  }

  const data = (await response.json()) as {
    done: boolean
    faulted: boolean
    is_possible: boolean
    queue_position: number
    wait_time: number
    generations?: Array<{ text?: string }>
  }

  return {
    done: data.done,
    faulted: data.faulted,
    isPossible: data.is_possible,
    queuePosition: data.queue_position,
    waitTime: data.wait_time,
    text: data.generations?.[0]?.text ?? null,
  }
}

export interface HordeTextModel {
  name: string
  count: number
  queued: number
  eta: number
}

/** Available-models discovery — a model with count: 0 has no worker online right now and would resolve. */
export async function listTextModels(apiKey: string | null): Promise<HordeTextModel[]> {
  const response = await fetchWithTimeout(`${HORDE_BASE_URL}/v2/status/models?type=text`, {
    headers: headers(apiKey),
  })

  if (!response.ok) {
    throw new HordeError(
      response.status,
      `Horde model list failed: ${response.status} ${await safeText(response)}`,
    )
  }

  const data = (await response.json()) as Array<{
    name: string
    count: number
    queued: number
    eta: number
  }>
  return data.map((m) => ({ name: m.name, count: m.count, queued: m.queued, eta: m.eta }))
}
