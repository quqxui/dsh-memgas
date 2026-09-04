export interface QueueStats {
  pending: number
  running: number
  done: number
  failed: number
  lastError: { name: string; reason: string; at: number } | null
}

interface Job {
  name: string
  run: (signal: AbortSignal) => Promise<void>
}

/**
 * Serial in-process queue for memory maintenance.
 *
 * Everything that talks to a model or rewrites the graph goes through here, so
 * the agent loop never waits on it and one broken job cannot poison the next.
 * dsh's `ctx.jobs` is built around user-visible processes with output streams
 * and kill semantics, which is the wrong shape for this work.
 */
export class BackgroundQueue {
  private readonly jobs: Job[] = []
  private running = false
  private done = 0
  private failed = 0
  private lastError: QueueStats['lastError'] = null
  private idleWaiters: (() => void)[] = []

  constructor(private readonly opts: { jobTimeoutMs: number; onError?: (name: string, reason: string) => void }) {}

  enqueue(name: string, run: (signal: AbortSignal) => Promise<void>): void {
    this.jobs.push({ name, run })
    if (!this.running) void this.drain()
  }

  /** Resolves once every queued job has settled. Intended for tests and shutdown. */
  idle(): Promise<void> {
    if (!this.running && this.jobs.length === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  stats(): QueueStats {
    return {
      pending: this.jobs.length,
      running: this.running ? 1 : 0,
      done: this.done,
      failed: this.failed,
      lastError: this.lastError,
    }
  }

  private async drain(): Promise<void> {
    this.running = true
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!
      await this.runOne(job)
    }
    this.running = false
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private async runOne(job: Job): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.jobTimeoutMs)
    try {
      await Promise.race([
        job.run(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error(`timeout after ${this.opts.jobTimeoutMs}ms`)))
        }),
      ])
      this.done += 1
    } catch (error) {
      this.failed += 1
      const reason = error instanceof Error ? error.message : String(error)
      this.lastError = { name: job.name, reason, at: Date.now() }
      this.opts.onError?.(job.name, reason)
    } finally {
      clearTimeout(timer)
    }
  }
}
