/**
 * Same-origin loopback bridge backing the settings-page refresh button.
 *
 * The browser half (see `src/client/index.ts`) is served by the same host
 * process as the web shell, so it talks to these routes over relative URLs.
 * Two routes are mounted under the plugin's own prefix:
 *
 *   GET  /api/opencode2dsh/status   — current roster/catalog snapshot, no I/O
 *   POST /api/opencode2dsh/refresh  — one forced listing fetch, then the
 *                                     adapter is re-announced so every cached
 *                                     model picker re-reads the roster
 *
 * Trust model copied verbatim from the validated dsh-llm-proxy / opencode2dsh
 * ip-pool bridges: loopback socket + canonical loopback Host header +
 * same-origin browser marker. Any other request 403s. No DNS name, no
 * wildcard and no tunnel endpoint can satisfy all three conditions.
 */

import type { CatalogSnapshot } from './catalog.js'
import type {
  BridgeHttpRequest,
  BridgeHttpResponse,
  WebServerRoute,
  WebServerService,
} from './types.js'

/** Bridge route prefix (same-origin, loopback-only). */
export const BRIDGE_PREFIX = '/api/opencode2dsh'

/** Cap on JSON request bodies (a refresh trigger carries no payload at all). */
const MAX_JSON_BODY_BYTES = 16 * 1024

/** Outcome of a forced refresh; the failure branch still carries the roster
 *  the catalog keeps serving, so the card never blanks on a gateway error. */
export type RefreshOutcome =
  | { ok: true; value: CatalogSnapshot & { refreshedAt: number } }
  | { ok: false; code: string; message: string; snapshot: CatalogSnapshot }

export interface CatalogBridgeHandlers {
  refresh(): Promise<RefreshOutcome>
  snapshot(): CatalogSnapshot
}

// -- trust guard (copied from the validated host bridge pattern) ──────────────

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address: unknown): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority: string): { url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined
    }
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) {
      return undefined
    }
    return { url }
  } catch {
    return undefined
  }
}

/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(
  request: { headers: Record<string, string | string[] | undefined> },
  hostUrl: URL,
): boolean {
  const headers = request.headers
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
export function isTrustedBridgeRequest(request: {
  socket?: { remoteAddress?: unknown }
  headers: Record<string, string | string[] | undefined>
}): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  return isLoopbackHostname(parsed.url.hostname)
}

// -- response plumbing ────────────────────────────────────────────────────────

function writeJson(res: BridgeHttpResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read an optional JSON body; the routes ignore its content, they only
 *  validate presence/size/parseability so a client never lingers mid-request. */
async function readOptionalJsonBody(req: BridgeHttpRequest): Promise<{ present: boolean; ok: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return { present: true, ok: false }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return { present: false, ok: true }
  // A body is allowed but must be valid JSON when present.
  try {
    JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return { present: true, ok: true }
  } catch {
    return { present: true, ok: false }
  }
}

// -- route construction + mount ───────────────────────────────────────────────

export function makeBridgeRoutes(handlers: CatalogBridgeHandlers): WebServerRoute[] {
  const guard = (req: BridgeHttpRequest, res: BridgeHttpResponse): boolean => {
    if (!isTrustedBridgeRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'bridge accepts loopback same-origin requests only' })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/status`,
      handler: (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `GET required, got ${req.method ?? ''}` })
          return
        }
        writeJson(res, 200, { ok: true, value: { ...handlers.snapshot(), at: Date.now() } })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/refresh`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `POST required, got ${req.method ?? ''}` })
          return
        }
        // Drain (and validate) the body so a client never lingers on a
        // half-sent request; the trigger itself needs no parameters.
        const body = await readOptionalJsonBody(req)
        if (body.present && !body.ok) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'body must be valid JSON no larger than 16 KiB' })
          return
        }
        try {
          const outcome = await handlers.refresh()
          // Handler-level failures keep HTTP 200: the transport worked, the
          // envelope honestly classifies the upstream outcome (and still
          // carries the roster the catalog continues to serve).
          writeJson(res, 200, outcome)
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
  ]
}

/**
 * Register the bridge routes on a host webServer service. Returns the
 * disposers the caller must tie to its scoped fiber's effect lifecycle.
 */
export function mountCatalogBridge(webServer: WebServerService, handlers: CatalogBridgeHandlers): Array<() => void> {
  return makeBridgeRoutes(handlers).map((route) => webServer.register(route))
}
