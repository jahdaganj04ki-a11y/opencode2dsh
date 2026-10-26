import assert from 'node:assert/strict'
import { test, afterEach, mock } from 'node:test'
import { OpenCodeFreeAdapter, LlmFailureError } from '../src/adapter.js'
import { CLIENT_UA } from '../src/fingerprint.js'
import type { GenerateOptions, PluginContext, StreamChunk } from '../src/types.js'

const encoder = new TextEncoder()

function sseResponse(events: string[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function chatEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const modelsEnvelope = {
  data: [
    { id: 'big-pickle' },
    { id: 'beam-free' },
    { id: 'deepseek-v4.1-flash-free' },
    { id: 'jev-1.13-free' },
    { id: 'paid-console-model' },
  ],
}

function makeContext(): PluginContext {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: { registerAdapter: () => (() => undefined) } as unknown as PluginContext['llm'],
    get: () => undefined,
    effect: () => undefined,
  }
}

function makeAdapter(): OpenCodeFreeAdapter {
  return new OpenCodeFreeAdapter({
    logger: makeContext().logger,
    ctx: makeContext(),
    config: { diskCache: false },
  })
}

const baseOptions: GenerateOptions = {
  provider: 'opencode-free',
  model: 'big-pickle',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }],
  tools: [{ name: 'lookup', description: 'find a thing', parameters: { type: 'object', properties: {} } }],
}

afterEach(() => mock.restoreAll())

test('full chat turn: v2 fingerprint headers, injected tools, indexed chunks, usage and finish', async () => {
  const posts: Array<{ url: string; init: RequestInit }> = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/models')) return jsonResponse(modelsEnvelope)
    posts.push({ url: target, init: init ?? {} })
    return sseResponse([
      chatEvent({ choices: [{ index: 0, delta: { content: 'Hello' } }] }),
      chatEvent({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
      'data: [DONE]\n\n',
    ])
  })

  const adapter = makeAdapter()
  const chunks: StreamChunk[] = []
  const stream = adapter.prepareCall(baseOptions).stream(baseOptions)
  for await (const chunk of stream) chunks.push(chunk)

  assert.equal(posts.length, 1)
  const { url, init } = posts[0]!
  assert.ok(url.endsWith('/inference/v1/chat/completions'))
  const headers = init.headers as Record<string, string>
  assert.equal(headers['user-agent'], CLIENT_UA)
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], headers['x-session-id'])
  assert.match(headers['x-opencode-session'] ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(headers['x-opencode-request'], undefined)
  assert.equal(headers['authorization'], 'Bearer public')

  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  const toolNames = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
  assert.deepEqual(toolNames.sort(), ['lookup', 'read', 'shell'])
  assert.notEqual(body.tool_choice, 'none')

  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>
  assert.deepEqual(finish.reason, { kind: 'stop' })
  const usage = chunks.find((c) => c.type === 'usage') as Extract<StreamChunk, { type: 'usage' }>
  assert.equal(usage.usage.totalTokens, 13)
})

test('FreeTierError 403 surfaces as a non-retryable LANE_LOCKED failure', async () => {
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    return jsonResponse({ error: { type: 'FreeTierError', message: 'only usable from within OpenCode' } }, 403)
  })
  const adapter = makeAdapter()
  await assert.rejects(
    async () => {
      for await (const _ of adapter.prepareCall(baseOptions).stream(baseOptions)) {
        // drain
      }
    },
    (error: unknown) => error instanceof LlmFailureError && error.code === 'LANE_LOCKED',
  )
})

test('length cut with answer text triggers exactly one tool-forbidden continuation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) {
      return sseResponse([
        chatEvent({ choices: [{ index: 0, delta: { content: 'Once upon a time' } }] }),
        chatEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        'data: [DONE]\n\n',
      ])
    }
    return sseResponse([
      chatEvent({ choices: [{ index: 0, delta: { content: ' the end.' } }] }),
      chatEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])
  })

  const adapter = makeAdapter()
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.prepareCall(baseOptions).stream(baseOptions)) chunks.push(chunk)

  assert.equal(bodies.length, 2)
  const second = bodies[1]!
  const lastMessages = second.messages as Array<{ role: string; content: unknown }>
  assert.equal(lastMessages.at(-1)?.role, 'user')
  assert.match(JSON.stringify(lastMessages.at(-1)), /Continue your previous answer/)
  const secondTools = second.tools as Array<{ function: { name: string } }>
  // Only the mandatory fingerprint tools remain on the continuation.
  assert.deepEqual(secondTools.map((t) => t.function.name).sort(), ['read', 'shell'])
  const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>
  assert.deepEqual(finish.reason, { kind: 'stop' })
  const text = chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
  assert.equal(text, 'Once upon a time the end.')
})

test('retryable 5xx on a clean first attempt is retried once and succeeds', async () => {
  const posts: string[] = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    posts.push(String(url))
    if (posts.filter((u) => u.endsWith('/chat/completions')).length === 1) {
      return jsonResponse({ error: { message: 'gateway restart' } }, 502)
    }
    return sseResponse([
      chatEvent({ choices: [{ index: 0, delta: { content: 'recovered' } }] }),
      chatEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])
  })
  const adapter = makeAdapter()
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.prepareCall(baseOptions).stream(baseOptions)) chunks.push(chunk)
  assert.equal(posts.filter((u) => u.endsWith('/chat/completions')).length, 2)
  const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('a changed live roster re-announces the adapter so the picker re-reads listModels', async () => {
  const replaceCalls: string[][] = []
  const emits: string[] = []
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: {
      registerAdapter: (providers: string[]) => {
        const handle = (() => undefined) as unknown as { (): void; replace(p: string[]): void }
        handle.replace = (p: string[]) => replaceCalls.push(p)
        return handle
      },
    } as unknown as PluginContext['llm'],
    get: () => undefined,
    effect: () => undefined,
    emit: (event: string) => emits.push(event),
  }
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'big-pickle' }, { id: 'beam-free' }, { id: 'glm-5.3-flash-free' }] })
    }
    throw new Error('unexpected call')
  })

  const { apply } = await import('../src/index.js')
  apply(ctx, { diskCache: false, warmMs: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  // One announcement at registration plus one when the live roster differs
  // from the static bootstrap list.
  assert.ok(replaceCalls.length >= 2, `expected registration + roster announcements, got ${replaceCalls.length}`)
  assert.ok(replaceCalls.every((p) => p.length === 1 && p[0] === 'opencode-free'))
  assert.equal(emits.length, 0)
})

test('resolveModel reports per-model context, output ceiling and reasoning menu', () => {
  const adapter = makeAdapter()
  const deepseek = adapter.resolveModel('deepseek-v4.1-flash-free')
  assert.equal(deepseek.context!.contextWindow, 300_000)
  assert.equal(deepseek.defaultMaxTokens, 8192)
  assert.ok(deepseek.reasoning?.efforts.some((e) => e.id === 'disabled'))
  assert.equal(deepseek.reasoning?.defaultEffort, 'high')

  const pickle = adapter.resolveModel('big-pickle')
  assert.equal(pickle.reasoning, undefined)
  assert.deepEqual(pickle.inputModalities, ['text', 'image'])

  const beam = adapter.resolveModel('beam-free')
  assert.equal(beam.context!.contextWindow, 1_048_576)
  assert.deepEqual(beam.inputModalities, ['text'])
})

test('providerInfo and listModels eligibility (free rule + blocklist + allowlist)', async () => {
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/models')) return jsonResponse(modelsEnvelope)
    throw new Error('unexpected call')
  })
  const adapter = new OpenCodeFreeAdapter({
    logger: makeContext().logger,
    ctx: makeContext(),
    config: { diskCache: false, warmMs: 2000 },
  })
  assert.deepEqual(adapter.providerInfo(), { id: 'opencode-free', name: 'OpenCode Free' })
  const models = await adapter.listModels()
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('big-pickle'))
  assert.ok(ids.includes('deepseek-v4.1-flash-free'))
  assert.ok(!ids.includes('jev-1.13-free'))
  assert.ok(!ids.includes('paid-console-model'))

  const limited = new OpenCodeFreeAdapter({
    logger: makeContext().logger,
    ctx: makeContext(),
    config: { diskCache: false, allowedModels: ['beam-free'] },
  })
  const limitedIds = (await limited.listModels()).map((m) => m.id)
  assert.deepEqual(limitedIds, ['beam-free'])
})
