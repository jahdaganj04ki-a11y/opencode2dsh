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
import { DEFAULT_PROVIDER_ID, resolveConfig, type PluginConfig } from './config.js'
import type { PluginContext } from './types.js'

export const name = 'opencode2dsh'
export const inject = ['llm']

export interface Config extends PluginConfig {}

export function apply(ctx: PluginContext, rawConfig?: PluginConfig): void {
  const config = resolveConfig(rawConfig)
  const providerId = config.providerId || DEFAULT_PROVIDER_ID

  const adapter = new OpenCodeFreeAdapter({ logger: ctx.logger, ctx, config: rawConfig })

  const handle = ctx.llm.registerAdapter([providerId], adapter)

  // Re-announce the route so model pickers pick it up on hot reload as well.
  if (handle && typeof handle.replace === 'function') {
    try {
      handle.replace([providerId])
    } catch (error) {
      ctx.logger.warn?.('[opencode2dsh] adapter replace() announcement failed', error)
    }
  }

  ctx.logger.info?.(`[opencode2dsh] provider "${providerId}" registered (${PROVIDER_LABEL})`)

  ctx.effect?.(() => () => {
    try {
      handle()
    } catch {
      // Already unregistered by host teardown.
    }
  })
}

const PROVIDER_LABEL = 'OpenCode free models, anonymous lane'

export { OpenCodeFreeAdapter } from './adapter.js'
export { LlmFailureError } from './adapter.js'
export { fetchListing } from './catalog.js'
export { mintSessionId, isCanonicalSession, canonicalizeSession, sessionForConversation } from './fingerprint.js'
export { capabilitiesFor, isFreeId, blockReason } from './capabilities.js'
