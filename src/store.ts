/**
 * On-disk state: catalog cache and a health snapshot.
 *
 * Resolution mirrors the harness home-paths helper: `$DSH_HOME` when set,
 * otherwise `~/.dsh`. The plugin owns one subdirectory and never writes outside
 * it. All writes are best-effort: a read-only profile or a locked Windows file
 * must degrade the cache, never the provider.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const DATA_DIR_NAME = 'opencode2dsh'

export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function resolveDataDir(override?: string): string {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(resolveDshHome(), DATA_DIR_NAME)
}

export interface CachedCatalog {
  at: number
  ids: string[]
  /** ETag of the last live listing, used for conditional re-fetches. */
  etag?: string
}

export interface HealthSnapshot {
  writtenAt: string
  state: 'ready' | 'stale' | 'bootstrapping' | 'error'
  modelCount: number
  models: string[]
  lastError?: string
  source?: 'live' | 'cache' | 'static'
  metrics?: unknown
}

export class JsonStore {
  constructor(private readonly dir: string) {}

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  private path(file: string): string {
    return join(this.dir, file)
  }

  read<T>(file: string): T | undefined {
    try {
      const raw = readFileSync(this.path(file), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  /** Atomic write via temp-file rename; on Windows the rename is the safe half. */
  write(file: string, value: unknown): void {
    try {
      this.ensureDir()
      const target = this.path(file)
      const tmp = `${target}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, target)
    } catch {
      // Best-effort persistence — the in-memory state stays authoritative.
    }
  }
}

export const CATALOG_CACHE_FILE = 'catalog-cache.json'
export const HEALTH_FILE = 'adapter-status.json'
export const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
