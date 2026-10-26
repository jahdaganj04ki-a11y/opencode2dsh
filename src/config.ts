/**
 * Plugin configuration.
 *
 * The Cordis loader passes the `config` object declared for this row in
 * `cordis.patch.yml`. There is no settings-page schema requirement: absent
 * fields fall back to the defaults below, and every value is validated instead
 * of trusted, so a hand-edited profile patch cannot crash the composition.
 */

export interface PluginConfig {
  /** Provider route id shown in the DSH model picker. */
  providerId?: string
  /** Gateway origin (override only useful for mirrors or tests). */
  baseUrl?: string
  /** Catalog refresh cadence in seconds. */
  refreshSeconds?: number
  /** Bounded wait for the first live catalog fetch inside `listModels`, ms. */
  warmMs?: number
  /** Exact model id allowlist; empty exposes every eligible free model. */
  allowedModels?: string[]
  /** Watchdog: ms to first stream byte before the turn fails as TIMEOUT. */
  firstEventMs?: number
  /** Watchdog: ms of mid-stream silence (chat/messages wires). */
  bodyIdleMs?: number
  /** Watchdog: ms of mid-stream silence on the Responses wire (bursty think). */
  responsesBodyIdleMs?: number
  /** Watchdog: ms for the catalog listing fetch (connect + headers + body). */
  listTimeoutMs?: number
  /** Disable the disk catalog cache (tests). */
  diskCache?: boolean
  /** Override the data directory (tests). */
  dataDir?: string
}

export const DEFAULT_PROVIDER_ID = 'opencode-free'
export const DEFAULT_BASE_URL = 'https://opencode.ai'
export const DEFAULT_REFRESH_SECONDS = 300
export const DEFAULT_WARM_MS = 4000
export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000
export const DEFAULT_RESPONSES_BODY_IDLE_MS = 300_000
export const DEFAULT_LIST_TIMEOUT_MS = 15_000

const MIN = 1
const MAX_REFRESH = 24 * 3600
const MAX_TIMEOUT = 600_000
const MAX_LIST_TIMEOUT = 120_000

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const truncated = Math.trunc(value)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

export interface ResolvedConfig {
  providerId: string
  baseUrl: string
  refreshSeconds: number
  warmMs: number
  allowedModels: string[]
  firstEventMs: number
  bodyIdleMs: number
  responsesBodyIdleMs: number
  listTimeoutMs: number
  diskCache: boolean
  dataDir?: string
}

export function resolveConfig(raw: PluginConfig | undefined): ResolvedConfig {
  const config = raw ?? {}
  const allowed = Array.isArray(config.allowedModels)
    ? config.allowedModels.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : []
  const baseUrl = stringValue(config.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '')
  return {
    providerId: stringValue(config.providerId, DEFAULT_PROVIDER_ID),
    baseUrl,
    refreshSeconds: integer(config.refreshSeconds, DEFAULT_REFRESH_SECONDS, 30, MAX_REFRESH),
    warmMs: integer(config.warmMs, DEFAULT_WARM_MS, 0, MAX_TIMEOUT),
    allowedModels: [...new Set(allowed)],
    firstEventMs: integer(config.firstEventMs, DEFAULT_FIRST_EVENT_MS, MIN, MAX_TIMEOUT),
    bodyIdleMs: integer(config.bodyIdleMs, DEFAULT_BODY_IDLE_MS, MIN, MAX_TIMEOUT),
    responsesBodyIdleMs: integer(config.responsesBodyIdleMs, DEFAULT_RESPONSES_BODY_IDLE_MS, MIN, MAX_TIMEOUT),
    listTimeoutMs: integer(config.listTimeoutMs, DEFAULT_LIST_TIMEOUT_MS, 1_000, MAX_LIST_TIMEOUT),
    diskCache: config.diskCache !== false,
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() !== '' ? config.dataDir : undefined,
  }
}
