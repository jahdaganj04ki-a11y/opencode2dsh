import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feedStream, type StreamResult } from '../src/stream.js'
import type { SseEvent } from '../src/http.js'
import type { StreamChunk } from '../src/types.js'

function eventsFrom(...raw: string[]): AsyncIterable<SseEvent> {
  const parsed: SseEvent[] = []
  for (const block of raw) {
    const lines = block.split(/\r?\n/)
    let event = 'message'
    const data: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length > 0) parsed.push({ event, data: data.join('\n') })
  }
  return (async function* (): AsyncGenerator<SseEvent> {
    for (const item of parsed) yield item
  })()
}

async function collect(
  wire: 'chat' | 'responses' | 'messages',
  raw: string[],
  aliases = new Map<string, string>(),
): Promise<{ chunks: StreamChunk[]; result: StreamResult }> {
  const chunks: StreamChunk[] = []
  const result = await feedStream(wire, eventsFrom(...raw), aliases, (chunk) => chunks.push(chunk))
  return { chunks, result }
}

test('chat wire: indexed text block, streamed tool call with alias restore, usage, tool-calls finish', async () => {
  const aliases = new Map([['shell_client', 'shell']])
  const { chunks, result } = await collect(
    'chat',
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'lo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell_client', arguments: '' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"com' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`,
      'data: [DONE]\n\n',
    ],
    aliases,
  )

  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(
    starts.map((c) => (c.type === 'block-start' ? c.blockType : null)),
    ['text', 'tool-call'],
  )
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c.type === 'text-delta' ? c.text : '')).join('')
  assert.equal(text, 'Hello')
  const toolDelta = chunks.find((c) => c.type === 'tool-call-delta' && c.type === 'tool-call-delta' && c.name === 'shell')
  assert.ok(toolDelta)
  const toolEnd = chunks.find((c) => c.type === 'block-end' && c.type === 'block-end' && c.block.type === 'tool-call') as
    | Extract<StreamChunk, { type: 'block-end' }>
    | undefined
  assert.equal((toolEnd?.block as { name: string }).name, 'shell')
  assert.equal((toolEnd?.block as { arguments: string }).arguments, '{"command":"ls"}')
  assert.equal(result.usage?.inputTokens, 11)
  assert.equal(result.usage?.reasoningTokens, 2)
  assert.equal(result.terminal, 'tool-calls')
  assert.equal(result.sawToolCalls, true)
})

test('chat wire: reasoning_content feeds a separate reasoning block; length cut maps to max-tokens', async () => {
  const { chunks, result } = await collect('chat', [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])
  assert.ok(chunks.some((c) => c.type === 'block-start' && c.type === 'block-start' && c.blockType === 'reasoning'))
  assert.equal(result.terminal, 'max-tokens')
  assert.equal(result.reasoningOnly, true)
})

test('responses wire: text, reasoning summary and function call items', async () => {
  const { chunks, result } = await collect('responses', [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created' })}\n\n`,
    `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'hmm' })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'answer' })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'fc_1', name: 'read', arguments: '' } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"p":1}' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 } } })}\n\n`,
    'data: [DONE]\n\n',
  ])
  assert.ok(chunks.some((c) => c.type === 'reasoning-delta'))
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c.type === 'text-delta' ? c.text : '')).join('')
  assert.equal(text, 'answer')
  assert.equal(result.terminal, 'tool-calls')
  assert.equal(result.usage?.inputTokens, 5)
})

test('responses wire: incomplete status maps to max-tokens', async () => {
  const { result } = await collect('responses', [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`,
  ])
  assert.equal(result.terminal, 'max-tokens')
  assert.equal(result.sawAnswer, true)
})

test('messages wire: anthropic blocks with explicit start/stop and signature', async () => {
  const { chunks, result } = await collect('messages', [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 4 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ])
  const reasoningEnd = chunks.find((c) => c.type === 'block-end' && c.type === 'block-end' && c.block.type === 'reasoning') as
    | Extract<StreamChunk, { type: 'block-end' }>
    | undefined
  assert.equal((reasoningEnd?.block as { signature?: string }).signature, 'sig-1')
  assert.equal(result.terminal, 'stop')
  assert.equal(result.usage?.inputTokens, 20)
  assert.equal(result.usage?.cacheReadTokens, 4)
  assert.equal(result.usage?.outputTokens, 6)
})

test('messages wire: tool_use stop reason maps to tool-calls', async () => {
  const { result } = await collect('messages', [
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })}\n\n`,
  ])
  assert.equal(result.terminal, 'tool-calls')
  assert.equal(result.sawToolCalls, true)
})

test('a stream error event throws a GatewayFailure', async () => {
  await assert.rejects(
    collect('chat', [`data: ${JSON.stringify({ error: { type: 'GatewayError', message: 'boom' } })}\n\n`]),
    /boom/,
  )
})
