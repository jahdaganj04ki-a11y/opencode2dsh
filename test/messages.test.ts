import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildRequestBody,
  estimateMessageTokens,
  repairToolPairing,
  MAX_IMAGE_BYTES,
  type ImageResolver,
} from '../src/messages.js'
import { GatewayFailure } from '../src/http.js'
import type { HarnessMessage, ImageAttachmentRef } from '../src/types.js'

const resolver: ImageResolver = {
  hostPath: (ref) => (ref.attachmentId === 'missing' ? undefined : join(tmpdir(), ref.attachmentId)),
}

test('repairToolPairing synthesizes missing calls and missing results', () => {
  const messages: HarnessMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    // Orphan result: no preceding assistant tool call.
    { role: 'tool', toolCallId: 'orphan', content: [{ type: 'text', text: 'result' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'open-1', name: 'shell', arguments: '{}' },
      ],
    },
  ]
  const repaired = repairToolPairing(messages)
  const roles = repaired.map((m) => m.role)
  assert.ok(roles.includes('assistant'))
  // Synthetic call inserted before the orphan result.
  const syntheticCall = repaired.find((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool-call' && b.id === 'orphan'))
  assert.ok(syntheticCall)
  // Interrupted result appended for the unanswered call.
  const closing = repaired[repaired.length - 1]
  assert.equal(closing?.role, 'tool')
  assert.equal(closing.toolCallId, 'open-1')
})

test('chat wire: system fold, tool calls and tool results serialize', () => {
  const built = buildRequestBody(
    'chat',
    'big-pickle',
    {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'shell', arguments: '{"command":"ls"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file.txt' }] },
      ],
      tools: [{ name: 'shell', description: 'd', parameters: { type: 'object' } }],
      maxTokens: 1024,
      stop: ['STOP'],
    },
    resolver,
  )
  assert.equal(built.body.stream, true)
  const messages = built.body.messages as Array<Record<string, unknown>>
  assert.equal(messages[0]?.role, 'system')
  const assistant = messages.find((m) => m.role === 'assistant')
  assert.ok(Array.isArray(assistant?.tool_calls))
  const toolResult = messages.find((m) => m.role === 'tool')
  assert.equal(toolResult?.tool_call_id, 'c1')
  assert.equal(built.body.max_tokens, 1024)
  assert.deepEqual(built.body.stop, ['STOP'])
})

test('responses wire: instructions, function_call items and output items', () => {
  const built = buildRequestBody(
    'responses',
    'muse-spark-1.3-contributor-free',
    {
      system: 'system prompt',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'fc1', name: 'read', arguments: '{"path":"x"}' }],
        },
        { role: 'tool', toolCallId: 'fc1', content: [{ type: 'text', text: 'contents' }] },
      ],
    },
    resolver,
  )
  assert.equal(built.body.instructions, 'system prompt')
  assert.equal(built.body.tool_choice, 'auto')
  const input = built.body.input as Array<Record<string, unknown>>
  assert.ok(input.some((i) => i.type === 'function_call' && i.call_id === 'fc1'))
  assert.ok(input.some((i) => i.type === 'function_call_output' && i.call_id === 'fc1'))
  // Responses has no stop parameter.
  assert.equal(built.body.stop, undefined)
})

test('messages wire: anthropic blocks, role alternation and required max_tokens', () => {
  const built = buildRequestBody(
    'messages',
    'union-alpha',
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'tu1', name: 'read', arguments: '{"path":"p"}' }],
        },
        { role: 'tool', toolCallId: 'tu1', isError: true, content: [{ type: 'text', text: 'nope' }] },
      ],
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
    },
    resolver,
  )
  const messages = built.body.messages as Array<Record<string, unknown>>
  // Same-role user messages merged.
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[1]?.role, 'assistant')
  assert.equal(messages[2]?.role, 'user')
  const toolResult = (messages[2]?.content as Array<Record<string, unknown>>)[0]
  assert.equal(toolResult?.type, 'tool_result')
  assert.equal(toolResult?.is_error, true)
  assert.equal(built.body.max_tokens, 4096)
  assert.ok(Array.isArray(built.body.tools) && (built.body.tools as unknown[]).length > 0)
})

test('images become data URLs on chat, input_image on responses, base64 source on messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-img-'))
  const file = join(dir, 'pic.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const localResolver: ImageResolver = { hostPath: () => file }
  const ref: ImageAttachmentRef = { attachmentId: 'pic.png' }
  const imageMessage: HarnessMessage = { role: 'user', content: [{ type: 'image', attachment: ref }] }

  const chat = buildRequestBody('chat', 'big-pickle', { messages: [imageMessage] }, localResolver)
  const chatPart = ((chat.body.messages as Array<Record<string, unknown>>)[0]?.content as unknown[])[0] as Record<string, unknown>
  assert.match(String((chatPart.image_url as Record<string, string>).url), /^data:image\/png;base64,/)

  const responses = buildRequestBody('responses', 'muse-spark-1.3-contributor-free', { messages: [imageMessage] }, localResolver)
  const input = (responses.body.input as Array<Record<string, unknown>>)[0]
  const imageItem = (input?.content as Array<Record<string, unknown>> | undefined)?.find((c) => c.type === 'input_image')
  assert.ok(imageItem)

  const anthropic = buildRequestBody('messages', 'union-alpha', { messages: [imageMessage] }, localResolver)
  const block = ((anthropic.body.messages as Array<Record<string, unknown>>)[0]?.content as unknown[])[0] as Record<string, unknown>
  assert.equal((block.source as Record<string, unknown>).type, 'base64')
})

test('oversized and offloaded images ask the host to offload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-big-'))
  const file = join(dir, 'big.png')
  writeFileSync(file, Buffer.alloc(MAX_IMAGE_BYTES + 1))
  const bigResolver: ImageResolver = { hostPath: () => file }
  assert.throws(
    () => buildRequestBody('chat', 'big-pickle', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'big.png' } }] }] }, bigResolver),
    (error: unknown) => error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED',
  )
  assert.throws(
    () => buildRequestBody('chat', 'big-pickle', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' }, offloaded: true }] }] }, resolver),
    (error: unknown) => error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED',
  )
})

test('estimateMessageTokens counts text, calls and images', () => {
  const tokens = estimateMessageTokens([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: '1', name: 'n', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha' } }] },
  ])
  assert.ok(tokens > 1200)
})
