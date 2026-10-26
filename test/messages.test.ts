import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildRequestBody,
  estimateMessageTokens,
  repairToolPairing,
  MAX_IMAGE_BYTES,
  type ImageSource,
} from '../src/messages.js'
import { GatewayFailure } from '../src/http.js'
import type { HarnessMessage, ImageAttachmentRef } from '../src/types.js'

const resolver: ImageSource = {
  load: async (ref) => {
    if (ref.attachmentId === 'missing') return undefined
    const path = join(tmpdir(), ref.attachmentId)
    if (!existsSync(path)) return undefined
    return { mediaType: ref.mediaType ?? 'image/png', data: readFileSync(path) }
  },
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

test('chat wire: system fold, tool calls and tool results serialize', async () => {
  const built = await buildRequestBody(
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

test('responses wire: instructions, function_call items and output items', async () => {
  const built = await buildRequestBody(
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

test('messages wire: anthropic blocks, role alternation and required max_tokens', async () => {
  const built = await buildRequestBody(
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

test('images become data URLs on chat, input_image on responses, base64 source on messages', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const localResolver: ImageSource = {
    load: async () => ({ mediaType: 'image/png', data: bytes }),
  }
  const ref: ImageAttachmentRef = { attachmentId: 'pic.png', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  const imageMessage: HarnessMessage = { role: 'user', content: [{ type: 'image', attachment: ref }] }

  const chat = await buildRequestBody('chat', 'big-pickle', { messages: [imageMessage] }, localResolver)
  const chatPart = ((chat.body.messages as Array<Record<string, unknown>>)[0]?.content as unknown[])[0] as Record<string, unknown>
  assert.match(String((chatPart.image_url as Record<string, string>).url), /^data:image\/png;base64,/)

  const responses = await buildRequestBody('responses', 'muse-spark-1.3-contributor-free', { messages: [imageMessage] }, localResolver)
  const input = (responses.body.input as Array<Record<string, unknown>>)[0]
  const imageItem = (input?.content as Array<Record<string, unknown>> | undefined)?.find((c) => c.type === 'input_image')
  assert.ok(imageItem)

  const anthropic = await buildRequestBody('messages', 'union-alpha', { messages: [imageMessage] }, localResolver)
  const block = ((anthropic.body.messages as Array<Record<string, unknown>>)[0]?.content as unknown[])[0] as Record<string, unknown>
  assert.equal((block.source as Record<string, unknown>).type, 'base64')
})

test('oversized, unresolvable and offloaded images ask the host to offload one occurrence', async () => {
  const bigResolver: ImageSource = {
    load: async () => ({ mediaType: 'image/png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
  }
  const isSingleOffload = (error: unknown): boolean =>
    error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.offloadImages === 1
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'big.png' } }] }] }, bigResolver),
    isSingleOffload,
  )
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] }] }, resolver),
    isSingleOffload,
  )
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' }, offloaded: true }] }] }, resolver),
    isSingleOffload,
  )
})

test('an unresolvable image names every occurrence up to its earliest position', async () => {
  const source: ImageSource = {
    load: async (ref) => (ref.attachmentId === 'missing' ? undefined : { mediaType: 'image/png', data: Buffer.alloc(1024) }),
  }
  const messages: HarnessMessage[] = [{
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: 'ok-1' } },
      { type: 'image', attachment: { attachmentId: 'missing' } },
      { type: 'image', attachment: { attachmentId: 'ok-2' } },
    ],
  }]
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages }, source),
    (error: unknown) => error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.offloadImages === 2,
  )
})

test('the combined image budget reports the host-exact prefix count of oldest occurrences', async () => {
  // Three images of 7 MiB raw each: every one passes the per-image ceiling,
  // yet 21 MiB total exceeds the 16 MiB request ceiling once base64-encoded.
  const perImage = 7 * 1024 * 1024
  const source: ImageSource = {
    load: async () => ({ mediaType: 'image/png', data: Buffer.alloc(perImage, 1) }),
  }
  const messages: HarnessMessage[] = [{
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ],
  }]
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages }, source),
    (error: unknown) => error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.offloadImages === 1,
  )
})

test('repeated occurrences of one attachment each count toward the offload budget', async () => {
  const perImage = 7 * 1024 * 1024
  const source: ImageSource = {
    load: async () => ({ mediaType: 'image/png', data: Buffer.alloc(perImage, 1) }),
  }
  const messages: HarnessMessage[] = [{
    role: 'user',
    // Same attachment id three times: loaded once, counted three times.
    content: [
      { type: 'image', attachment: { attachmentId: 'repeat' } },
      { type: 'image', attachment: { attachmentId: 'repeat' } },
      { type: 'image', attachment: { attachmentId: 'repeat' } },
    ],
  }]
  await assert.rejects(
    buildRequestBody('chat', 'big-pickle', { messages }, source),
    (error: unknown) => error instanceof GatewayFailure && error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.offloadImages === 1,
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
