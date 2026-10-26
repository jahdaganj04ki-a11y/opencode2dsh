import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyFingerprint,
  canonicalizeSession,
  isCanonicalSession,
  mintSessionId,
  restoreToolName,
  sessionForConversation,
} from '../src/fingerprint.js'

test('mintSessionId yields gate-shaped descending sessions, unique per ms counter', () => {
  const fixed = 1_761_500_000_000
  const ids = new Set<string>()
  for (let i = 1; i <= 10; i += 1) {
    const id = mintSessionId(fixed)
    assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.ok(isCanonicalSession(id), `${id} must validate`)
    ids.add(id)
  }
  assert.equal(ids.size, 10)
  // Counter 1 lands on low bits 0xffe; every mint keeps the 0xfc0–0xfff window.
  for (const id of ids) {
    const low12 = id.slice(13, 16)
    assert.ok(/f[c-f][0-9a-f]/.test(low12))
  }
})

test('canonicalizeSession is deterministic and gate-valid', () => {
  const a = canonicalizeSession('conversation-42')
  const b = canonicalizeSession('conversation-42')
  const c = canonicalizeSession('conversation-43')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(isCanonicalSession(a))
})

test('sessionForConversation passes canonical ids through and memoizes the rest', () => {
  const canonical = mintSessionId()
  assert.equal(sessionForConversation(canonical), canonical.trim())
  const first = sessionForConversation('harness-session-abc')
  const second = sessionForConversation('harness-session-abc')
  assert.equal(first, second)
  assert.ok(isCanonicalSession(first))
  assert.equal(sessionForConversation(undefined), sessionForConversation(''))
})

test('applyFingerprint injects read/shell with the official definitions on chat wire', () => {
  const body: Record<string, unknown> = {
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object' } } }],
  }
  const aliases = applyFingerprint(body, 'chat')
  assert.equal(aliases.size, 0)
  const tools = body.tools as Array<{ function?: { name: string } }>
  const names = tools.map((t) => t.function?.name).sort()
  assert.deepEqual(names, ['lookup', 'read', 'shell'])
  // Injected tools get a placeholder system note.
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.equal(messages[0]?.role, 'system')
  assert.match(messages[0]?.content ?? '', /placeholder/)
  assert.notEqual(body.tool_choice, 'none')
})

test('applyFingerprint renames colliding caller tools and records aliases', () => {
  const body: Record<string, unknown> = {
    messages: [],
    tools: [
      { type: 'function', function: { name: 'read', description: 'my own read', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'shell', description: 'my own shell', parameters: { type: 'object', properties: {} } } },
    ],
  }
  const aliases = applyFingerprint(body, 'chat')
  assert.equal(aliases.get('read_client'), 'read')
  assert.equal(aliases.get('shell_client'), 'shell')
  const tools = body.tools as Array<{ function: { name: string; description: string } }>
  const official = tools.find((t) => t.function.name === 'read')
  assert.ok(official)
  assert.match(official.function.description, /Read the contents of a file/)
  assert.equal(restoreToolName('read_client', aliases), 'read')
  assert.equal(restoreToolName('lookup', aliases), 'lookup')
})

test('applyFingerprint removes tool_choice none; flat wire defaults to auto', () => {
  const chat = { messages: [], tool_choice: 'none' }
  applyFingerprint(chat, 'chat')
  assert.equal(chat.tool_choice, undefined)

  const flat = { messages: [], tool_choice: { type: 'none' } }
  applyFingerprint(flat, 'flat')
  assert.equal(flat.tool_choice, 'auto')
})

test('applyFingerprint speaks claude input_schema and rewrites tool_use history', () => {
  const body: Record<string, unknown> = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }],
      },
    ],
    tools: [
      { name: 'read', description: 'caller read with a different schema', input_schema: { type: 'object' } },
    ],
  }
  const aliases = applyFingerprint(body, 'claude')
  const tools = body.tools as Array<{ name: string; input_schema: unknown }>
  assert.ok(tools.some((t) => t.name === 'read' && t.input_schema))
  // Colliding history `read` was renamed to the alias spelling.
  const history = body.messages as Array<{ content: Array<{ name: string }> }>
  const renamed = history[0]?.content[0]?.name ?? ''
  assert.ok(renamed.startsWith('read_client'))
  assert.equal(aliases.get(renamed), 'read')
})

test('applyFingerprint rewrites Responses function_call history items', () => {
  const body: Record<string, unknown> = {
    input: [{ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }],
    tools: [
      { type: 'function', name: 'shell', description: 'caller shell with a different schema', parameters: { type: 'object' } },
    ],
  }
  const aliases = applyFingerprint(body, 'flat')
  const input = body.input as Array<{ name: string }>
  const firstName = input[0]?.name ?? ''
  assert.ok(firstName.startsWith('shell_client'))
  assert.equal(aliases.get(firstName), 'shell')
})
