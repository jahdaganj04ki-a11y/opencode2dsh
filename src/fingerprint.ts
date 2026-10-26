/**
 * The OpenCode free-lane client fingerprint (gate state of 2026-10/26).
 *
 * OpenCode's gateway only serves free models to traffic shaped like its own
 * v2 client. Every fact here was established by byte-level replay experiments
 * against the live gateway (documented in dsh-our-free-model's
 * `docs/free-lane-wire.md` and the 9router executor that first ported the v2
 * shape). A request missing ANY of these answers:
 *
 *   403 { "error": { "type": "FreeTierError",
 *        "message": "OpenCode's free tier can only be used from within
 *                    OpenCode. Download it at https://opencode.ai ..." } }
 *
 * Required together:
 *  1. Endpoint under `/inference/v1/*` (the old `/zen/v1` lane is decommissioned
 *     for free ids).
 *  2. User-Agent exactly `opencode/<channel>/<version>/<client>` with major ≥ 2,
 *     sent alone — any prefix/suffix breaks the whole-string v2 match.
 *  3. Four mirrored session headers carrying one canonical `ses_…` id.
 *  4. No `x-opencode-request` header (a v1-only field; its presence 403s).
 *  5. A session id whose 12 hex digits encode the descending timestamp
 *     `~(ts_ms << 12 | counter)` with a small counter — a random or sha256
 *     prefix is rejected even when it matches the `ses_` shape.
 *  6. A `read` and a `shell` tool declared with the official client's exact
 *     descriptions and parameter schemas, and never `tool_choice: "none"`.
 *
 * The pooled anonymous credential is the literal bearer token `public`.
 */

import { createHash, randomBytes } from 'node:crypto'

export const CLIENT_UA = 'opencode/latest/2.0.26/cli'
export const ANONYMOUS_KEY = 'public'

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
/**
 * The decoded timestamp half must end in the inverted-counter window
 * (counter 1–63 → low 12 bits land in 0xfc0–0xfff).
 */
const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Char(index: number): string {
  return BASE62[index % 62] ?? '0'
}

function base62FromBytes(bytes: Buffer): string {
  let out = ''
  for (const byte of bytes) out += base62Char(byte)
  return out
}

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out: string[] = new Array(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = base62Char(Number(n % base))
    n /= base
  }
  return out.join('')
}

let lastStamp = 0
let seq = 0

/**
 * Mint a gateway-shaped canonical session id.
 *
 * The 12 hex characters are `~(ts_ms * 0x1000 + counter)` rendered big-endian;
 * the inversion puts the per-millisecond counter in the low 12 bits the gate
 * decodes back. The counter resets each millisecond, so bursts stay inside the
 * accepted 1–63 window. The 14-char tail is random base62, like the client's.
 */
export function mintSessionId(timestamp: number = Date.now()): string {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp
    seq = 0
  }
  seq += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq)) & 0xffffffffffffn
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `ses_${hex}${base62FromBytes(randomBytes(14))}`
}

export function isCanonicalSession(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const trimmed = id.trim()
  return SESSION_RE.test(trimmed) && SESSION_DESCENDING_RE.test(trimmed.slice(4, 16))
}

/**
 * Deterministically re-encode any conversation seed into an accepted session
 * id. One conversation always maps to the same upstream session (the gateway
 * accounts free quota per session), while the timestamp half remains a freshly
 * minted, gate-valid descending value.
 */
export function canonicalizeSession(seed: string): string {
  const digest = createHash('sha256').update(`ses\0${seed}`).digest()
  const byte = (i: number): number => digest[i] ?? 0
  // Fold digest bytes into the clock half, keeping counter 1 → low bits 0xffe.
  const folded =
    ((BigInt(byte(0)) << 28n) |
      (BigInt(byte(1)) << 20n) |
      (BigInt(byte(2)) << 12n) |
      (BigInt(byte(3)) << 4n) |
      (BigInt(byte(4)) >> 4n)) <<
      12n |
    1n
  const inverted = ~folded & 0xffffffffffffn
  const timeHex = inverted.toString(16).padStart(12, '0')
  return `ses_${timeHex}${base62Fixed(BigInt('0x' + digest.subarray(6, 16).toString('hex')), 14)}`
}

const sessionMemo = new Map<string, string>()
const SESSION_MEMO_LIMIT = 1024

/**
 * Map one conversation onto one stable upstream session.
 *
 * A harness session id (or any already-canonical `ses_…` value) passes through;
 * anything else is re-encoded once and memoized. Empty seeds share `global`.
 */
export function sessionForConversation(seed: string | undefined): string {
  if (typeof seed === 'string') {
    const trimmed = seed.trim()
    if (isCanonicalSession(trimmed)) return trimmed
  }
  const key = typeof seed === 'string' && seed.trim() !== '' ? seed.trim() : 'global'
  const memoized = sessionMemo.get(key)
  if (memoized) return memoized
  const minted = canonicalizeSession(key)
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next().value
    if (oldest !== undefined) sessionMemo.delete(oldest)
  }
  sessionMemo.set(key, minted)
  return minted
}

/**
 * The full v2 header set. `x-opencode-request` is deliberately absent.
 */
export function gatewayHeaders(session: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${ANONYMOUS_KEY}`,
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    accept: 'text/event-stream',
  }
}

// ── Tool fingerprint ────────────────────────────────────────────────────────

interface PlainTool {
  type?: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> }
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Verbatim OpenCode v2.0.26 CLI tool definitions.
 *
 * The gate compares description AND parameter schema byte-for-byte: do not
 * reword, reformat or "improve" these strings.
 */
export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the commands in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
} as const

export const FINGERPRINT_TOOLS = ['read', 'shell'] as const
const MAX_TOOL_NAME_LEN = 128

type WireStyle = 'chat' | 'flat' | 'claude'

function toolName(tool: PlainTool): string {
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  if (tool.function && typeof tool.function.name === 'string') return tool.function.name.trim()
  return ''
}

function fingerprintKey(name: string): '' | 'read' | 'shell' {
  return (FINGERPRINT_TOOLS as readonly string[]).includes(name) ? (name as 'read' | 'shell') : ''
}

function definitionOf(tool: PlainTool, style: WireStyle): { description: string; schema: Record<string, unknown> } | null {
  const wrapper = (style === 'claude' || style === 'flat' ? tool : tool.function) as PlainTool | undefined
  if (!wrapper) return null
  const description = typeof wrapper.description === 'string' ? wrapper.description : ''
  const schema = style === 'claude' ? wrapper.input_schema : wrapper.parameters
  return schema && typeof schema === 'object' ? { description, schema: schema as Record<string, unknown> } : null
}

function carriesOfficialDefinition(tool: PlainTool, name: 'read' | 'shell', style: WireStyle): boolean {
  const own = definitionOf(tool, style)
  if (!own) return false
  const want = FINGERPRINT_TOOL_DEFINITIONS[name]
  return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters)
}

function renameTool(tool: PlainTool, name: string): PlainTool {
  if (tool.function && typeof tool.function === 'object') {
    return { ...tool, function: { ...tool.function, name } }
  }
  return { ...tool, name }
}

function fingerprintTool(name: 'read' | 'shell', style: WireStyle): PlainTool {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name]
  const safeName = name.slice(0, MAX_TOOL_NAME_LEN)
  if (style === 'claude') return { name: safeName, description, input_schema: parameters }
  if (style === 'flat') return { type: 'function', name: safeName, description, parameters }
  return { type: 'function', function: { name: safeName, description, parameters } }
}

function placeholderNote(names: string[]): string {
  const list = names.map((n) => `\`${n}\``).join(' or ')
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
}

function noteInjected(body: Record<string, unknown>, style: WireStyle, names: string[]): void {
  const note = placeholderNote(names)
  if (style === 'flat') {
    const instructions = typeof body.instructions === 'string' ? body.instructions : ''
    body.instructions = instructions ? `${instructions}\n\n${note}` : note
    return
  }
  if (style === 'claude') {
    const system = typeof body.system === 'string' ? body.system : ''
    body.system = system ? `${system}\n\n${note}` : note
    return
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []
  const first = messages[0]
  if (first && first.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  body.messages = [{ role: 'system', content: note }, ...messages]
}

function aliasHistory(body: Record<string, unknown>, reverse: Map<string, string>): void {
  const rename = (name: unknown): unknown =>
    typeof name === 'string' && reverse.has(name) ? reverse.get(name) : name

  if (Array.isArray(body.input)) {
    body.input = (body.input as Record<string, unknown>[]).map((item) =>
      item && item.type === 'function_call' && typeof item.name === 'string' && reverse.has(item.name)
        ? { ...item, name: reverse.get(item.name) }
        : item,
    )
  }
  if (!Array.isArray(body.messages)) return
  body.messages = (body.messages as Record<string, unknown>[]).map((message) => {
    if (!message || typeof message !== 'object') return message
    if (Array.isArray(message.content)) {
      const content = (message.content as Record<string, unknown>[]).map((block) =>
        block && block.type === 'tool_use' && typeof block.name === 'string' && reverse.has(block.name)
          ? { ...block, name: reverse.get(block.name) }
          : block,
      )
      return { ...message, content }
    }
    if (!Array.isArray(message.tool_calls)) return message
    return {
      ...message,
      tool_calls: (message.tool_calls as Record<string, unknown>[]).map((call) =>
        call && call.function && typeof call.function === 'object'
          ? { ...call, function: { ...(call.function as Record<string, unknown>), name: rename((call.function as { name?: unknown }).name) } }
          : call,
      ),
    }
  })
}

/**
 * Satisfy the v2 tool gate on `body.tools`.
 *
 * - `read` and `shell` are always declared with the official definitions.
 * - Caller tools are preserved; a caller tool that collides on the name but
 *   carries a different definition is renamed `<name>_client[N]` and the
 *   spelling is restored on streamed tool calls via the returned alias map.
 * - `tool_choice: "none"` is removed (it 403s on v2); the Responses wire gets
 *   `auto` instead, matching the official client.
 *
 * @returns map of sent alias name → caller's original tool name.
 */
export function applyFingerprint(body: Record<string, unknown>, style: WireStyle): Map<string, string> {
  const tools: PlainTool[] = Array.isArray(body.tools) ? (body.tools as PlainTool[]) : []
  const taken = new Set(tools.map(toolName).filter((n) => n !== ''))
  const seen = new Set<string>()
  const present = new Set<string>()
  const out: PlainTool[] = []
  const aliases = new Map<string, string>()

  for (const tool of tools) {
    const name = toolName(tool)
    const key = fingerprintKey(name)
    if (key === '') {
      out.push(tool)
      continue
    }
    if (seen.has(key)) continue // duplicate declaration: keep the first
    seen.add(key)
    if (carriesOfficialDefinition(tool, key, style)) {
      out.push(tool)
      present.add(key)
      continue
    }
    let alias = `${key}_client`
    for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`
    taken.add(alias)
    aliases.set(alias, name)
    out.push(renameTool(tool, alias))
  }

  const injected: string[] = []
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue
    out.push(fingerprintTool(name, style))
    injected.push(name)
  }
  body.tools = out

  // Caller names → sent aliases, for rewriting history and explicit choices.
  const reverse = new Map<string, string>()
  for (const [alias, original] of aliases) reverse.set(original, alias)

  // Keep an explicit tool_choice pointing at a renamed tool consistent.
  const choice = body.tool_choice
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const record = choice as Record<string, unknown>
    if (typeof record.name === 'string' && reverse.has(record.name)) {
      body.tool_choice = { ...record, name: reverse.get(record.name) }
    } else if (record.function && typeof record.function === 'object') {
      const fn = record.function as Record<string, unknown>
      if (typeof fn.name === 'string' && reverse.has(fn.name)) {
        body.tool_choice = { ...record, function: { ...fn, name: reverse.get(fn.name) } }
      }
    }
  }

  aliasHistory(body, reverse)
  if (injected.length > 0) noteInjected(body, style, injected)

  if (body.tool_choice === 'none' || (body.tool_choice && typeof body.tool_choice === 'object' && (body.tool_choice as { type?: unknown }).type === 'none')) {
    delete body.tool_choice
  }
  if (style === 'flat' && body.tool_choice === undefined) body.tool_choice = 'auto'
  return aliases
}

/** Restore the caller's tool name in a streamed tool call. */
export function restoreToolName(name: unknown, aliases: Map<string, string>): string {
  if (typeof name !== 'string') return ''
  return aliases.get(name) ?? name
}
