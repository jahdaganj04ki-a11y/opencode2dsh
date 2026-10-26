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

test('a listing without eligible free models never empties a working roster', async () => {
  let phase: 'good' | 'empty' | 'recovered' = 'good'
  let announcements = 0
  mock.method(globalThis, 'fetch', async () => {
    if (phase === 'good' || phase === 'recovered') return listingResponse(liveIds)
    return listingResponse(['paid-console-model', 'another-paid-thing'])
  })
  const catalog = track(makeCatalog(() => {
    announcements += 1
  }))
  catalog.start()
  await catalog.warm(3000)
  const goodIds = catalog.eligibleIds()
  assert.ok(goodIds.length > 0)
  const announcedAfterFirst = announcements

  // Unusable listing: refresh rejects, the previous roster survives, no announcement.
  phase = 'empty'
  await assert.rejects(catalog.refresh())
  assert.deepEqual(catalog.eligibleIds(), goodIds)
  assert.equal(announcements, announcedAfterFirst)

  // Gateway recovers: the roster updates again.
  phase = 'recovered'
  await catalog.refresh()
  assert.deepEqual(catalog.eligibleIds(), goodIds)
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

test('conditional refresh sends If-None-Match and a 304 keeps the roster without re-announcing', async () => {
  const requestHeaders: RequestInit['headers'][] = []
  let phase: 'initial' | 'revalidate' = 'initial'
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requestHeaders.push(init?.headers)
    if (phase === 'revalidate') {
      return new Response(null, { status: 304, headers: { etag: '"v2-etag"' } })
    }
    return new Response(JSON.stringify({ data: liveIds.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"v1-etag"' },
    })
  })

  let announcements = 0
  const catalog = track(makeCatalog(() => { announcements += 1 }))
  catalog.start()
  await catalog.warm(3000)
  const before = catalog.eligibleIds()
  assert.ok(before.length > 0)
  const announcedAfterFirst = announcements

  // Second refresh must carry the stored ETag and accept a 304 as success.
  phase = 'revalidate'
  await catalog.refresh()
  const lastHeaders = new Headers(requestHeaders.at(-1))
  assert.equal(lastHeaders.get('if-none-match'), '"v1-etag"')
  assert.deepEqual(catalog.eligibleIds(), before)
  assert.equal(announcements, announcedAfterFirst, '304 must not re-announce an unchanged roster')
})

test('the ETag survives a disk-cache restart and is re-sent by the next catalog instance', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'opencode2dsh-etag-'))

  try {
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
      new Response(JSON.stringify({ data: liveIds.map((id) => ({ id })) }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"persisted-etag"' },
      }),
    )
    const first = new ModelCatalog(
      resolveConfig({ diskCache: true, warmMs: 2000, dataDir: dir }),
      new JsonStore(dir),
      silentLogger,
      undefined,
      Date.now,
      { retrySchedule: [5, 10, 20], unrefTimers: false },
    )
    track(first)
    first.start()
    await first.warm(3000)
    first.dispose()

    const seen: string[] = []
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('if-none-match') ?? '(none)')
      return new Response(null, { status: 304, headers: { etag: '"persisted-etag"' } })
    })
    const second = new ModelCatalog(
      resolveConfig({ diskCache: true, warmMs: 2000, dataDir: dir }),
      new JsonStore(dir),
      silentLogger,
      undefined,
      Date.now,
      { retrySchedule: [5, 10, 20], unrefTimers: false },
    )
    track(second)
    second.start()
    await second.warm(3000)
    assert.deepEqual(seen.filter((value) => value !== '(none)'), ['"persisted-etag"'])
    assert.deepEqual(second.eligibleIds(), first.eligibleIds())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot() exposes live state, eligible ids and the last fetch timestamp', async () => {
  const catalog = track(makeCatalog())
  const boot = catalog.snapshot()
  assert.equal(boot.state, 'bootstrapping')
  assert.equal(boot.live, false)
  assert.equal(boot.lastFetchAt, undefined)
  assert.deepEqual(boot.eligible, [], 'nothing is exposed before start() hydrates the roster')

  mock.method(globalThis, 'fetch', async () => listingResponse(liveIds))
  catalog.start()
  await catalog.warm(3000)

  const live = catalog.snapshot()
  assert.equal(live.state, 'ready')
  assert.equal(live.live, true)
  assert.equal(typeof live.lastFetchAt, 'number')
  assert.deepEqual(live.eligible, catalog.eligibleIds())
  assert.ok(live.total >= live.eligible.length)
  assert.equal(live.lastError, undefined)
})

test('forceAnnounce() re-publishes an unchanged roster for the manual refresh button', async () => {
  let calls = 0
  const catalog = track(makeCatalog(() => {
    calls += 1
  }))
  mock.method(globalThis, 'fetch', async () => listingResponse(liveIds))
  catalog.start()
  await catalog.warm(3000)
  const afterFirst = calls
  assert.ok(afterFirst >= 1)

  // An identical listing changes nothing, so a plain refresh stays quiet.
  await catalog.refresh()
  assert.equal(calls, afterFirst)

  // The button path re-announces unconditionally so cached pickers re-sync.
  catalog.forceAnnounce()
  assert.equal(calls, afterFirst + 1)
})

test('a failed fetch leaves the snapshot honest about the error and the fallback roster', async () => {
  const catalog = track(makeCatalog())
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('gateway unreachable')
  })
  catalog.start()
  await catalog.refresh().catch(() => undefined)

  const snap = catalog.snapshot()
  assert.equal(snap.live, false)
  assert.match(snap.lastError ?? '', /gateway unreachable/)
  assert.ok(snap.eligible.length > 0, 'static roster keeps the picker usable offline')
})
