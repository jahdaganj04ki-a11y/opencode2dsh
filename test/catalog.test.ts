import assert from 'node:assert/strict'
import { test, afterEach, mock } from 'node:test'
import { ModelCatalog } from '../src/catalog.js'
import { resolveConfig } from '../src/config.js'
import { JsonStore } from '../src/store.js'
import type { Logger } from '../src/types.js'

const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {}
}

function makeCatalog(onChange?: () => void, retrySchedule = [5, 10, 20]): ModelCatalog {
  const config = resolveConfig({ diskCache: false, warmMs: 2000 })
  return new ModelCatalog(config, new JsonStore('/tmp/opencode2dsh-test-unused'), silentLogger, onChange, Date.now, {
    retrySchedule,
    unrefTimers: false,
  })
}

function listingResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const liveIds = [
  'big-pickle',
  'beam-free',
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'jev-1.13-free', // blocklisted
  'paid-console-model', // not free
  'big-pickle', // duplicate, must be deduped
]

const catalogs: ModelCatalog[] = []
function track(catalog: ModelCatalog): ModelCatalog {
  catalogs.push(catalog)
  return catalog
}

afterEach(() => {
  while (catalogs.length) catalogs.pop()?.dispose()
  mock.restoreAll()
})

test('start fetches the live listing immediately and exposes only eligible free ids', async () => {
  mock.method(globalThis, 'fetch', async () => listingResponse(liveIds))
  const catalog = track(makeCatalog())
  catalog.start()
  await catalog.warm(3000)

  const models = await catalog.listModels('opencode-free')
  const ids = models.map((m) => m.id)
  assert.deepEqual(ids, ['big-pickle', 'beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free'])
  assert.ok(!ids.includes('jev-1.13-free'))
  assert.ok(!ids.includes('paid-console-model'))
  // No duplicate ids (the host would reject those with INVALID_CATALOG).
  assert.equal(new Set(ids).size, ids.length)
  // Every entry carries the provider route and valid modalities.
  for (const model of models) {
    assert.equal(model.provider, 'opencode-free')
    assert.ok(model.inputModalities && model.inputModalities.includes('text'))
  }
})

test('a failed startup fetch retries on the backoff schedule and then goes live', async () => {
  let attempts = 0
  mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    if (attempts === 1) throw new TypeError('network down')
    return listingResponse(liveIds)
  })

  let announced = false
  const changed = new Promise<void>((resolve) => {
    const catalog = track(makeCatalog(() => {
      announced = true
      resolve()
    }))
    catalog.start()
  })

  await changed
  assert.ok(attempts >= 2, `expected a retry, got ${attempts} fetch attempt(s)`)
  assert.equal(announced, true)
})

test('onChange fires when the eligible roster changes but not when it stays identical', async () => {
  let calls = 0
  const catalog = track(makeCatalog(() => {
    calls += 1
  }))
  mock.method(globalThis, 'fetch', async () => listingResponse(liveIds))
  catalog.start()
  await catalog.warm(3000)
  const afterFirst = calls
  assert.ok(afterFirst >= 1)

  // Identical listing again: no new announcement.
  await catalog.refresh()
  assert.equal(calls, afterFirst)

  // A rotated id appears: one announcement for the changed signature.
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () => listingResponse([...liveIds, 'mimo-v2.6-flash-free']))
  await catalog.refresh()
  assert.equal(calls, afterFirst + 1)
})

test('dispose stops the retry loop: no further fetches after teardown', async () => {
  let attempts = 0
  mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    throw new TypeError('still offline')
  })
  const catalog = makeCatalog(undefined, [5, 10])
  catalog.start()
  await new Promise((resolve) => setTimeout(resolve, 45))
  catalog.dispose()
  const atDispose = attempts
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(attempts, atDispose)
  assert.ok(atDispose >= 2)
})

test('when the live fetch never succeeds, listModels still answers from the static roster', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('offline')
  })
  const catalog = track(makeCatalog(undefined, [5]))
  catalog.start()
  const models = await catalog.listModels('opencode-free')
  assert.ok(models.length > 0)
  assert.ok(models.every((m) => m.provider === 'opencode-free'))
})
