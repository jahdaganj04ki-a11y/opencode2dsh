/**
 * Structural types for the slices of the DeepSeek Harness (DSH 0.2.x) contract
 * this plugin talks to.
 *
 * The plugin deliberately imports NO `@deepseek-ai/*` package at runtime: the
 * adapter registration validates structurally (it calls the methods, it never
 * runs `instanceof`), so a plain object implementing this surface mounts on
 * every kernel line that supplies `ctx.llm.registerAdapter`. Keeping the host
 * out of the dependency graph also makes the installed generation
 * self-contained — nothing for pnpm to resolve, hoist or duplicate on Windows.
 *
 * These declarations intentionally cover only what the plugin uses; they are
 * not an attempt to reproduce the full host vocabulary.
 */

// ── Harness message / chunk vocabulary (dsh-llm types, 0.2.1-rc.2) ──────────

export type ModelModality = 'text' | 'image'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  /** Provider-native reasoning signature, replayed verbatim when present. */
  signature?: string
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType?: string
  [key: string]: unknown
}

export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
  /** Host-budget offload: the bytes must not be re-read from disk. */
  offloaded?: true
}

export interface FileBlock {
  type: 'file'
  attachment: unknown
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
}

export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | FileBlock | ToolCallBlock

export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface HarnessMessage {
  role: MessageRole
  content: ContentBlock[]
  /** V4 tool results: message-level call id on `role: 'tool'`. */
  toolCallId?: string
  isError?: boolean
  /** Legacy/alternative locations for the tool call id. */
  source?: { kind?: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
  /** Some session formats keep provider reasoning here instead of a block. */
  reasoning_content?: string
  [key: string]: unknown
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  deferLoading?: true
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

export interface LlmFailure {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
  /** How many of the oldest retained image occurrences must be offloaded. */
  offloadImages?: number
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** The fully assembled request the host hands an adapter's `stream()`. */
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: HarnessMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: unknown
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string | { toString(): string }
  purpose?: 'compaction' | 'session-title'
}

export interface ReasoningEffortInfo {
  id: string
  name: string
  description?: string
}

export interface ModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: ModelModality[]
}

export interface ResolvedModelInfo extends ModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: {
    efforts: ReasoningEffortInfo[]
    defaultEffort?: string
  }
}

export interface RetryPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

/** Resolved normal-mode policy as captured by the host at adapter registration. */
export interface ProviderRetryPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  backoff: {
    initialDelayMs: number
    maxDelayMs: number
    jitterRatio: number
  }
}

/** Structural mirror of dsh-attachment's ImageRequestTarget. */
export interface ImageRequestTargetInfo {
  width: number
  height: number
  maxBytes: number
}

// ── Host context (structural slice of the Cordis service container) ─────────

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug?(...args: unknown[]): void
}

/** Minimal slice of dsh-attachment-local's AttachmentStore. */
export interface AttachmentService {
  imageHostPath(ref: ImageAttachmentRef): string | undefined
}

export interface AdapterRegistrationHandle {
  (): void
  replace(providers: string[]): void
}

export interface LlmService {
  registerAdapter(providers: string[], adapter: unknown): AdapterRegistrationHandle
}

export interface PluginContext {
  logger: Logger
  llm: LlmService
  /** Cordis service lookup; used for the optional attachment service. */
  get?(service: string): unknown
  /** Cordis effect registration for disposal tied to the plugin fiber. */
  effect?(fn: () => void | (() => void)): unknown
  inject?(services: string[], callback: (ctx: PluginContext) => void): unknown
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  emit?(event: string, ...args: unknown[]): unknown
}
