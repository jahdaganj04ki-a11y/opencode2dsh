import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, test } from 'node:test'
import { BRIDGE_PREFIX, mountCatalogBridge, type CatalogBridgeHandlers } from '../src/bridge.js'
import type { CatalogSnapshot } from '../src/catalog.js'
import type {
  BridgeHttpRequest,
  BridgeHttpResponse,
  WebServerRoute,
  WebServerService,
} from '../src/types.js'

/** Minimal webServer stand-in: exact-path route table + node:http dispatch. */
class FakeWebServer implements WebServerService {
  readonly routes = new Map<string, WebServerRoute['handler']>()

  register(route: WebServerRoute): () => void {
    this.routes.set(route.path, route.handler)
    return () => {
      this.routes.delete(route.path)
    }
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = this.routes.get(pathname)
    if (!handler) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    await handler(req as BridgeHttpRequest, res as BridgeHttpResponse)
  }
}

interface Harness {
  base: string
  web: FakeWebServer
  server: ReturnType<typeof createServer>
  refreshCalls: number
  failNext: boolean
  throwNext: boolean
  snapshot: CatalogSnapshot
  disposers: Array<() => void>
}

const snapshot: CatalogSnapshot = {
  state: 'ready',
  live: true,
  total: 10,
  eligible: ['big-pickle', 'beam-free', 'deepseek-v4.1-flash-free'],
  lastFetchAt: 1_700_000_000_000,
}

async function startHarness(): Promise<Harness> {
  const web = new FakeWebServer()
  const harness: Harness = {
    base: '',
    web,
    server: undefined as unknown as ReturnType<typeof createServer>,
    refreshCalls: 0,
    failNext: false,
    throwNext: false,
    snapshot,
    disposers: [],
  }
  const handlers: CatalogBridgeHandlers = {
    async refresh() {
      harness.refreshCalls += 1
      if (harness.throwNext) throw new Error('bridge exploded')
      if (harness.failNext) {
        return { ok: false, code: 'refresh-failed', message: 'gateway said no', snapshot: harness.snapshot }
      }
      return { ok: true, value: { ...harness.snapshot, refreshedAt: 1_700_000_000_999 } }
    },
    snapshot: () => harness.snapshot,
  }
  harness.disposers = mountCatalogBridge(web, handlers)
  harness.server = createServer((req, res) => {
    web.dispatch(req, res).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error instanceof Error ? error.message : error))
    })
  })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (!address || typeof address === 'string') throw new Error('ephemeral port unavailable')
  harness.base = `http://127.0.0.1:${address.port}`
  return harness
}

interface CallResult {
  status: number
  body: any
}

function call(harness: Harness, method: string, path: string, options: {
  headers?: Record<string, string>
  body?: string
} = {}): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(harness.base + path, { method, headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: res.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) })
        } catch {
          resolve({ status: res.statusCode ?? 0, body: text })
        }
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await new Promise<void>((resolve) => harness.server.close(() => resolve()))
})

test('GET /status answers the catalog snapshot for trusted loopback requests', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  const result = await call(harness, 'GET', `${BRIDGE_PREFIX}/status`)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual(result.body.value.eligible, snapshot.eligible)
  assert.equal(result.body.value.live, true)
  assert.equal(typeof result.body.value.at, 'number')
  assert.equal(harness.refreshCalls, 0)
})

test('POST /refresh forces a refresh and reports the refreshed roster', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  const result = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.value.refreshedAt, 1_700_000_000_999)
  assert.deepEqual(result.body.value.eligible, snapshot.eligible)
  assert.equal(harness.refreshCalls, 1)
})

test('refresh failure stays HTTP 200 with an honest envelope and the old roster', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  harness.failNext = true
  const result = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'refresh-failed')
  assert.equal(result.body.message, 'gateway said no')
  assert.deepEqual(result.body.snapshot.eligible, snapshot.eligible)
})

test('a throwing handler becomes a 500 envelope, not a dropped connection', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  harness.throwNext = true
  const result = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`)
  assert.equal(result.status, 500)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'internal')
  assert.match(result.body.message, /bridge exploded/)
})

test('trust guard rejects a non-loopback Host header even over a loopback socket', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  const result = await call(harness, 'GET', `${BRIDGE_PREFIX}/status`, {
    headers: { Host: 'evil.example' },
  })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'forbidden')
})

test('trust guard rejects cross-site markers and foreign origins', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  const crossSite = await call(harness, 'GET', `${BRIDGE_PREFIX}/status`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)

  const foreignOrigin = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`, {
    headers: { origin: 'http://evil.example:9000' },
  })
  assert.equal(foreignOrigin.status, 403)

  // A same-origin origin header must pass the same check.
  const url = new URL(harness.base)
  const sameOrigin = await call(harness, 'GET', `${BRIDGE_PREFIX}/status`, {
    headers: { origin: url.origin },
  })
  assert.equal(sameOrigin.status, 200)
})

test('wrong methods are answered with 405, unknown routes with 404', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  assert.equal((await call(harness, 'POST', `${BRIDGE_PREFIX}/status`)).status, 405)
  assert.equal((await call(harness, 'GET', `${BRIDGE_PREFIX}/refresh`)).status, 405)
  assert.equal((await call(harness, 'GET', `${BRIDGE_PREFIX}/nope`)).status, 404)
})

test('refresh bodies are capped at 16 KiB and must be valid JSON', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  const oversized = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }),
  })
  assert.equal(oversized.status, 400)
  assert.equal(oversized.body.code, 'bad-request')

  const malformed = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`, {
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  })
  assert.equal(malformed.status, 400)

  const withBody = await call(harness, 'POST', `${BRIDGE_PREFIX}/refresh`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(withBody.status, 200)
})

test('the returned disposers actually unmount the routes', async () => {
  const harness = await startHarness()
  harnesses.push(harness)
  for (const dispose of harness.disposers) dispose()
  const result = await call(harness, 'GET', `${BRIDGE_PREFIX}/status`)
  assert.equal(result.status, 404)
})
