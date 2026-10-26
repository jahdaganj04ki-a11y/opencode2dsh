/**
 * opencode2dsh — DSH (DeepSeek Harness / DSH Desktop) Cordis plugin.
 *
 * Registers one LLM provider route backed by OpenCode's anonymous free lane,
 * with the full v2 client fingerprint (see `fingerprint.ts`) so the gateway
 * serves the models without an API key and without a sidecar process.
 *
 * The plugin imports no `@deepseek-ai/*` package at runtime: the host's
 * `registerAdapter` validates structurally and only ever calls the adapter
 * methods, which keeps the installed pnpm generation dependency-free on
 * Windows and lets esbuild emit one self-contained bundle.
 */

import { OpenCodeFreeAdapter } from './adapter.js'
import { BRIDGE_PREFIX, mountCatalogBridge } from './bridge.js'
import { DEFAULT_PROVIDER_ID, resolveConfig, type PluginConfig } from './config.js'
import type {
  AdapterRegistrationHandle,
  PluginContext,
  WebServerPluginContext,
  WebServerService,
} from './types.js'

export const name = 'opencode2dsh'
export const inject = ['llm']

export interface Config extends PluginConfig {}

export function apply(ctx: PluginContext, rawConfig?: PluginConfig): void {
  const config = resolveConfig(rawConfig)
  const providerId = config.providerId || DEFAULT_PROVIDER_ID

  // Assigned right after construction. The catalog's first fetch is async, so
  // it can never resolve before this synchronous registration completes.
  let handle: AdapterRegistrationHandle | undefined

  // Re-commit the route whenever the live roster changes: the host swap emits
  // `llm/adapters-updated`, whose consumers discard their cached roster and
  // re-read `listModels()`. This is what keeps the picker current after the
  // startup refresh and every later background refresh.
  const announce = (): void => {
    try {
      if (handle && typeof handle.replace === 'function') {
        handle.replace([providerId])
      } else if (typeof ctx.emit === 'function') {
        ctx.emit('llm/adapters-updated')
      }
    } catch (error) {
      ctx.logger.warn?.('[opencode2dsh] roster announcement failed', error)
    }
  }

  const adapter = new OpenCodeFreeAdapter({
    logger: ctx.logger,
    ctx,
    config: rawConfig,
    onRosterChange: announce,
  })

  handle = ctx.llm.registerAdapter([providerId], adapter)
  // Initial announcement: also covers hot reloads and immediately invalidates
  // any roster a previous generation left cached.
  announce()

  mountSettingsBridge(ctx, adapter)

  ctx.logger.info?.(`[opencode2dsh] provider "${providerId}" registered (${PROVIDER_LABEL})`)

  ctx.effect?.(() => () => {
    try {
      handle?.()
    } catch {
      // Already unregistered by host teardown.
    }
  })
}

/**
 * Mount the browser-card bridge in a *separate* scoped fiber.
 *
 * `webServer` must never join the top-level `inject` list: on host 0.1.5+ a
 * service there that a profile does not provide fails the whole plugin tree
 * load. A scoped `ctx.inject(['webServer'], …)` simply never activates on
 * headless/CLI profiles, while the LLM provider above keeps working. Any
 * failure here degrades to "no refresh button backend" only, never to a
 * dead adapter.
 */
function mountSettingsBridge(ctx: PluginContext, adapter: OpenCodeFreeAdapter): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (rawWebCtx: PluginContext) => {
    try {
      const webCtx = rawWebCtx as WebServerPluginContext
      const webServer: WebServerService | undefined = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      const disposers = mountCatalogBridge(webServer, {
        async refresh() {
          try {
            await adapter.refreshModels()
            // Re-announce even when the listing was unchanged (304): the
            // explicit user action must re-sync every cached picker.
            adapter.announceRoster()
            return { ok: true as const, value: { ...adapter.modelSnapshot(), refreshedAt: Date.now() } }
          } catch (error) {
            // Honest classification; the catalog keeps serving its last good
            // roster, which travels back in the same envelope.
            return {
              ok: false as const,
              code: 'refresh-failed',
              message: error instanceof Error ? error.message : String(error),
              snapshot: adapter.modelSnapshot(),
            }
          }
        },
        snapshot: () => adapter.modelSnapshot(),
      })
      webCtx.effect?.(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // Host already tore the route down during fiber disposal.
          }
        }
      })
      ctx.logger.info?.(`[opencode2dsh] settings bridge mounted at ${BRIDGE_PREFIX} (${disposers.length} routes)`)
    } catch (error) {
      ctx.logger.warn?.('[opencode2dsh] settings bridge not mounted', error)
    }
  })
}

const PROVIDER_LABEL = 'OpenCode free models, anonymous lane'

export { OpenCodeFreeAdapter } from './adapter.js'
export { LlmFailureError } from './adapter.js'
export { fetchListing } from './catalog.js'
export { mintSessionId, isCanonicalSession, canonicalizeSession, sessionForConversation } from './fingerprint.js'
export { capabilitiesFor, isFreeId, blockReason } from './capabilities.js'
