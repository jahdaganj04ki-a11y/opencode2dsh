/**
 * Free-model catalog: live listing, startup refresh with retries, disk cache,
 * static net, and roster-change announcements.
 *
 * The gateway listing at `/inference/v1/models` discloses ids only; the
 * capability table in `capabilities.ts` supplies every operational fact. This
 * module owns *which ids exist right now* and the guarantee the picker always
 * shows the current usable free models:
 *
 *  - on `start()` (plugin load = program start) a live fetch runs immediately;
 *  - a failed startup fetch retries on a short backoff schedule until the
 *    first live answer arrives, so a slow network self-heals in seconds
 *    instead of waiting a full refresh interval;
 *  - afterwards a refresh runs every `refreshSeconds`;
 *  - every fetch is de-duplicated against in-flight work, so the interval and
 *    the retry loop can never overlap;
 *  - whenever the *eligible* roster actually changes, `onChange` fires and the
 *    plugin re-announces the adapter (`handle.replace` → host event
 *    `llm/adapters-updated`), which makes every cached model picker re-read
 *    `listModels()`;
 *  - `listModels` waits at most `warmMs` for the first fetch, then answers
 *    from live → disk cache → the baked-in static roster, so the picker never
 *    blocks on a slow gateway and is corrected by the announcement afterwards.
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

/** Startup backoff until the first live answer (ms). */
const DEFAULT_RETRY_SCHEDULE = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

type CatalogState = 'bootstrapping' | 'ready' | 'stale' | 'error'

interface ListingEnvelope {
  data?: Array<{ id?: unknown }>
  models?: Array<{ id?: unknown }>
}

export interface CatalogOptions {
  /** Backoff delays between startup retries; the last entry is repeated. */
  retrySchedule?: number[]
  /**
   * Keep the event loop alive with the catalog timers. Production runs inside
   * Electron and passes `true` (unref); short-lived tests pass `false`.
   */
  unrefTimers?: boolean
  /** Optional metrics snapshot merged into the on-disk health file. */
  metrics?: () => unknown
}

/** Symmetric ±15 % jitter around the configured refresh interval. */
const JITTER_RATIO = 0.15

export class ModelCatalog {
  private ids: string[] = []
  private state: CatalogState = 'bootstrapping'
  private lastError: string | undefined
  private hasLive = false
  private warmPromise: Promise<void> | undefined
  private refreshInFlight: Promise<void> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private disposed = false
  private publishedSignature: string | undefined
  private readonly retrySchedule: number[]
  private readonly unrefTimers: boolean
  private readonly metricsProvider?: () => unknown

  constructor(
    private readonly config: ResolvedConfig,
    private readonly store: JsonStore,
    private readonly logger: Logger,
    private readonly onChange?: () => void,
    private readonly now: () => number = Date.now,
    options: CatalogOptions = {},
  ) {
    this.retrySchedule = options.retrySchedule && options.retrySchedule.length > 0 ? options.retrySchedule : DEFAULT_RETRY_SCHEDULE
    this.unrefTimers = options.unrefTimers !== false
    this.metricsProvider = options.metrics
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.hydrate()
    this.publishedSignature = this.rosterSignature()
    // First live fetch of the process; retries until it succeeds.
    this.warmPromise = this.initialLoop(0)
    this.scheduleRefresh()
  }

  /** Self-rescheduling refresh with jitter so desktop instances desynchronize. */
  private scheduleRefresh(): void {
    if (this.disposed) return
    const base = this.config.refreshSeconds * 1000
    const delay = Math.round(base * (1 - JITTER_RATIO + Math.random() * 2 * JITTER_RATIO))
    this.refreshTimer = setTimeout(() => {
      if (this.disposed) return
      this.refresh()
        .catch((error: unknown) => {
          this.logger.warn?.('[opencode2dsh] scheduled catalog refresh failed', error)
        })
        .finally(() => this.scheduleRefresh())
    }, delay)
    this.keepLoose(this.refreshTimer)
  }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.refreshTimer = undefined
    this.retryTimer = undefined
  }

  private keepLoose(handle: { unref?: () => void }): void {
    if (this.unrefTimers) handle.unref?.()
  }

  /** Refresh-with-backoff until the first live answer, then stop retrying. */
  private initialLoop(attempt: number): Promise<void> {
    return this.refresh().then(
      () => {
        if (this.disposed || this.hasLive) return
        const delay = this.retrySchedule[Math.min(attempt, this.retrySchedule.length - 1)] ?? 30_000
        this.retryTimer = setTimeout(() => {
          if (this.disposed) return
          this.initialLoop(attempt + 1).catch(() => undefined)
        }, delay)
        this.keepLoose(this.retryTimer)
      },
      () => {
        if (this.disposed) return
        const delay = this.retrySchedule[Math.min(attempt, this.retrySchedule.length - 1)] ?? 30_000
        this.retryTimer = setTimeout(() => {
          if (this.disposed) return
          this.initialLoop(attempt + 1).catch(() => undefined)
        }, delay)
        this.keepLoose(this.retryTimer)
      },
    )
  }

  private hydrate(): void {
    if (!this.config.diskCache) {
      this.ids = [...STATIC_ROSTER]
      this.writeHealth('static')
      return
    }
    const cached = this.store.read<CachedCatalog>(CATALOG_CACHE_FILE)
    if (cached && Array.isArray(cached.ids) && this.now() - cached.at < CATALOG_CACHE_TTL_MS) {
      this.ids = [...new Set(cached.ids)]
      this.state = 'stale'
      this.writeHealth('cache')
    } else {
      this.ids = [...STATIC_ROSTER]
      this.writeHealth('static')
    }
  }

  /** Bounded wait for the first live fetch attempt; never throws. */
  async warm(maxWaitMs: number): Promise<void> {
    if (!this.warmPromise) this.warmPromise = this.initialLoop(0)
    const pending = this.warmPromise
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs)
      this.keepLoose(timer)
    })
    await Promise.race([pending.catch(() => undefined), timeout])
    if (timer) clearTimeout(timer)
  }

  /** One de-duplicated refresh; safe to call from the interval and retries. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    const job = this.doRefresh().finally(() => {
      if (this.refreshInFlight === job) this.refreshInFlight = undefined
    })
    this.refreshInFlight = job
    return job
  }

  private async doRefresh(): Promise<void> {
    const url = `${this.config.baseUrl}/inference/v1/models`
    try {
      const envelope = await fetchJson<ListingEnvelope>(url, { timeoutMs: this.config.listTimeoutMs })
      const rows = envelope.data ?? envelope.models ?? []
      // De-duplicate defensively: the host rejects a catalog with repeated
      // ids (INVALID_CATALOG), so never let a quirky listing through as-is.
      const ids = [...new Set(
        rows
          .map((row) => (typeof row.id === 'string' ? row.id : ''))
          .filter((id) => id.length > 0),
      )]
      if (ids.length === 0) {
        throw new GatewayFailure('Gateway listing returned no models.', CODE.UPSTREAM, undefined, undefined, undefined, true)
      }
      // Never replace a working roster with one that exposes nothing: a gate
      // change or intermediary quirk must empty the picker, not hide models.
      const nextEligible = this.eligibleFrom(ids)
      if (nextEligible.length === 0 && this.eligibleIds().length > 0) {
        throw new GatewayFailure(
          'Gateway listing contained no eligible free models; keeping the previous roster.',
          CODE.UPSTREAM, undefined, undefined, undefined, true,
        )
      }
      this.ids = ids
      this.hasLive = true
      this.state = 'ready'
      this.lastError = undefined
      if (this.config.diskCache) {
        this.store.write(CATALOG_CACHE_FILE, { at: this.now(), ids } satisfies CachedCatalog)
      }
      this.writeHealth('live')
      this.announceIfChanged()
      this.logger.info?.(`[opencode2dsh] catalog refreshed: ${ids.length} gateway ids, ${this.eligibleIds().length} exposed`)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.state = this.ids.length > 0 ? 'stale' : 'error'
      this.writeHealth(this.hasLive ? 'cache' : this.ids.length > 0 ? 'cache' : 'static')
      this.logger.warn?.(`[opencode2dsh] catalog refresh failed (${this.lastError}); serving ${this.ids.length} cached/static ids`)
      throw error
    }
  }

  /** Eligibility rules applied to an arbitrary id list (pre-commit check). */
  private eligibleFrom(ids: string[]): string[] {
    const allow = this.config.allowedModels
    const out: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      if (allow.length > 0 && !allow.includes(id)) continue
      if (!isFreeId(id)) continue
      const reason = blockReason(id)
      if (reason) {
        this.logger.debug?.(`[opencode2dsh] hiding ${id}: ${reason}`)
        continue
      }
      seen.add(id)
      out.push(id)
    }
    return out
  }

  private rosterSignature(): string {
    // The capability facts the picker observes; ids alone carry everything
    // the code derives, modalities are included to catch table changes.
    return JSON.stringify(
      this.eligibleIds()
        .slice()
        .sort()
        .map((id) => {
          const cap = capabilitiesFor(id)
          return [id, cap.vision ? 'image' : 'text']
        }),
    )
  }

  private announceIfChanged(): void {
    if (!this.onChange) return
    const signature = this.rosterSignature()
    if (signature === this.publishedSignature) return
    this.publishedSignature = signature
    try {
      this.onChange()
    } catch (error) {
      this.logger.warn?.('[opencode2dsh] roster announcement failed', error)
    }
  }

  /** Apply free-rule, blocklist, allowlist and de-dupe to the raw ids. */
  eligibleIds(): string[] {
    return this.eligibleFrom(this.ids)
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
      ...(this.metricsProvider ? { metrics: this.metricsProvider() } : {}),
    }
    this.store.write(HEALTH_FILE, snapshot)
  }
}

/** Minimal listing fetch used by the standalone smoke script. */
export async function fetchListing(baseUrl: string): Promise<string[]> {
  const envelope = await fetchJson<ListingEnvelope>(`${baseUrl}/inference/v1/models`, { timeoutMs: 30_000 })
  const rows = envelope.data ?? envelope.models ?? []
  return [...new Set(rows.map((row) => (typeof row.id === 'string' ? row.id : '')).filter(Boolean))]
}
