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

import { existsSync, readFileSync } from 'node:fs'
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
  type ImageSource,
  type LoadedImage,
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
const CONTINUATION_PROMPT =
  'Continue your previous answer exactly where it stopped. Do not repeat anything you already wrote, and do not call any tools.'

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

/** Error with the host LlmFailure shape, thrown without importing host classes. */
export class LlmFailureError extends Error implements LlmFailure {
  /**
   * The host's `normalizeLlmFailure` only preserves a foreign adapter's code
   * through an own data property named `failure`; a plain `.code` on a
   * non-HarnessError would otherwise be flattened to `UNKNOWN`. The payload
   * here passes the host's own validation (status 100–599, positive
   * retry-after, non-empty request id).
   */
  readonly failure: LlmFailure

  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly providerRetryAfterMs?: number,
    readonly requestId?: string,
    offloadImages?: number,
  ) {
    super(message)
    this.name = 'LlmFailureError'
    const payload: LlmFailure = { message, code }
    if (typeof status === 'number') payload.status = status
    if (typeof providerRetryAfterMs === 'number' && providerRetryAfterMs > 0) {
      payload.providerRetryAfterMs = providerRetryAfterMs
    }
    if (typeof requestId === 'string' && requestId.length > 0) payload.requestId = requestId
    if (typeof offloadImages === 'number' && Number.isSafeInteger(offloadImages) && offloadImages > 0) {
      payload.offloadImages = offloadImages
    }
    this.failure = Object.freeze(payload)
  }
}

interface RequestImageAttachmentLike {
  data: Uint8Array
  mediaType: string
}

interface AttachmentServiceFull extends AttachmentService {
  /** Host-side encoder: returns a request-ready, possibly downscaled image. */
  readImageRequest?(ref: ImageAttachmentRef, target: ImageRequestTargetInfo, signal?: AbortSignal): Promise<RequestImageAttachmentLike>
}

interface FsService {
  /** Map a host filesystem path into the current execution world. */
  processPathFromHostPath?(hostPath: string): string | undefined
}

/**
 * Three-tier image loading, mirroring how the shipped dsh-llm-pi-ai adapter
 * reaches attachments on this exact host version:
 *   1. the `attachments` service's `readImageRequest` (encoder/quality ladder,
 *      honors the byte target declared by `imageRequestTarget`);
 *   2. `imageHostPath` + the `fs` service's host→execution path mapping, then
 *      a direct bounded read;
 *   3. the on-disk `$DSH_HOME/attachments/v1/objects/<xx>/<sha>` convention.
 * Undefined means "not resolvable", which the message builder turns into the
 * host's IMAGE_OFFLOAD_REQUIRED flow instead of failing the whole turn hard.
 */
class AttachmentImageSource implements ImageSource {
  constructor(private readonly ctx: PluginContext) {}

  private attachments(): AttachmentServiceFull | undefined {
    try {
      return this.ctx.get?.('attachments') as AttachmentServiceFull | undefined
    } catch {
      return undefined
    }
  }

  private fs(): FsService | undefined {
    try {
      return this.ctx.get?.('fs') as FsService | undefined
    } catch {
      return undefined
    }
  }

  async load(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<LoadedImage | undefined> {
    const service = this.attachments()

    // Tier 1: host-encoded request version (already bounded to the target).
    if (service?.readImageRequest) {
      try {
        const target: ImageRequestTargetInfo = {
          width: typeof ref.width === 'number' ? ref.width : 0,
          height: typeof ref.height === 'number' ? ref.height : 0,
          maxBytes: MAX_IMAGE_BYTES,
        }
        const encoded = await service.readImageRequest(ref, target, signal)
        if (encoded?.data) {
          return {
            mediaType: encoded.mediaType ?? ref.mediaType ?? 'image/png',
            data: encoded.data,
          }
        }
      } catch (error) {
        // Fall through to path-based reads; a broken encoder must not kill vision.
        this.ctx.logger.warn?.('[opencode2dsh] attachments.readImageRequest failed, using path fallback', error)
      }
    }

    // Tier 2: host path → execution-world path → direct read.
    let hostPath: string | undefined
    try {
      hostPath = service?.imageHostPath?.(ref)
    } catch {
      hostPath = undefined
    }
    if (hostPath) {
      const executionPath = this.fs()?.processPathFromHostPath?.(hostPath) ?? hostPath
      const bytes = this.tryRead(executionPath)
      if (bytes) return { mediaType: ref.mediaType ?? 'image/png', data: bytes }
    }

    // Tier 3: content-addressed storage convention.
    const id = ref?.attachmentId
    if (typeof id === 'string' && /^[a-f0-9]{16,}$/i.test(id)) {
      const candidate = join(resolveDshHome(), 'attachments', 'v1', 'objects', id.slice(0, 2), id)
      const bytes = this.tryRead(candidate)
      if (bytes) return { mediaType: ref.mediaType ?? 'image/png', data: bytes }
    }
    return undefined
  }

  private tryRead(path: string | undefined): Uint8Array | undefined {
    if (!path) return undefined
    try {
      if (!existsSync(path)) return undefined
      return readFileSync(path)
    } catch {
      return undefined
    }
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
    return new LlmFailureError(
      error.message,
      error.code,
      error.status,
      error.providerRetryAfterMs,
      error.requestId,
      error.offloadImages,
    )
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
  private readonly imageSource: ImageSource
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
    this.imageSource = new AttachmentImageSource(deps.ctx)
    deps.ctx.effect?.(() => () => this.catalog.dispose())
  }

  // The host calls every method with the provider route as its first
  // argument; signatures mirror LlmAdapter (dsh-llm 0.2.1-rc.2) exactly.
  providerInfo(_provider?: string): { id: string; name: string } {
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

  async listModels(_provider?: string): Promise<ModelInfo[]> {
    return this.catalog.listModels(this.config.providerId)
  }

  resolveModel(_provider: string, model: string, _signal?: AbortSignal): ResolvedModelInfo {
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

  /**
   * Host contract: `prepareCall(provider, model, signal)` binds one adapter
   * generation and returns the resolved model info plus a one-shot stream
   * entry point. The host dispatches the fully assembled GenerateOptions via
   * `stream(options)` later.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: ResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: this.resolveModel(provider, model, signal),
      stream: (callOptions) => this.stream(callOptions),
    }
  }

  // ── Turn engine ───────────────────────────────────────────────────────────

  stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    // An internal controller covers the path the host's signal does not:
    // when a consumer stops iterating early, the host runtime closes the
    // iterator without necessarily aborting the external signal. The inner
    // generator parks on an await that only settles when the turn emits, so a
    // bare generator.return() would queue behind that await and leave the
    // gateway request running until a watchdog fires. Aborting the internal
    // controller first makes the in-flight turn reject immediately, which
    // unblocks the parked generator so its own finally can close cleanly.
    const internal = new AbortController()
    const generator = this.streamTurns(options, internal)
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
        return this
      },
      next: (value?: unknown): Promise<IteratorResult<StreamChunk>> => generator.next(value),
      return: (value?: unknown): Promise<IteratorResult<StreamChunk>> => {
        internal.abort()
        return generator.return(value)
      },
      throw: (error?: unknown): Promise<IteratorResult<StreamChunk>> => generator.throw(error),
    }
  }

  private async *streamTurns(options: GenerateOptions, internal: AbortController): AsyncGenerator<StreamChunk> {
    const linkedSignal = options.signal
      ? AbortSignal.any([options.signal, internal.signal])
      : internal.signal
    const callOptions: GenerateOptions = { ...options, signal: linkedSignal }

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

    const turn = this.runTurn(callOptions, emit).then(
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
      // Normal completion, thrown failure, or early iterator.close() all land
      // here; abort is idempotent and never touches the caller's own signal.
      internal.abort()
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
      const built = await buildRequestBody(
        cap.wire,
        base,
        {
          messages: current.messages,
          system: current.system,
          tools: current.tools,
          temperature: current.temperature,
          maxTokens: current.maxTokens,
          stop: current.stop,
          signal: options.signal,
        },
        this.imageSource,
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
