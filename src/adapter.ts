/**
 * The DSH LlmAdapter implementation for the OpenCode free lane.
 *
 * One adapter object serves every free id; per-model behaviour comes entirely
 * from the vetted capability table (wire, vision, context, output ceiling,
 * reasoning menu). The turn engine mirrors the shape the community free-lane
 * adapters converged on after the October 2026 gate changes:
 *
 *  - max two gateway attempts per harness turn;
 *  - a retryable transport failure only repeats attempt one when nothing has
 *    been emitted yet (partial streams surface as STREAM_CLOSED);
 *  - a silent reasoning-only stop, or a length cut with real answer text, gets
 *    exactly one tool-forbidden continuation when the context budget allows;
 *  - usage from every attempt is summed; the terminal finish always follows a
 *    usage chunk when the gateway reported one.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { capabilitiesFor, baseModelId } from './capabilities.js'
import { resolveConfig, type PluginConfig, type ResolvedConfig } from './config.js'
import { JsonStore, resolveDataDir, resolveDshHome } from './store.js'
import { TurnMetrics } from './metrics.js'
import { ModelCatalog } from './catalog.js'
import { applyFingerprint, gatewayHeaders, sessionForConversation } from './fingerprint.js'
import { CODE, GatewayFailure, StreamTimeout, openGatewayStream } from './http.js'
import {
  buildRequestBody,
  estimateMessageTokens,
  estimateTokens,
  hasImageBlocks,
  MAX_IMAGE_BYTES,
  type ImageResolver,
} from './messages.js'
import { applyEffort, defaultEffortId, effortMenu } from './effort.js'
import { createBlockSink, feedStream, type BlockSink, type StreamResult } from './stream.js'
import type {
  AttachmentService,
  ContentBlock,
  FinishReason,
  GenerateOptions,
  HarnessMessage,
  ImageAttachmentRef,
  ImageRequestTargetInfo,
  LlmFailure,
  Logger,
  ModelInfo,
  PluginContext,
  ProviderRetryPolicy,
  ReasoningBlock,
  ResolvedModelInfo,
  StreamChunk,
  TextBlock,
  TokenUsage,
  ToolSchema,
} from './types.js'

const PROVIDER_NAME = 'OpenCode Free'
const MIN_CONTINUATION_BUDGET = 1024

/**
 * Host-level retries are disabled on purpose: the turn engine below already
 * owns exactly one clean-stream retry plus one continuation, and knows which
 * failures are final (LANE_LOCKED, REGION_BLOCKED, QUOTA_EXCEEDED). Letting the
 * optional dsh-llm-retry extension add its default five attempts would only
 * multiply free-lane traffic against non-retryable answers.
 */
const PROVIDER_RETRY_POLICY: ProviderRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  backoff: Object.freeze({ initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 }),
})
const CONTINUATION_PROMPT =
  'Continue your previous answer exactly where it stopped. Do not repeat anything you already wrote, and do not call any tools.'
const ATTACHMENT_SERVICE_TOKENS = ['attachment', 'dsh-attachment-local', 'dsh-attachment', 'attachment-local']

/** Error with the host LlmFailure shape, thrown without importing host classes. */
export class LlmFailureError extends Error implements LlmFailure {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly providerRetryAfterMs?: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'LlmFailureError'
  }
}

class AttachmentResolver implements ImageResolver {
  constructor(private readonly ctx: PluginContext) {}

  hostPath(ref: ImageAttachmentRef): string | undefined {
    for (const token of ATTACHMENT_SERVICE_TOKENS) {
      try {
        const service = this.ctx.get?.(token) as AttachmentService | undefined
        const path = service?.imageHostPath?.(ref)
        if (path) return path
      } catch {
        // A missing Cordis service token throws; try the next one.
      }
    }
    // Filesystem convention: $DSH_HOME/attachments/v1/objects/<xx>/<sha>
    const id = ref?.attachmentId
    if (typeof id === 'string' && /^[a-f0-9]{16,}$/i.test(id)) {
      const candidate = join(resolveDshHome(), 'attachments', 'v1', 'objects', id.slice(0, 2), id)
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
}

function pathForWire(wire: 'chat' | 'responses' | 'messages'): string {
  if (wire === 'responses') return '/inference/v1/responses'
  if (wire === 'messages') return '/inference/v1/messages'
  return '/inference/v1/chat/completions'
}

function toLlmFailure(error: unknown): LlmFailureError {
  if (error instanceof LlmFailureError) return error
  if (error instanceof GatewayFailure) {
    return new LlmFailureError(error.message, error.code, error.status, error.providerRetryAfterMs, error.requestId)
  }
  if (error instanceof StreamTimeout) {
    return new LlmFailureError(error.message, CODE.TIMEOUT)
  }
  if (error instanceof Error) return new LlmFailureError(error.message, CODE.STREAM_CLOSED)
  return new LlmFailureError('Unknown gateway failure.', CODE.STREAM_CLOSED)
}

function mergeUsage(acc: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!acc) return { ...next }
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: (acc.totalTokens ?? acc.inputTokens + acc.outputTokens) + (next.totalTokens ?? next.inputTokens + next.outputTokens),
    ...(acc.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined
      ? { cacheReadTokens: (acc.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }
      : {}),
    ...(acc.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? { reasoningTokens: (acc.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
      : {}),
  }
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    // Deliberately not unref'd: this backs an in-flight turn, so the process
    // must stay alive until the retry either runs or is aborted.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface AdapterDeps {
  logger: Logger
  ctx: PluginContext
  config?: PluginConfig
  /**
   * Fired whenever the eligible live roster changes. The plugin uses it to
   * re-announce the adapter so cached model pickers re-read `listModels()`.
   */
  onRosterChange?: () => void
}

export class OpenCodeFreeAdapter {
  private readonly config: ResolvedConfig
  private readonly catalog: ModelCatalog
  private readonly resolver: ImageResolver
  private readonly metrics = new TurnMetrics()
  private readonly logger: Logger

  constructor(deps: AdapterDeps) {
    this.logger = deps.logger
    this.config = resolveConfig(deps.config)
    const store = new JsonStore(resolveDataDir(this.config.dataDir))
    this.catalog = new ModelCatalog(this.config, store, deps.logger, deps.onRosterChange, Date.now, {
      metrics: () => this.metrics.snapshot(),
    })
    this.catalog.start()
    this.resolver = new AttachmentResolver(deps.ctx)
    deps.ctx.effect?.(() => () => this.catalog.dispose())
  }

  providerInfo(): { id: string; name: string } {
    return { id: this.config.providerId, name: PROVIDER_NAME }
  }

  /** The host captures this at registration; zero retries keeps retry authority in the turn engine. */
  providerRetryPolicy(): ProviderRetryPolicy {
    return PROVIDER_RETRY_POLICY
  }

  /** Free lane carries no per-image pricing; the host falls back to its neutral estimate. */
  imageRequestPricing(): undefined {
    return undefined
  }

  /**
   * We never resize: intrinsic dimensions pass through. The byte target is the
   * same 8 MB ceiling `messages.ts` enforces when embedding the attachment, so
   * host-side admission/downscaling decisions match our own serializer.
   */
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTargetInfo {
    const width = typeof image?.width === 'number' && Number.isFinite(image.width) ? image.width : 0
    const height = typeof image?.height === 'number' && Number.isFinite(image.height) ? image.height : 0
    const bytes = typeof image?.bytes === 'number' && Number.isFinite(image.bytes) ? image.bytes : MAX_IMAGE_BYTES
    return { width, height, maxBytes: Math.min(bytes, MAX_IMAGE_BYTES) }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.catalog.listModels(this.config.providerId)
  }

  resolveModel(model: string): ResolvedModelInfo {
    const cap = capabilitiesFor(baseModelId(model))
    const info: ResolvedModelInfo = {
      provider: this.config.providerId,
      id: baseModelId(model),
      name: cap.name,
      inputModalities: cap.vision ? (['text', 'image'] as const) : (['text'] as const),
      context: { contextWindow: cap.contextWindow },
      defaultMaxTokens: Math.min(cap.maxOutput, 8192),
    }
    if (cap.reasoning && cap.effort) {
      info.reasoning = {
        efforts: effortMenu(cap) ?? [],
        ...(defaultEffortId(cap) ? { defaultEffort: defaultEffortId(cap) } : {}),
      }
    }
    return info
  }

  prepareCall(options: GenerateOptions): { model: string; stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk> } {
    return {
      model: baseModelId(options.model),
      stream: (callOptions) => this.stream(callOptions),
    }
  }

  // ── Turn engine ───────────────────────────────────────────────────────────

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const queue: StreamChunk[] = []
    let wake: (() => void) | undefined
    let parked = new Promise<void>((resolve) => {
      wake = resolve
    })
    let failure: unknown
    let settled = false

    const emit = (chunk: StreamChunk): void => {
      queue.push(chunk)
      wake?.()
    }

    const turn = this.runTurn(options, emit).then(
      () => {
        settled = true
        wake?.()
      },
      (error: unknown) => {
        const mapped = toLlmFailure(error)
        this.metrics.recordFailure(mapped.code, { requestId: mapped.requestId, status: mapped.status })
        this.logger.warn?.(
          `[opencode2dsh] turn failed: ${mapped.code}` +
            `${mapped.status ? ` status=${mapped.status}` : ''}` +
            `${mapped.requestId ? ` request=${mapped.requestId}` : ''}` +
            `${mapped.providerRetryAfterMs ? ` retryAfter=${mapped.providerRetryAfterMs}ms` : ''}`,
        )
        // A delisted id: refresh the catalog immediately so the picker drops
        // it on the next announcement instead of waiting for the interval.
        if (mapped.code === CODE.UNKNOWN_MODEL) {
          this.catalog.refresh().catch((refreshError: unknown) => {
            this.logger.warn?.('[opencode2dsh] post-failure catalog refresh failed', refreshError)
          })
        }
        failure = error
        settled = true
        wake?.()
      },
    )

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as StreamChunk
        if (settled) break
        await parked
        parked = new Promise((resolve) => {
          wake = resolve
        })
      }
      while (queue.length > 0) yield queue.shift() as StreamChunk
    } finally {
      // Ensure the turn promise cannot create an unhandled rejection.
      await turn.catch(() => undefined)
    }
    if (failure) throw toLlmFailure(failure)
  }

  private async runTurn(options: GenerateOptions, emit: (chunk: StreamChunk) => void): Promise<void> {
    this.metrics.recordTurn()
    const base = baseModelId(options.model)
    const cap = capabilitiesFor(base)

    if (hasImageBlocks(options.messages) && !cap.vision) {
      throw new LlmFailureError(`Model ${base} does not accept image input on the free lane.`, CODE.UNSUPPORTED)
    }
    if (options.messages.some((m) => m.content.some((b) => b.type === 'file'))) {
      throw new LlmFailureError('File (non-image) attachments are not supported on the free lane.', CODE.UNSUPPORTED)
    }

    const session = sessionForConversation(this.sessionSeed(options))
    const sink = createBlockSink(emit)
    const maxAttempts = 2
    let current: GenerateOptions = options
    let result: StreamResult | undefined
    let usage: TokenUsage | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const built = buildRequestBody(
        cap.wire,
        base,
        {
          messages: current.messages,
          system: current.system,
          tools: current.tools,
          temperature: current.temperature,
          maxTokens: current.maxTokens,
          stop: current.stop,
        },
        this.resolver,
      )
      const style = cap.wire === 'chat' ? 'chat' : cap.wire === 'messages' ? 'claude' : 'flat'
      const aliases = applyFingerprint(built.body, style)
      applyEffort(built.body, cap, base, options.reasoningEffort)

      try {
        result = await this.runSingle(cap.wire, built.body, session, options.signal, emit, sink, aliases)
      } catch (error) {
        const retryable =
          attempt < maxAttempts &&
          sink.empty &&
          ((error instanceof GatewayFailure && error.retryable) || error instanceof StreamTimeout)
        if (!retryable) throw error
        this.metrics.recordRetry()
        await sleepAbortable(400 * attempt + Math.floor(Math.random() * 200), options.signal)
        continue
      }

      if (result.usage) usage = mergeUsage(usage, result.usage)

      if (attempt < maxAttempts && this.shouldContinue(result, current, sink, cap.contextWindow)) {
        this.metrics.recordContinuation()
        current = this.continuationOptions(current, sink)
        continue
      }
      break
    }

    if (usage) emit({ type: 'usage', usage })
    emit({ type: 'finish', reason: this.finishReason(result, sink, options.signal) })
  }

  private async runSingle(
    wire: 'chat' | 'responses' | 'messages',
    body: Record<string, unknown>,
    session: string,
    signal: AbortSignal | undefined,
    emit: (chunk: StreamChunk) => void,
    sink: BlockSink,
    aliases: Map<string, string>,
  ): Promise<StreamResult> {
    const url = `${this.config.baseUrl}${pathForWire(wire)}`
    const headers = gatewayHeaders(session)
    const stream = await openGatewayStream(
      url,
      headers,
      body,
      signal,
      {
        firstEventMs: this.config.firstEventMs,
        bodyIdleMs: wire === 'responses' ? this.config.responsesBodyIdleMs : this.config.bodyIdleMs,
      },
    )
    return feedStream(wire, stream.events, aliases, emit, sink)
  }

  private shouldContinue(
    result: StreamResult,
    options: GenerateOptions,
    sink: BlockSink,
    contextWindow: number,
  ): boolean {
    if (result.sawToolCalls) return false
    const silentStop = result.reasoningOnly
    const lengthCutWithAnswer = result.terminal === 'max-tokens' && result.sawAnswer
    if (!silentStop && !lengthCutWithAnswer) return false

    const replayTokens = sink.exportBlocks().reduce((sum, block) => {
      if (block.type === 'tool-call') return sum + estimateTokens(block.arguments) + 8
      if (block.type === 'image') return sum + 1200
      const text = 'text' in block && typeof block.text === 'string' ? block.text : ''
      return sum + estimateTokens(text)
    }, 0)
    const used = estimateMessageTokens(options.messages) + replayTokens + estimateTokens(CONTINUATION_PROMPT)
    return used + MIN_CONTINUATION_BUDGET <= Math.floor(contextWindow * 0.9)
  }

  private continuationOptions(options: GenerateOptions, sink: BlockSink): GenerateOptions {
    const replay: ContentBlock[] = sink
      .exportBlocks()
      .filter((block): block is TextBlock | ReasoningBlock => block.type === 'text' || block.type === 'reasoning')
    const assistant: HarnessMessage = {
      role: 'assistant',
      content: replay.length > 0 ? replay : [{ type: 'text', text: '' }],
    }
    const nudge: HarnessMessage = { role: 'user', content: [{ type: 'text', text: CONTINUATION_PROMPT }] }
    return {
      ...options,
      messages: [...options.messages, assistant, nudge],
      // Forbid caller tools on the continuation; the fingerprint still adds
      // the mandatory read/shell pair so the gate shape stays intact.
      tools: [] as ToolSchema[],
      stop: undefined,
    }
  }

  private finishReason(result: StreamResult | undefined, sink: BlockSink, signal: AbortSignal | undefined): FinishReason {
    if (signal?.aborted) {
      return {
        kind: 'aborted',
        failure: { message: signal.reason?.message ?? 'Request aborted.', code: CODE.ABORTED },
      }
    }
    if (!result) {
      return { kind: 'error', failure: { message: 'Stream ended without a terminal event.', code: CODE.STREAM_CLOSED } }
    }
    if (sink.empty && result.terminal !== 'tool-calls') {
      return {
        kind: 'error',
        failure: {
          message: result.failure?.message ?? 'The gateway returned an empty response.',
          code: CODE.EMPTY,
          ...(result.failure ? { status: result.failure.status, requestId: result.failure.requestId } : {}),
        },
      }
    }
    if (result.terminal === 'tool-calls') return { kind: 'tool-calls' }
    if (result.terminal === 'max-tokens') return { kind: 'max-tokens' }
    if (result.terminal === 'aborted') {
      return { kind: 'aborted', failure: result.failure ?? { message: 'Stream aborted.', code: CODE.ABORTED } }
    }
    if (result.terminal === 'error') {
      return {
        kind: 'error',
        failure: result.failure ?? { message: 'Gateway stream error.', code: CODE.STREAM_CLOSED },
      }
    }
    return { kind: 'stop' }
  }

  private sessionSeed(options: GenerateOptions): string {
    if (options.sessionId !== undefined && options.sessionId !== null) {
      return typeof options.sessionId === 'string' ? options.sessionId : String(options.sessionId)
    }
    return `${this.config.providerId}:${baseModelId(options.model)}:${options.purpose ?? 'turn'}`
  }
}
