/**
 * Gateway transport: one POST, one SSE stream, classified failures.
 *
 * The gateway is a hostile-ish peer for a non-first-party client:
 *  - free-lane refusals arrive as structured envelopes (`FreeTierError`,
 *    `RegionError`, quota errors) and must be surfaced honestly, never retried
 *    blindly;
 *  - error pages sometimes arrive as HTML with a 200 or behind a redirect;
 *  - successful streams are SSE even when the content-type is generic;
 *  - keep-alive comments and concatenated `data:` lines are normal.
 *
 * Two independent watchdogs bound the wait: time-to-first-event and silence
 * between events (the Responses wire is bursty, so it gets a longer budget).
 */

import type { LlmFailure } from './types.js'

export interface SseEvent {
  event: string
  data: string
}

export class GatewayFailure extends Error implements LlmFailure {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly providerRetryAfterMs?: number,
    readonly requestId?: string,
    readonly retryable = false,
    /**
     * For IMAGE_OFFLOAD_REQUIRED: how many more of the oldest retained image
     * occurrences the host must offload before the request fits. Mirrors the
     * host's own `requiredImageOffload` count semantics.
     */
    readonly offloadImages?: number,
  ) {
    super(message)
    this.name = 'GatewayFailure'
  }
}

export class StreamTimeout extends Error {
  constructor(readonly phase: 'first-event' | 'body-idle') {
    super(phase === 'first-event' ? 'Timed out waiting for the first stream event' : 'Stream went silent before finishing')
    this.name = 'StreamTimeout'
  }
}

// Internal failure vocabulary. Values mirror the host LlmError taxonomy
// (dsh-llm adapter-failure): canonical codes are reused verbatim so the
// harness UI and retry machinery understand them; the lane-specific codes
// (LANE_LOCKED, REGION_BLOCKED, HTML_INTERSTITIAL) are valid custom strings
// the host passes through via the adapter's own `failure` payload.
export const CODE = {
  LANE_LOCKED: 'LANE_LOCKED',
  REGION_BLOCKED: 'REGION_BLOCKED',
  QUOTA: 'QUOTA',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  CONTEXT_TOO_LONG: 'CONTEXT_WINDOW_EXCEEDED',
  BAD_REQUEST: 'INVALID_CONFIG',
  UNAUTHORIZED: 'INVALID_CREDENTIAL',
  UPSTREAM: 'SERVER',
  HTML_INTERSTITIAL: 'HTML_INTERSTITIAL',
  EMPTY: 'EMPTY_RESPONSE',
  STREAM_CLOSED: 'STREAM_CLOSED',
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  OFFLOAD: 'IMAGE_OFFLOAD_REQUIRED',
  UNSUPPORTED: 'UNSUPPORTED_CONTENT',
} as const

const SNIFF_BYTES = 4096

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(header)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return undefined
}

interface ErrorEnvelope {
  error?: { type?: string; message?: string; code?: string; status?: number }
  type?: string
  message?: string
}

function extractEnvelope(text: string): ErrorEnvelope | undefined {
  try {
    return JSON.parse(text) as ErrorEnvelope
  } catch {
    return undefined
  }
}

function looksHtml(text: string): boolean {
  const head = text.slice(0, 512).toLowerCase()
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('<head')
}

/**
 * Turn a non-2xx gateway answer into a typed, non-throwable-data failure.
 * `FreeTierError` and `RegionError` are final: retrying identical traffic only
 * burns quota and cannot succeed.
 */
export function classifyFailure(status: number, rawText: string, retryAfterHeader?: string | null): GatewayFailure {
  const text = rawText.slice(0, SNIFF_BYTES)
  const retryAfter = parseRetryAfter(retryAfterHeader ?? null)
  const envelope = extractEnvelope(text)
  const type = envelope?.error?.type ?? envelope?.type ?? ''
  const message = envelope?.error?.message ?? envelope?.message ?? text.slice(0, 300)
  const requestId = extractRequestId(rawText)

  if (type === 'FreeTierError' || /freetiererror/i.test(text)) {
    return new GatewayFailure(
      message || 'OpenCode free tier refused this client (FreeTierError).',
      CODE.LANE_LOCKED, status, undefined, requestId, false,
    )
  }
  if (type === 'RegionError' || /regionerror|region\s+(not\s+)?supported/i.test(text)) {
    return new GatewayFailure(
      message || 'OpenCode free tier is not available from this region.',
      CODE.REGION_BLOCKED, status, undefined, requestId, false,
    )
  }
  if (type === 'FreeUsageLimitError' || /usagelimit|rate.?limit|too many requests/i.test(text) || status === 429) {
    return new GatewayFailure(
      message || 'OpenCode free-tier usage limit reached.',
      CODE.QUOTA, status, retryAfter, requestId, false,
    )
  }
  if (status === 404 || /unknown model|model not found|does not exist/i.test(text)) {
    return new GatewayFailure(message || 'Model not found on the OpenCode gateway.', CODE.UNKNOWN_MODEL, status, undefined, requestId, false)
  }
  if (/context length|maximum context|too many tokens|context window/i.test(text)) {
    return new GatewayFailure(message || 'Prompt exceeds the model context window.', CODE.CONTEXT_TOO_LONG, status, undefined, requestId, true)
  }
  if (/image|attachment|offload/i.test(text) && /too large|offload|unsupported/i.test(text)) {
    return new GatewayFailure(message || 'Image attachment rejected by the gateway.', CODE.OFFLOAD, status, undefined, requestId, false)
  }
  if (status === 401) {
    return new GatewayFailure(message || 'Gateway rejected the anonymous credential.', CODE.UNAUTHORIZED, status, undefined, requestId, false)
  }
  if (status === 403) {
    return new GatewayFailure(message || 'Gateway refused the request.', CODE.UNAUTHORIZED, status, undefined, requestId, false)
  }
  if (status >= 500) {
    return new GatewayFailure(message || `Gateway upstream error (${status}).`, CODE.UPSTREAM, status, undefined, requestId, true)
  }
  if (looksHtml(text)) {
    return new GatewayFailure('Gateway returned an HTML page instead of an API response.', CODE.HTML_INTERSTITIAL, status, undefined, requestId, false)
  }
  return new GatewayFailure(message || `Gateway request failed (${status}).`, CODE.BAD_REQUEST, status, undefined, requestId, false)
}

function extractRequestId(text: string): string | undefined {
  const match = text.match(/"(?:request_?id|requestId)"\s*:\s*"([^"]+)"/i)
  return match?.[1]
}

export interface WatchdogConfig {
  firstEventMs: number
  bodyIdleMs: number
}

export interface OpenStream {
  events: AsyncIterable<SseEvent>
  cancel(reason?: string): void
}

/**
 * POST to the gateway and expose the answer as parsed SSE events.
 *
 * A 200 answer is sniffed rather than trusted: the gateway has answered with
 * generic content-types before, and a non-stream JSON envelope is normalized
 * into a single synthetic event so callers keep one code path.
 */
export async function openGatewayStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  watchdogs: WatchdogConfig,
): Promise<OpenStream> {
  const controller = new AbortController()
  const detachExternal = linkSignal(signal, controller)

  // Watchdog for the phase the stream generator cannot see: connect + TLS +
  // response headers. The iterator arms its own first-event timer afterwards.
  let connectTimedOut = false
  // Referenced on purpose: bounds an in-flight request whose connect phase
  // would otherwise never settle; the long-lived catalog timers are unref'd.
  const connectTimer = setTimeout(() => {
    connectTimedOut = true
    controller.abort()
  }, watchdogs.firstEventMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    clearTimeout(connectTimer)
    if (connectTimedOut) throw new StreamTimeout('first-event')
    detachExternal()
    if (signal?.aborted) throw new GatewayFailure(signal.reason?.message ?? 'Request aborted.', CODE.ABORTED, undefined, undefined, undefined, false)
    if (controller.signal.aborted) throw new StreamTimeout('first-event')
    throw new GatewayFailure(
      error instanceof Error ? error.message : 'Network error reaching the OpenCode gateway.',
      CODE.UPSTREAM, undefined, undefined, undefined, true,
    )
  }

  clearTimeout(connectTimer)

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    detachExternal()
    throw classifyFailure(response.status, text, response.headers.get('retry-after'))
  }

  const contentType = response.headers.get('content-type') ?? ''
  const isEventStream = /text\/event-stream/i.test(contentType)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const firstEventMs = watchdogs.firstEventMs
  const bodyIdleMs = watchdogs.bodyIdleMs

  async function* iterate(): AsyncGenerator<SseEvent> {
    let buffer = ''
    let sawEvent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut: StreamTimeout | undefined

    const arm = (ms: number, phase: 'first-event' | 'body-idle'): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = new StreamTimeout(phase)
        controller.abort()
      }, ms)
    }
    arm(firstEventMs, 'first-event')

    try {
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array }
        try {
          chunk = await reader.read()
        } catch (error) {
          if (timedOut) throw timedOut
          if (signal?.aborted) {
            throw new GatewayFailure(signal.reason?.message ?? 'Request aborted.', CODE.ABORTED, undefined, undefined, undefined, false)
          }
          throw new GatewayFailure(
            error instanceof Error ? error.message : 'Stream connection failed.',
            CODE.STREAM_CLOSED, undefined, undefined, undefined, true,
          )
        }
        if (timedOut) throw timedOut
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
        arm(bodyIdleMs, 'body-idle')

        // Non-stream JSON answer on a 200: normalize, then stop.
        if (!isEventStream && !sawEvent && !buffer.includes('data:') && buffer.trimStart().startsWith('{')) {
          const trimmed = buffer.trim()
          if (trimmed.endsWith('}')) {
            sawEvent = true
            yield { event: 'message', data: trimmed }
            buffer = ''
            break
          }
        }

        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseBlock(rawEvent)
          if (parsed) {
            sawEvent = true
            yield parsed
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      const tail = buffer.trim()
      if (tail) {
        const parsed = parseSseBlock(tail)
        if (parsed) yield parsed
      }
    } finally {
      if (timer) clearTimeout(timer)
      detachExternal()
      try {
        reader.releaseLock()
      } catch {
        // reader may already be released through cancel()
      }
    }
  }

  return {
    events: iterate(),
    cancel: (reason?: string) => controller.abort(reason),
  }
}

function linkSignal(external: AbortSignal | undefined, internal: AbortController): () => void {
  if (!external) return () => undefined
  if (external.aborted) {
    internal.abort(external.reason)
    return () => undefined
  }
  const onAbort = (): void => internal.abort(external.reason)
  external.addEventListener('abort', onAbort, { once: true })
  return () => external.removeEventListener('abort', onAbort)
}

/** Parse one SSE block; comments and empty blocks return undefined; [DONE] is flagged. */
export function parseSseBlock(block: string): SseEvent | undefined {
  const lines = block.split(/\r?\n/)
  let event = 'message'
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return undefined
  return { event, data: data.join('\n') }
}

export function isDoneMarker(data: string): boolean {
  return data.trim() === '[DONE]'
}

export interface FetchJsonOptions {
  signal?: AbortSignal
  /** Bounds connect + headers + body; on expiry the call throws a retryable UPSTREAM failure. */
  timeoutMs?: number
}

/** Fetch JSON (catalog listing); non-2xx answers become GatewayFailure like the chat lane. */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const controller = new AbortController()
  const detach = linkSignal(options.signal, controller)
  let timedOut = false
  // Referenced on purpose: an in-flight request must keep the process alive
  // until it settles or the deadline aborts it.
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)
    : undefined

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'opencode2dsh/0.1' },
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    if (timedOut) {
      throw new GatewayFailure(`Catalog fetch timed out after ${options.timeoutMs} ms.`, CODE.UPSTREAM, undefined, undefined, undefined, true)
    }
    if (options.signal?.aborted) {
      throw new GatewayFailure(options.signal.reason?.message ?? 'Request aborted.', CODE.ABORTED, undefined, undefined, undefined, false)
    }
    throw new GatewayFailure(
      error instanceof Error ? error.message : 'Network error reaching the OpenCode gateway.',
      CODE.UPSTREAM, undefined, undefined, undefined, true,
    )
  } finally {
    if (timer) clearTimeout(timer)
    detach()
  }

  const text = await response.text()
  if (!response.ok) throw classifyFailure(response.status, text, response.headers.get('retry-after'))
  if (looksHtml(text)) throw new GatewayFailure('Gateway returned an HTML page instead of the catalog.', CODE.HTML_INTERSTITIAL, response.status)
  return JSON.parse(text) as T
}

export interface ConditionalResult<T> {
  /** 304: the gateway confirmed the cached representation is current. */
  unchanged: boolean
  body?: T
  etag?: string
}

/**
 * Conditional GET for the catalog: sends `If-None-Match` when an ETag is
 * known. A 304 answer costs no parse/announce work and preserves the cached
 * roster; everything else behaves like {@link fetchJson}.
 */
export async function fetchJsonConditional<T>(
  url: string,
  etag: string | undefined,
  options: FetchJsonOptions = {},
): Promise<ConditionalResult<T>> {
  const controller = new AbortController()
  const detach = linkSignal(options.signal, controller)
  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)
    : undefined

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'opencode2dsh/0.1',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      signal: controller.signal,
      redirect: 'error',
    })
    if (response.status === 304) return { unchanged: true, etag: response.headers.get('etag') ?? etag ?? undefined }
    const text = await response.text()
    if (!response.ok) throw classifyFailure(response.status, text, response.headers.get('retry-after'))
    if (looksHtml(text)) throw new GatewayFailure('Gateway returned an HTML page instead of the catalog.', CODE.HTML_INTERSTITIAL, response.status)
    return { unchanged: false, body: JSON.parse(text) as T, etag: response.headers.get('etag') ?? undefined }
  } catch (error) {
    if (timedOut) {
      throw new GatewayFailure(`Catalog fetch timed out after ${options.timeoutMs} ms.`, CODE.UPSTREAM, undefined, undefined, undefined, true)
    }
    if (options.signal?.aborted) {
      throw new GatewayFailure(options.signal.reason?.message ?? 'Request aborted.', CODE.ABORTED, undefined, undefined, undefined, false)
    }
    if (error instanceof GatewayFailure) throw error
    throw new GatewayFailure(
      error instanceof Error ? error.message : 'Network error reaching the OpenCode gateway.',
      CODE.UPSTREAM, undefined, undefined, undefined, true,
    )
  } finally {
    if (timer) clearTimeout(timer)
    detach()
  }
}
