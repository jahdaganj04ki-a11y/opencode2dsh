import assert from 'node:assert/strict'
import { test, afterEach, mock } from 'node:test'
import { CODE, GatewayFailure, StreamTimeout, fetchJson, openGatewayStream } from '../src/http.js'

const encoder = new TextEncoder()

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => mock.restoreAll())

test('openGatewayStream parses CRLF-delimited, concatenated SSE events', async () => {
  mock.method(globalThis, 'fetch', async () =>
    sseResponse([
      `event: update\r\ndata: {"a":1}\r\n\r\n`,
      `: keep-alive\r\n\r\n`,
      `data: {"b":2}\r\ndata: {"c":3}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ]),
  )
  const open = await openGatewayStream('https://example.invalid/inference/v1/chat/completions', {}, { stream: true }, undefined, {
    firstEventMs: 5000,
    bodyIdleMs: 5000,
  })
  const events: string[] = []
  for await (const event of open.events) events.push(event.data)
  assert.deepEqual(events, ['{"a":1}', '{"b":2}\n{"c":3}', '[DONE]'])
})

test('first-event watchdog fires with a StreamTimeout when nothing arrives', async () => {
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const stream = new ReadableStream({
      start(controller) {
        // Mirror production: aborting the fetch signal tears the body stream.
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
      cancel() {},
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })
  const open = await openGatewayStream('https://example.invalid/x', {}, {}, undefined, {
    firstEventMs: 40,
    bodyIdleMs: 5000,
  })
  await assert.rejects(
    async () => {
      for await (const _ of open.events) void _
    },
    (error: unknown) => error instanceof StreamTimeout && error.phase === 'first-event',
  )
})

test('FreeTierError non-2xx answer becomes a final LANE_LOCKED failure', async () => {
  mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { type: 'FreeTierError', message: 'nope' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  )
  await assert.rejects(
    openGatewayStream('https://example.invalid/x', {}, {}, undefined, { firstEventMs: 1000, bodyIdleMs: 1000 }),
    (error: unknown) => error instanceof GatewayFailure && error.code === CODE.LANE_LOCKED && error.retryable === false,
  )
})

function hangingFetch(): (url: unknown, init?: RequestInit) => Promise<Response> {
  // Mirror undici: aborting the signal rejects the in-flight fetch.
  return (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
        { once: true },
      )
    })
}

test('fetchJson enforces its own timeout on a hanging listing fetch', async () => {
  mock.method(globalThis, 'fetch', hangingFetch())
  await assert.rejects(
    fetchJson('https://example.invalid/models', { timeoutMs: 30 }),
    (error: unknown) => error instanceof GatewayFailure && error.code === CODE.UPSTREAM && error.retryable === true,
  )
})

test('the pre-response watchdog turns a hanging connect into StreamTimeout', async () => {
  mock.method(globalThis, 'fetch', hangingFetch())
  await assert.rejects(
    openGatewayStream('https://example.invalid/x', {}, {}, undefined, { firstEventMs: 30, bodyIdleMs: 5000 }),
    (error: unknown) => error instanceof StreamTimeout && error.phase === 'first-event',
  )
})

test('external abort signal surfaces as ABORTED', async () => {
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const stream = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })
  const controller = new AbortController()
  const open = await openGatewayStream('https://example.invalid/x', {}, {}, controller.signal, {
    firstEventMs: 5000,
    bodyIdleMs: 5000,
  })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    async () => {
      for await (const _ of open.events) void _
    },
    (error: unknown) => error instanceof GatewayFailure && error.code === CODE.ABORTED,
  )
})
