/**
 * Harness message vocabulary → the three gateway wire formats.
 *
 * One conversation history is converted per call into either:
 *  - `chat`      → OpenAI Chat Completions (`/inference/v1/chat/completions`)
 *  - `responses` → OpenAI Responses        (`/inference/v1/responses`)
 *  - `messages`  → Anthropic Messages      (`/inference/v1/messages`)
 *
 * Two repairs run before serialization, both mandatory on this gateway:
 *  1. tool-call / tool-result pairing — an orphan result or an unanswered call
 *     makes strict upstreams 400, and harness histories contain both after
 *     compaction and interrupted turns;
 *  2. image resolution — host attachment path → base64 data URL, with an 8 MB
 *     ceiling that asks the host to offload instead of bloating the request.
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { GatewayFailure, CODE } from './http.js'
import type {
  ContentBlock,
  HarnessMessage,
  ImageBlock,
  ImageAttachmentRef,
  ToolCallBlock,
  ToolSchema,
} from './types.js'
import type { WireKind } from './capabilities.js'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const INTERRUPTED_RESULT = 'Tool execution was interrupted before its result was recorded.'

export interface ImageResolver {
  /** Absolute host path for an attachment ref, or undefined when unavailable. */
  hostPath(ref: ImageAttachmentRef): string | undefined
}

interface ResolvedImage {
  mediaType: string
  dataUrl: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

function resolveImage(block: ImageBlock, resolver: ImageResolver): ResolvedImage {
  if (block.offloaded) {
    throw new GatewayFailure('Image was offloaded by the host and cannot be re-read.', CODE.OFFLOAD)
  }
  const path = resolver.hostPath(block.attachment)
  if (!path) {
    throw new GatewayFailure('Image attachment has no resolvable host path.', CODE.OFFLOAD)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new GatewayFailure(`Image attachment is unreadable at ${path}.`, CODE.OFFLOAD)
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayFailure(
      `Image attachment exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB gateway ceiling.`,
      CODE.OFFLOAD,
    )
  }
  const mediaType =
    block.attachment.mediaType && /^image\/[a-z0-9.+-]+$/i.test(block.attachment.mediaType)
      ? block.attachment.mediaType.toLowerCase()
      : (MIME_BY_EXT[extname(path).toLowerCase()] ?? 'image/png')
  return { mediaType, dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}` }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

function reasoningOf(blocks: ContentBlock[]): { text: string; signature?: string } | undefined {
  const parts = blocks.filter((b): b is { type: 'reasoning'; text: string; signature?: string } => b.type === 'reasoning')
  if (parts.length === 0) return undefined
  const text = parts.map((p) => p.text).filter(Boolean).join('\n\n')
  const signature = parts.map((p) => p.signature).find((s): s is string => typeof s === 'string' && s.length > 0)
  return { text, signature }
}

function toolCallsOf(blocks: ContentBlock[]): ToolCallBlock[] {
  return blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
}

// ── Pairing repair ──────────────────────────────────────────────────────────

interface NormalizedMessage {
  role: HarnessMessage['role']
  blocks: ContentBlock[]
  toolCallId?: string
  isError?: boolean
}

/**
 * Return a history where every tool call has exactly one result and every
 * result has a preceding call. Synthetic filler carries obvious wording so the
 * model never mistakes it for a real observation.
 */
export function repairToolPairing(messages: HarnessMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = []
  const openCalls = new Map<string, true>()

  const pushSyntheticCall = (callId: string): void => {
    out.push({
      role: 'assistant',
      blocks: [
        { type: 'text', text: '' },
        { type: 'tool-call', id: callId, name: 'unknown', arguments: '{}' } satisfies ToolCallBlock,
      ],
    })
    openCalls.set(callId, true)
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId
      if (typeof callId !== 'string' || callId.length === 0) continue
      if (!openCalls.has(callId)) pushSyntheticCall(callId)
      out.push({ role: 'tool', blocks: message.content, toolCallId: callId, isError: message.isError })
      openCalls.delete(callId)
      continue
    }
    if (message.role === 'assistant') {
      for (const call of toolCallsOf(message.content)) openCalls.set(call.id, true)
    }
    out.push({ role: message.role, blocks: message.content })
  }

  if (openCalls.size > 0) {
    for (const callId of openCalls.keys()) {
      out.push({
        role: 'tool',
        toolCallId: callId,
        isError: true,
        blocks: [{ type: 'text', text: INTERRUPTED_RESULT }],
      })
    }
  }
  return out.filter((m) => m.blocks.length > 0 || m.role === 'tool')
}

// ── Chat Completions wire ───────────────────────────────────────────────────

type ChatMessage = Record<string, unknown>

function chatContent(message: NormalizedMessage, resolver: ImageResolver): string | Record<string, unknown>[] {
  const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image')
  const text = textOf(message.blocks)
  if (images.length === 0) return text
  const parts: Record<string, unknown>[] = []
  if (text) parts.push({ type: 'text', text })
  for (const image of images) {
    const resolved = resolveImage(image, resolver)
    parts.push({ type: 'image_url', image_url: { url: resolved.dataUrl } })
  }
  return parts
}

function toChatMessages(history: NormalizedMessage[], systemPrompt: string, resolver: ImageResolver): ChatMessage[] {
  const out: ChatMessage[] = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })

  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.blocks)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: chatContent(message, resolver) })
      continue
    }
    if (message.role === 'assistant') {
      const calls = toolCallsOf(message.blocks)
      const entry: ChatMessage = { role: 'assistant', content: textOf(message.blocks) || null }
      const reasoning = reasoningOf(message.blocks)
      if (reasoning?.text) entry.reasoning_content = reasoning.text
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        }))
      }
      out.push(entry)
      continue
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: textOf(message.blocks) || INTERRUPTED_RESULT,
      })
    }
  }
  return out
}

function chatTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

// ── Responses wire ──────────────────────────────────────────────────────────

type ResponsesItem = Record<string, unknown>

function responsesContent(message: NormalizedMessage, resolver: ImageResolver, role: 'user' | 'assistant'): Record<string, unknown>[] {
  const textType = role === 'user' ? 'input_text' : 'output_text'
  const parts: Record<string, unknown>[] = []
  const text = textOf(message.blocks)
  if (text) parts.push({ type: textType, text })
  if (role === 'user') {
    for (const image of message.blocks.filter((b): b is ImageBlock => b.type === 'image')) {
      const resolved = resolveImage(image, resolver)
      parts.push({ type: 'input_image', image_url: resolved.dataUrl })
    }
  }
  return parts
}

function toResponsesInput(history: NormalizedMessage[], resolver: ImageResolver): ResponsesItem[] {
  const input: ResponsesItem[] = []
  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') continue // folded into instructions
    if (message.role === 'user') {
      input.push({ type: 'message', role: 'user', content: responsesContent(message, resolver, 'user') })
      continue
    }
    if (message.role === 'assistant') {
      const content = responsesContent(message, resolver, 'assistant')
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content })
      const reasoning = reasoningOf(message.blocks)
      if (reasoning?.text) {
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: reasoning.text }],
          ...(reasoning.signature ? { encrypted_content: reasoning.signature } : {}),
        })
      }
      for (const call of toolCallsOf(message.blocks)) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments || '{}' })
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: textOf(message.blocks) || INTERRUPTED_RESULT,
      })
    }
  }
  return input
}

function responsesTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

// ── Anthropic Messages wire ─────────────────────────────────────────────────

type AnthropicBlock = Record<string, unknown>

function anthropicContent(message: NormalizedMessage, resolver: ImageResolver): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const resolved = resolveImage(block, resolver)
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: resolved.mediaType, data: resolved.dataUrl.split(',', 2)[1] },
      })
    } else if (block.type === 'tool-call') {
      let input: unknown = {}
      try {
        input = JSON.parse(block.arguments || '{}')
      } catch {
        input = { raw_arguments: block.arguments }
      }
      blocks.push({ type: 'tool_use', id: block.id, name: block.name, input })
    } else if (block.type === 'reasoning' && block.text) {
      blocks.push({
        type: 'thinking',
        thinking: block.text,
        ...(block.signature ? { signature: block.signature } : {}),
      })
    }
  }
  return blocks
}

function toAnthropicMessages(history: NormalizedMessage[], resolver: ImageResolver): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user' || message.role === 'assistant') {
      const content = anthropicContent(message, resolver)
      if (content.length > 0) out.push({ role: message.role, content })
      continue
    }
    if (message.role === 'tool') {
      const content: AnthropicBlock[] = [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          is_error: message.isError === true,
          content: textOf(message.blocks) || INTERRUPTED_RESULT,
        },
      ]
      out.push({ role: 'user', content })
    }
  }
  // Anthropic requires alternating roles; merge same-role neighbours.
  const merged: Record<string, unknown>[] = []
  for (const message of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === message.role) {
      prev.content = [...(prev.content as unknown[]), ...(message.content as unknown[])]
    } else {
      merged.push({ ...message })
    }
  }
  return merged
}

function anthropicTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

// ── Body assembly ───────────────────────────────────────────────────────────

export interface BuiltRequest {
  body: Record<string, unknown>
  /** True when at least one image block had to be embedded. */
  hasImages: boolean
}

function collectSystem(messages: HarnessMessage[], extra?: string): string {
  const parts: string[] = []
  if (extra && extra.trim()) parts.push(extra.trim())
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

export function hasImageBlocks(messages: HarnessMessage[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === 'image'))
}

/**
 * Build the gateway request body for one wire. Tool definitions are passed in
 * their harness shape; the fingerprint layer adds the mandatory `read`/`shell`
 * pair afterwards (see `applyFingerprint`).
 */
export function buildRequestBody(
  wire: WireKind,
  model: string,
  options: {
    messages: HarnessMessage[]
    system?: string
    tools?: ToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
  },
  resolver: ImageResolver,
): BuiltRequest {
  const history = repairToolPairing(options.messages)
  const systemPrompt = collectSystem(options.messages, options.system)
  const tools = options.tools ?? []
  const hasImages = hasImageBlocks(options.messages)
  const stop = Array.isArray(options.stop) ? options.stop.filter((s) => typeof s === 'string' && s.length > 0) : []
  const temperature = typeof options.temperature === 'number' && Number.isFinite(options.temperature) ? options.temperature : undefined

  if (wire === 'chat') {
    const body: Record<string, unknown> = {
      model,
      messages: toChatMessages(history, systemPrompt, resolver),
      stream: true,
    }
    if (tools.length > 0) body.tools = chatTools(tools)
    if (temperature !== undefined) body.temperature = temperature
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (stop.length > 0) body.stop = stop.slice(0, 4)
    return { body, hasImages }
  }

  if (wire === 'responses') {
    const body: Record<string, unknown> = {
      model,
      input: toResponsesInput(history, resolver),
      instructions: systemPrompt || undefined,
      stream: true,
      tool_choice: 'auto',
    }
    if (tools.length > 0) body.tools = responsesTools(tools)
    if (temperature !== undefined) body.temperature = temperature
    if (options.maxTokens) body.max_output_tokens = options.maxTokens
    // The Responses API has no stop-sequence parameter.
    return { body, hasImages }
  }

  const body: Record<string, unknown> = {
    model,
    messages: toAnthropicMessages(history, resolver),
    system: systemPrompt || undefined,
    max_tokens: options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 4096,
    stream: true,
  }
  if (tools.length > 0) body.tools = anthropicTools(tools)
  if (temperature !== undefined) body.temperature = temperature
  if (stop.length > 0) body.stop_sequences = stop.slice(0, 4)
  return { body, hasImages }
}

/** Rough token estimate used by the continuation budget gate (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateMessageTokens(messages: HarnessMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') total += estimateTokens(block.text)
      else if (block.type === 'reasoning') total += estimateTokens(block.text)
      else if (block.type === 'tool-call') total += estimateTokens(block.arguments) + 8
      else if (block.type === 'image') total += 1200
      else total += 32
    }
  }
  return total
}
