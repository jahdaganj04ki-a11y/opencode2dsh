/**
 * Gateway SSE → harness StreamChunk feeders for the three wires.
 *
 * All three feeders write through one `BlockSink` with flat block indices
 * allocated in first-seen order (the harness contract wants one contiguous
 * index space, not per-type numbering). The sink emits `block-start` lazily,
 * accumulates deltas, and emits `block-end` with the assembled block; tool-call
 * names pass back through the fingerprint alias map so the caller sees its own
 * tool names even when a collision forced `_client[N]` renaming upstream.
 *
 * Each feeder resolves to a `StreamResult` describing how the turn ended; the
 * adapter uses that — not the chunk stream — to decide on a continuation.
 */

import { GatewayFailure, CODE, isDoneMarker, type SseEvent } from './http.js'
import { restoreToolName } from './fingerprint.js'
import type { ContentBlock, StreamChunk, TokenUsage } from './types.js'
import type { WireKind } from './capabilities.js'

export type TerminalKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | 'unknown'

export interface StreamResult {
  terminal: TerminalKind
  /** Raw provider stop reason, retained for diagnostics. */
  stopReason?: string
  /** Non-empty visible text was produced. */
  sawAnswer: boolean
  sawToolCalls: boolean
  /** Only reasoning deltas arrived (a "silent stop"). */
  reasoningOnly: boolean
  usage?: TokenUsage
  failure?: GatewayFailure
}

interface AssembledBlock {
  blockType: 'text' | 'reasoning' | 'tool-call'
  text: string
  reasoningSignature?: string
  toolId?: string
  toolName?: string
  closed: boolean
}

class BlockSink {
  private readonly blocks: AssembledBlock[] = []
  private textBlock = -1
  private reasoningBlock = -1
  private readonly toolBlocks = new Map<string, number>()

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  private open(blockType: AssembledBlock['blockType']): number {
    const index = this.blocks.length
    this.blocks.push({ blockType, text: '', closed: false })
    this.emit({ type: 'block-start', index, blockType })
    return index
  }

  private at(index: number): AssembledBlock {
    const block = this.blocks[index]
    if (!block) throw new Error(`BlockSink index ${index} was never opened`)
    return block
  }

  textIndex(): number {
    if (this.textBlock === -1) this.textBlock = this.open('text')
    return this.textBlock
  }

  reasoningIndex(): number {
    if (this.reasoningBlock === -1) this.reasoningBlock = this.open('reasoning')
    return this.reasoningBlock
  }

  toolIndex(id: string, name?: string): number {
    const existing = this.toolBlocks.get(id)
    if (existing !== undefined) {
      if (name) this.setToolName(existing, name)
      return existing
    }
    const index = this.open('tool-call')
    this.toolBlocks.set(id, index)
    const block = this.at(index)
    block.toolId = id
    if (name) block.toolName = name
    this.emit({ type: 'tool-call-delta', index, id, ...(name ? { name } : {}), argumentsDelta: '' })
    return index
  }

  appendText(text: string): void {
    if (!text) return
    const index = this.textIndex()
    this.at(index).text += text
    this.emit({ type: 'text-delta', index, text })
  }

  appendReasoning(text: string): void {
    if (!text) return
    const index = this.reasoningIndex()
    this.at(index).text += text
    this.emit({ type: 'reasoning-delta', index, text })
  }

  setReasoningSignature(signature: string): void {
    if (!signature) return
    const index = this.reasoningIndex()
    this.at(index).reasoningSignature = signature
  }

  setToolName(index: number, name: string): void {
    const block = this.at(index)
    if (block.blockType !== 'tool-call') return
    if (!block.toolName) {
      block.toolName = name
      this.emit({ type: 'tool-call-delta', index, id: block.toolId ?? '', name, argumentsDelta: '' })
    } else {
      block.toolName = name
    }
  }

  appendToolArgs(id: string, delta: string, name?: string): void {
    if (!delta && !name) return
    const index = this.toolIndex(id, name)
    if (delta) {
      this.at(index).text += delta
      this.emit({ type: 'tool-call-delta', index, id, argumentsDelta: delta })
    }
  }

  private assemble(index: number): ContentBlock {
    const block = this.at(index)
    if (block.blockType === 'text') return { type: 'text', text: block.text }
    if (block.blockType === 'reasoning') {
      return {
        type: 'reasoning',
        text: block.text,
        ...(block.reasoningSignature ? { signature: block.reasoningSignature } : {}),
      }
    }
    return {
      type: 'tool-call',
      id: block.toolId ?? `call_${index}`,
      name: block.toolName ?? 'unknown',
      arguments: block.text,
    }
  }

  close(index: number): void {
    const block = this.blocks[index]
    if (!block || block.closed) return
    block.closed = true
    this.emit({ type: 'block-end', index, block: this.assemble(index) })
  }

  /** Whether any block (open or closed) currently holds content. */
  get hasContent(): boolean {
    return this.blocks.some((b) => b.text.length > 0 || b.blockType === 'tool-call')
  }

  closeAll(): void {
    for (let i = 0; i < this.blocks.length; i += 1) this.close(i)
  }

  /** Snapshot of assembled blocks so a continuation can replay the turn. */
  exportBlocks(): ContentBlock[] {
    return this.blocks.map((_, index) => this.assemble(index))
  }

  get empty(): boolean {
    return this.blocks.every((b) => b.text.length === 0 && b.blockType !== 'tool-call') && this.toolBlocks.size === 0
  }

  get hasText(): boolean {
    return this.textBlock !== -1 && this.at(this.textBlock).text.trim().length > 0
  }

  get hasReasoning(): boolean {
    return this.reasoningBlock !== -1 && this.at(this.reasoningBlock).text.trim().length > 0
  }

  get toolCount(): number {
    return this.toolBlocks.size
  }
}

// ── Usage mapping ────────────────────────────────────────────────────────────

function mapChatUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const promptDetails = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = (raw.completion_tokens_details ?? {}) as Record<string, unknown>
  const input = numberOr(raw.prompt_tokens, 0)
  const output = numberOr(raw.completion_tokens, 0)
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: numberOr(raw.total_tokens, input + output),
    cacheReadTokens: optionalNumber(promptDetails.cached_tokens),
    reasoningTokens: optionalNumber(completionDetails.reasoning_tokens),
  }
}

function mapResponsesUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const inputDetails = (raw.input_tokens_details ?? {}) as Record<string, unknown>
  const outputDetails = (raw.output_tokens_details ?? {}) as Record<string, unknown>
  const input = numberOr(raw.input_tokens, 0)
  const output = numberOr(raw.output_tokens, 0)
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: numberOr(raw.total_tokens, input + output),
    cacheReadTokens: optionalNumber(inputDetails.cached_tokens),
    reasoningTokens: optionalNumber(outputDetails.reasoning_tokens),
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ── Feeders ──────────────────────────────────────────────────────────────────

async function feedChat(
  events: AsyncIterable<SseEvent>,
  sink: BlockSink,
  aliases: Map<string, string>,
): Promise<StreamResult> {
  const result: StreamResult = { terminal: 'unknown', sawAnswer: false, sawToolCalls: false, reasoningOnly: false }
  const upstreamTools = new Map<number, number>()
  const upstreamIds = new Map<number, string>()
  let usage: TokenUsage | undefined

  for await (const event of events) {
    if (isDoneMarker(event.data)) break
    const payload = parseJson(event.data)
    if (!payload) continue
    if (payload.error) throw envelopeFailure(payload.error)

    if (payload.usage) usage = mapChatUsage(payload.usage as Record<string, unknown>)
    const choice = (payload.choices as Record<string, unknown>[] | undefined)?.[0]
    if (!choice) continue
    const delta = (choice.delta ?? {}) as Record<string, unknown>

    if (typeof delta.reasoning_content === 'string') sink.appendReasoning(delta.reasoning_content)
    if (typeof delta.reasoning === 'string') sink.appendReasoning(delta.reasoning)
    if (typeof delta.content === 'string') sink.appendText(delta.content)

    const calls = delta.tool_calls as Record<string, unknown>[] | undefined
      if (Array.isArray(calls)) {
        for (const call of calls) {
          const upstreamIndex = typeof call.index === 'number' ? call.index : 0
          const fn = (call.function ?? {}) as Record<string, unknown>
          if (typeof call.id === 'string') upstreamIds.set(upstreamIndex, call.id)
          const id = upstreamIds.get(upstreamIndex) ?? `call_${upstreamIndex}`
          let blockIndex = upstreamTools.get(upstreamIndex)
          if (blockIndex === undefined) {
            const name = typeof fn.name === 'string' ? restoreToolName(fn.name, aliases) : undefined
            blockIndex = sink.toolIndex(id, name)
            upstreamTools.set(upstreamIndex, blockIndex)
          } else if (typeof fn.name === 'string') {
            sink.setToolName(blockIndex, restoreToolName(fn.name, aliases))
          }
          if (typeof fn.arguments === 'string') {
            sink.appendToolArgs(id, fn.arguments)
          }
        }
      }

    if (typeof choice.finish_reason === 'string') {
      result.stopReason = choice.finish_reason
      result.terminal = mapChatFinish(choice.finish_reason)
    }
  }

  sink.closeAll()
  finalizeResult(result, sink, usage)
  return result
}

function mapChatFinish(reason: string): TerminalKind {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool-calls'
  if (reason === 'length') return 'max-tokens'
  if (reason === 'content_filter') return 'error'
  if (reason === 'abort' || reason === 'cancelled') return 'aborted'
  return 'stop'
}

async function feedResponses(
  events: AsyncIterable<SseEvent>,
  sink: BlockSink,
  aliases: Map<string, string>,
): Promise<StreamResult> {
  const result: StreamResult = { terminal: 'unknown', sawAnswer: false, sawToolCalls: false, reasoningOnly: false }
  const itemTools = new Map<string, string>()
  let usage: TokenUsage | undefined
  let status: string | undefined
  let incompleteReason: string | undefined

  for await (const event of events) {
    if (isDoneMarker(event.data)) break
    const payload = parseJson(event.data)
    if (!payload) continue
    const type = typeof payload.type === 'string' ? payload.type : event.event
    if (payload.error) throw envelopeFailure(payload.error)

    switch (type) {
      case 'response.output_text.delta':
      case 'response.text.delta':
        if (typeof payload.delta === 'string') sink.appendText(payload.delta)
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning.delta':
        if (typeof payload.delta === 'string') sink.appendReasoning(payload.delta)
        break
      case 'response.reasoning_summary_part.delta':
        if (typeof payload.delta === 'string') sink.appendReasoning(payload.delta)
        break
      case 'response.output_item.added':
      case 'response.output_item.updated': {
        const item = payload.item as Record<string, unknown> | undefined
        if (item && item.type === 'function_call') {
          const id = String(item.call_id ?? item.id ?? '')
          const name = typeof item.name === 'string' ? restoreToolName(item.name, aliases) : undefined
          if (id) {
            sink.toolIndex(id, name)
            itemTools.set(id, id)
            if (typeof item.arguments === 'string' && item.arguments) sink.appendToolArgs(id, item.arguments)
          }
        }
        break
      }
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done': {
        const id = String(payload.item_id ?? payload.call_id ?? '')
        const delta = typeof payload.delta === 'string' ? payload.delta : typeof payload.arguments === 'string' ? payload.arguments : ''
        if (id && delta) sink.appendToolArgs(id, delta)
        break
      }
      case 'response.completed': {
        const response = payload.response as Record<string, unknown> | undefined
        if (response) {
          status = typeof response.status === 'string' ? response.status : status
          const details = response.incomplete_details as Record<string, unknown> | undefined
          if (details?.reason) incompleteReason = String(details.reason)
          if (response.usage) usage = mapResponsesUsage(response.usage as Record<string, unknown>)
        }
        break
      }
      case 'response.failed':
      case 'response.incomplete': {
        const response = payload.response as Record<string, unknown> | undefined
        if (response?.status === 'incomplete') {
          status = 'incomplete'
          const details = response.incomplete_details as Record<string, unknown> | undefined
          if (details?.reason) incompleteReason = String(details.reason)
        }
        if (response?.error) throw envelopeFailure(response.error)
        break
      }
      default:
        break
    }
  }

  if (status === 'incomplete' || /max_output_tokens|token_limit|length/i.test(incompleteReason ?? '')) {
    result.terminal = 'max-tokens'
    result.stopReason = incompleteReason ?? 'incomplete'
  } else if (sink.toolCount > 0) {
    result.terminal = 'tool-calls'
  } else if (result.terminal === 'unknown') {
    result.terminal = 'stop'
  }
  sink.closeAll()
  finalizeResult(result, sink, usage)
  return result
}

async function feedMessages(
  events: AsyncIterable<SseEvent>,
  sink: BlockSink,
  aliases: Map<string, string>,
): Promise<StreamResult> {
  const result: StreamResult = { terminal: 'unknown', sawAnswer: false, sawToolCalls: false, reasoningOnly: false }
  const blockMap = new Map<number, number>()
  const toolIds = new Map<number, string>()
  let inputTokens = 0
  let cacheRead: number | undefined
  let outputTokens = 0
  let reasoningTokens: number | undefined
  let stopReason: string | undefined

  const ensureBlock = (upstreamIndex: number, blockType: 'text' | 'reasoning' | 'tool-call', id?: string, name?: string): number => {
    const existing = blockMap.get(upstreamIndex)
    if (existing !== undefined) return existing
    let index: number
    if (blockType === 'tool-call') {
      const toolId = id ?? `toolu_${upstreamIndex}`
      toolIds.set(upstreamIndex, toolId)
      index = sink.toolIndex(toolId, name)
    } else if (blockType === 'reasoning') {
      index = sink.reasoningIndex()
    } else {
      index = sink.textIndex()
    }
    blockMap.set(upstreamIndex, index)
    return index
  }

  for await (const event of events) {
    if (isDoneMarker(event.data)) break
    const payload = parseJson(event.data)
    if (!payload) continue
    const type = typeof payload.type === 'string' ? payload.type : event.event

    switch (type) {
      case 'message_start': {
        const message = payload.message as Record<string, unknown> | undefined
        const usage = message?.usage as Record<string, unknown> | undefined
        if (usage) {
          inputTokens = numberOr(usage.input_tokens, 0)
          cacheRead = optionalNumber(usage.cache_read_input_tokens)
          reasoningTokens = optionalNumber(usage.cache_creation_input_tokens)
        }
        break
      }
      case 'content_block_start': {
        const upstreamIndex = typeof payload.index === 'number' ? payload.index : 0
        const content = payload.content_block as Record<string, unknown> | undefined
        if (!content) break
        if (content.type === 'text') ensureBlock(upstreamIndex, 'text')
        else if (content.type === 'thinking') {
          const index = ensureBlock(upstreamIndex, 'reasoning')
          if (typeof content.thinking === 'string') sink.appendReasoning(content.thinking)
          void index
        } else if (content.type === 'tool_use') {
          const id = String(content.id ?? `toolu_${upstreamIndex}`)
          const name = typeof content.name === 'string' ? restoreToolName(content.name, aliases) : undefined
          ensureBlock(upstreamIndex, 'tool-call', id, name)
          if (typeof content.input === 'string' && content.input) sink.appendToolArgs(id, content.input)
        }
        break
      }
      case 'content_block_delta': {
        const upstreamIndex = typeof payload.index === 'number' ? payload.index : 0
        const delta = payload.delta as Record<string, unknown> | undefined
        if (!delta) break
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          ensureBlock(upstreamIndex, 'text')
          sink.appendText(delta.text)
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          ensureBlock(upstreamIndex, 'reasoning')
          sink.appendReasoning(delta.thinking)
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const id = toolIds.get(upstreamIndex)
          if (id) sink.appendToolArgs(id, delta.partial_json)
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          ensureBlock(upstreamIndex, 'reasoning')
          sink.setReasoningSignature(delta.signature)
        }
        break
      }
      case 'content_block_stop': {
        const upstreamIndex = typeof payload.index === 'number' ? payload.index : 0
        const index = blockMap.get(upstreamIndex)
        if (index !== undefined) sink.close(index)
        break
      }
      case 'message_delta': {
        const delta = payload.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) stopReason = String(delta.stop_reason)
        const usage = payload.usage as Record<string, unknown> | undefined
        if (usage) outputTokens = numberOr(usage.output_tokens, outputTokens)
        break
      }
      case 'error':
        throw envelopeFailure(payload.error ?? payload)
      case 'message_stop':
        break
      default:
        break
    }
  }

  if (stopReason === 'tool_use') result.terminal = 'tool-calls'
  else if (stopReason === 'max_tokens') result.terminal = 'max-tokens'
  else if (stopReason === 'stop_sequence' || stopReason === 'end_turn' || !stopReason) result.terminal = 'stop'
  else result.terminal = 'unknown'
  result.stopReason = stopReason

  sink.closeAll()
  finalizeResult(result, sink, {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens: reasoningTokens } : {}),
  })
  return result
}

function finalizeResult(result: StreamResult, sink: BlockSink, usage: TokenUsage | undefined): void {
  result.sawAnswer = sink.hasText
  result.sawToolCalls = sink.toolCount > 0
  result.reasoningOnly = !sink.hasText && sink.hasReasoning && sink.toolCount === 0
  result.usage = usage
  if (sink.empty && result.terminal === 'unknown') result.terminal = 'stop'
}

function parseJson(data: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function envelopeFailure(error: unknown): GatewayFailure {
  const record = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : 'Gateway reported a stream error.'
  const type = typeof record.type === 'string' ? record.type : ''
  if (/rate|usage|quota/i.test(type)) return new GatewayFailure(message, CODE.QUOTA, undefined, undefined, undefined, false)
  return new GatewayFailure(message, CODE.STREAM_CLOSED, undefined, undefined, undefined, true)
}

/** Allocate a sink manually when one turn spans multiple gateway attempts. */
export function createBlockSink(emit: (chunk: StreamChunk) => void): BlockSink {
  return new BlockSink(emit)
}

export type { BlockSink }

/**
 * Consume one open gateway stream, emitting harness chunks through `emit`.
 * Resolves with the terminal summary the adapter needs for continuation logic.
 * Pass an existing sink when the turn continues after a first attempt.
 */
export async function feedStream(
  wire: WireKind,
  events: AsyncIterable<SseEvent>,
  aliases: Map<string, string>,
  emit: (chunk: StreamChunk) => void,
  sink?: BlockSink,
): Promise<StreamResult> {
  const active = sink ?? new BlockSink(emit)
  if (wire === 'chat') return feedChat(events, active, aliases)
  if (wire === 'responses') return feedResponses(events, active, aliases)
  return feedMessages(events, active, aliases)
}
