/**
 * In-process turn metrics, mirrored into the on-disk health snapshot.
 *
 * Counters are intentionally cheap and best-effort: a crash between writes
 * loses the unsaved tail, which is acceptable for operational diagnostics.
 * The snapshot distinguishes the failure classes a support request needs
 * (gate refusal, quota, timeout, transport) without logging message content.
 */

export interface MetricsSnapshot {
  turns: number
  retries: number
  continuations: number
  failures: Record<string, number>
  lastFailure?: {
    code: string
    at: string
    requestId?: string
    status?: number
  }
}

export class TurnMetrics {
  private turns = 0
  private retries = 0
  private continuations = 0
  private readonly failures = new Map<string, number>()
  private lastFailure: MetricsSnapshot['lastFailure']

  recordTurn(): void {
    this.turns += 1
  }

  recordRetry(): void {
    this.retries += 1
  }

  recordContinuation(): void {
    this.continuations += 1
  }

  recordFailure(code: string, detail?: { requestId?: string; status?: number }): void {
    this.failures.set(code, (this.failures.get(code) ?? 0) + 1)
    this.lastFailure = {
      code,
      at: new Date().toISOString(),
      ...(detail?.requestId ? { requestId: detail.requestId } : {}),
      ...(typeof detail?.status === 'number' ? { status: detail.status } : {}),
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      turns: this.turns,
      retries: this.retries,
      continuations: this.continuations,
      failures: Object.fromEntries(this.failures),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    }
  }
}
