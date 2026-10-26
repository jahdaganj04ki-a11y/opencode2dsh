/**
 * Free-model catalog: live listing, bounded warm-up, disk cache, static net.
 *
 * The gateway listing at `/inference/v1/models` discloses ids only; the
 * capability table in `capabilities.ts` supplies every operational fact. This
 * module owns *which ids exist right now*:
 *
 *  - a refresh runs in the background on plugin load and every `refreshSeconds`;
 *  - `listModels` waits at most `warmMs` for the first fetch, then answers from
 *    whatever state exists (live → disk cache → baked-in static roster), so the
 *    model picker never blocks on a slow gateway;
 *  - eligibility is applied uniformly: free-name rule, blocklist, allowlist.
 */

import { fetchJson, GatewayFailure, CODE } from './http.js'
import { blockReason, isFreeId, capabilitiesFor, displayName } from './capabilities.js'
import {
  CATALOG_CACHE_FILE,
  CATALOG_CACHE_TTL_MS,
  HEALTH_FILE,
  JsonStore,
  type CachedCatalog,
  type HealthSnapshot,
} from './store.js'
import type { Logger, ModelInfo } from './types.js'
import type { ResolvedConfig } from './config.js'

/** Roster baked in on 2026-10-26; used only when live and cache both fail. */
const STATIC_ROSTER = [
  'big-pickle',
  'beam-free',
  'flint-40b-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
] as const

type CatalogState = 'bootstrapping' | 'ready' | 'stale' | 'error'

interface ListingEnvelope {
  data?: Array<{ id?: unknown }>
  models?: Array<{ id?: unknown }>
}

export class ModelCatalog {
  private ids: string[] = []
  private state: CatalogState = 'bootstrapping'
  private lastError: string | undefined
  private warmPromise: Promise<void> | undefined
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private started = false

  constructor(
    private readonly config: ResolvedConfig,
    private readonly store: JsonStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.hydrate()
    this.warmPromise = this.refresh()
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error: unknown) => {
        this.logger.warn?.('[opencode2dsh] scheduled catalog refresh failed', error)
      })
    }, this.config.refreshSeconds * 1000)
    // Don't keep the Electron process alive solely for catalog polling.
    this.refreshTimer.unref?.()
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  }

  private hydrate(): void {
    if (!this.config.diskCache) return
    const cached = this.store.read<CachedCatalog>(CATALOG_CACHE_FILE)
    if (cached && Array.isArray(cached.ids) && this.now() - cached.at < CATALOG_CACHE_TTL_MS) {
      this.ids = cached.ids
      this.state = 'stale'
      this.writeHealth('cache')
    } else {
      this.ids = [...STATIC_ROSTER]
      this.writeHealth('static')
    }
  }

  /** Bounded wait for the first live fetch; never throws. */
  async warm(maxWaitMs: number): Promise<void> {
    if (!this.warmPromise) this.warmPromise = this.refresh()
    const pending = this.warmPromise
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs)
      timer.unref?.()
    })
    await Promise.race([pending.catch(() => undefined), timeout])
    if (timer) clearTimeout(timer)
  }

  async refresh(): Promise<void> {
    const url = `${this.config.baseUrl}/inference/v1/models`
    try {
      const envelope = await fetchJson<ListingEnvelope>(url)
      const rows = envelope.data ?? envelope.models ?? []
      const ids = rows
        .map((row) => (typeof row.id === 'string' ? row.id : ''))
        .filter((id) => id.length > 0)
      if (ids.length === 0) {
        throw new GatewayFailure('Gateway listing returned no models.', CODE.UPSTREAM, undefined, undefined, undefined, true)
      }
      this.ids = ids
      this.state = 'ready'
      this.lastError = undefined
      if (this.config.diskCache) {
        this.store.write(CATALOG_CACHE_FILE, { at: this.now(), ids } satisfies CachedCatalog)
      }
      this.writeHealth('live')
      this.logger.info?.(`[opencode2dsh] catalog refreshed: ${ids.length} gateway ids, ${this.eligibleIds().length} exposed`)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.state = this.ids.length > 0 ? 'stale' : 'error'
      this.writeHealth(this.ids.length > 0 ? 'cache' : 'static')
      this.logger.warn?.(`[opencode2dsh] catalog refresh failed (${this.lastError}); serving ${this.ids.length} cached/static ids`)
    } finally {
      if (this.warmPromise === undefined) this.warmPromise = Promise.resolve()
    }
  }

  /** Apply free-rule, blocklist and the optional allowlist to the raw ids. */
  eligibleIds(): string[] {
    const allow = this.config.allowedModels
    return this.ids.filter((id) => {
      if (allow.length > 0 && !allow.includes(id)) return false
      if (!isFreeId(id)) return false
      const reason = blockReason(id)
      if (reason) {
        this.logger.debug?.(`[opencode2dsh] hiding ${id}: ${reason}`)
        return false
      }
      return true
    })
  }

  async listModels(provider: string): Promise<ModelInfo[]> {
    await this.warm(this.config.warmMs)
    return this.eligibleIds().map((id) => {
      const cap = capabilitiesFor(id)
      return {
        provider,
        id,
        name: cap.name || displayName(id),
        description: cap.note,
        inputModalities: cap.vision ? (['text', 'image'] as const) : (['text'] as const),
      }
    })
  }

  private writeHealth(source: 'live' | 'cache' | 'static'): void {
    if (!this.config.diskCache) return
    const snapshot: HealthSnapshot = {
      writtenAt: new Date(this.now()).toISOString(),
      state: this.state,
      modelCount: this.eligibleIds().length,
      models: this.eligibleIds(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      source,
    }
    this.store.write(HEALTH_FILE, snapshot)
  }
}

/** Minimal listing fetch used by the standalone smoke script. */
export async function fetchListing(baseUrl: string): Promise<string[]> {
  const envelope = await fetchJson<ListingEnvelope>(`${baseUrl}/inference/v1/models`)
  const rows = envelope.data ?? envelope.models ?? []
  return rows.map((row) => (typeof row.id === 'string' ? row.id : '')).filter(Boolean)
}
