import assert from 'node:assert/strict'
import { test, afterEach, mock } from 'node:test'
import { OpenCodeFreeAdapter, LlmFailureError } from '../src/adapter.js'
import { CODE } from '../src/http.js'
import type { GenerateOptions, PluginContext, StreamChunk } from '../src/types.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

const modelsEnvelope = { data: [{ id: 'big-pickle' }, { id: 'beam-free' }] }

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function makeContext(get?: (token: string) => unknown): PluginContext {
  return {
    logger: silentLogger,
    llm: { registerAdapter: () => (() => undefined) } as unknown as PluginContext['llm'],
    get: get ?? (() => undefined),
    effect: () => undefined,
  }
}

afterEach(() => mock.restoreAll())

test('prepareCall matches the host LlmAdapter signature: (provider, model, signal) → { model, stream }', async () => {
  mock.method(globalThis, 'fetch', async (url: unknown) =>
    String(url).endsWith('/models') ? jsonResponse(modelsEnvelope) : jsonResponse({ error: 'no' }, 500),
  )
  const adapter = new OpenCodeFreeAdapter({ logger: silentLogger, ctx: makeContext(), config: { diskCache: false } })
  const prepared = await adapter.prepareCall('opencode-free', 'deepseek-v4.1-flash-free', undefined)

  assert.equal(prepared.model.provider, 'opencode-free')
  assert.equal(prepared.model.id, 'deepseek-v4.1-flash-free')
  assert.equal(prepared.model.context!.contextWindow, 300_000)
  assert.equal(typeof prepared.stream, 'function')

  // Host also calls the metadata methods with the provider route first.
  assert.equal(adapter.providerInfo('opencode-free').id, 'opencode-free')
  const resolved = adapter.resolveModel('opencode-free', 'big-pickle')
  assert.equal(resolved.id, 'big-pickle')
  const models = await adapter.listModels('opencode-free')
  assert.ok(models.every((m) => m.provider === 'opencode-free'))
})

test('LlmFailureError carries the own `failure` payload the host normalizer preserves', () => {
  const error = new LlmFailureError('rate limited', CODE.QUOTA, 429, 120_000, 'req-1')
  // Mirror of the host validation in normalizeLlmFailure/failureSnapshot.
  assert.equal(typeof error.failure.message, 'string')
  assert.equal(error.failure.code, 'QUOTA')
  assert.equal(error.failure.status, 429)
  assert.equal(error.failure.providerRetryAfterMs, 120_000)
  assert.equal(error.failure.requestId, 'req-1')
  assert.equal(error.code, error.failure.code)
  // Own data descriptor, not an accessor — exactly what the host reads.
  const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
  assert.ok(descriptor && 'value' in descriptor)
  Object.freeze(error.failure) // host freezes; must already be immutable
  assert.ok(Object.isFrozen(error.failure))

  const offload = new LlmFailureError('too many images', CODE.OFFLOAD, 413, undefined, undefined, 2)
  assert.equal(offload.failure.offloadImages, 2)
})

test('images load through the attachments service readImageRequest tier', async () => {
  const readImageRequest = mock.fn(async () => ({
    data: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'image/webp',
  }))
  const ctx = makeContext((token: string) => {
    if (token === 'attachments') return { readImageRequest, imageHostPath: () => '/should/not/be/used' }
    if (token === 'fs') return { processPathFromHostPath: (p: string) => p }
    return undefined
  })
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> }
    const userMessage = body.messages.find((m) => m.role === 'user') as { content: Array<{ image_url?: { url: string } }> }
    const part = userMessage?.content[0]
    assert.match(part?.image_url?.url ?? '', /^data:image\/webp;base64,/)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })

  const adapter = new OpenCodeFreeAdapter({ logger: silentLogger, ctx, config: { diskCache: false } })
  const options: GenerateOptions = {
    provider: 'opencode-free',
    model: 'big-pickle',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'sha-1', mediaType: 'image/webp', bytes: 4, width: 1, height: 1 } }],
      },
    ],
  }
  const prepared = await adapter.prepareCall('opencode-free', 'big-pickle')
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  assert.equal(readImageRequest.mock.callCount(), 1)
  assert.ok(chunks.some((c) => c.type === 'finish'))
})

test('imageHostPath + fs mapping is used when readImageRequest is unavailable', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tier2-'))
  const file = join(dir, 'img.png')
  writeFileSync(file, Buffer.from([9, 8, 7]))

  const imageHostPath = mock.fn(() => '/host/path/img.png')
  const processPath = mock.fn((hostPath: string) => (hostPath === '/host/path/img.png' ? file : hostPath))
  const ctx = makeContext((token: string) => {
    if (token === 'attachments') return { imageHostPath } // no readImageRequest
    if (token === 'fs') return { processPathFromHostPath: processPath }
    return undefined
  })
  let capturedBody: Record<string, unknown> = {}
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })

  const adapter = new OpenCodeFreeAdapter({ logger: silentLogger, ctx, config: { diskCache: false } })
  const options: GenerateOptions = {
    provider: 'opencode-free',
    model: 'big-pickle',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha-2', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] },
    ],
  }
  for await (const _ of (await adapter.prepareCall('opencode-free', 'big-pickle')).stream(options)) void _
  assert.equal(imageHostPath.mock.callCount(), 1)
  assert.equal(processPath.mock.callCount(), 1)
  const userMessage = (capturedBody.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user') as
    | { content: Array<{ image_url?: { url: string } }> }
    | undefined
  const part = userMessage?.content[0]
  assert.match(part?.image_url?.url ?? '', /^data:image\/png;base64,/)
})

test('closing the iterator early aborts the in-flight gateway request', async () => {
  let observedSignal: AbortSignal | undefined
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    observedSignal = init?.signal ?? undefined
    const stream = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })

  const adapter = new OpenCodeFreeAdapter({
    logger: silentLogger,
    ctx: makeContext(),
    config: { diskCache: false, firstEventMs: 60_000 },
  })
  const options: GenerateOptions = {
    provider: 'opencode-free',
    model: 'big-pickle',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const iterator = (await adapter.prepareCall('opencode-free', 'big-pickle')).stream(options)[Symbol.asyncIterator]()
  // Start consumption without waiting for an event the mock never emits, then
  // close the iterator the way the host runtime does on early cancellation.
  const pending = iterator.next()
  pending.catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await iterator.return?.()
  // The internal controller must have torn down the upstream fetch.
  assert.ok(observedSignal)
  assert.equal(observedSignal?.aborted, true)
})

test('resolveModel echoes the exact model id even when a display suffix is present', async () => {
  mock.method(globalThis, 'fetch', async (url: unknown) =>
    String(url).endsWith('/models') ? jsonResponse(modelsEnvelope) : jsonResponse({ error: 'no' }, 500),
  )
  const adapter = new OpenCodeFreeAdapter({ logger: silentLogger, ctx: makeContext(), config: { diskCache: false } })

  const plain = adapter.resolveModel('opencode-free', 'big-pickle')
  assert.equal(plain.id, 'big-pickle')
  assert.equal(plain.provider, 'opencode-free')

  // Host normalizeModelInfo rejects anything where resolved.id !== model.
  const suffixed = adapter.resolveModel('opencode-free', 'big-pickle (Fast)')
  assert.equal(suffixed.id, 'big-pickle (Fast)')
  assert.equal(typeof suffixed.name, 'string')
  assert.ok(suffixed.name.length > 0)
  assert.ok(suffixed.context!.contextWindow > 0)

  // prepareCall must expose the same verbatim identity on its model binding.
  const prepared = await adapter.prepareCall('opencode-free', 'big-pickle (Fast)', undefined)
  assert.equal(prepared.model.id, 'big-pickle (Fast)')
})
