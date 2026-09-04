import type { MemoryUnit } from '../types.ts'
import { applyBaselineFloor, fuseRRF, type Candidate, type ChannelResult, type Contribution } from './fusion.ts'
import type { MemoryStore } from '../store/store.ts'

export interface RetrievalRequest {
  query: string
  scopes?: string[]
  k?: number
  /** Tighter deadline for this call only, e.g. on the pre-step path. */
  budgetMs?: number
}

/** One way of proposing memories for a query. Channels never see each other. */
export interface RetrievalChannel {
  name: string
  /** Baseline channels are never skipped and own a reserved share of the results. */
  baseline: boolean
  retrieve(request: RetrievalRequest): Promise<Candidate[]>
}

export interface ChannelReport {
  channel: string
  status: 'ok' | 'skipped' | 'failed' | 'timeout'
  ms: number
  count: number
  reason?: string
}

export interface RetrievedMemory {
  unit: MemoryUnit
  score: number
  contributions: Contribution[]
}

export interface RetrievalResult {
  items: RetrievedMemory[]
  channels: ChannelReport[]
  /** True when any channel was skipped, failed or timed out. */
  degraded: boolean
}

export interface RetrieverOptions {
  store: MemoryStore
  channels: RetrievalChannel[]
  weights?: Record<string, number>
  channelTimeoutMs?: number
  budgetMs?: number
  coldStartUnits?: number
  baselineFloor?: number
}

const DEFAULTS = {
  channelTimeoutMs: 120,
  budgetMs: 300,
  coldStartUnits: 50,
  baselineFloor: 0.5,
  k: 8,
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Runs every channel in parallel and merges what came back.
 *
 * A retrieval must never take a turn down with it: a channel that throws, hangs
 * or is not ready yet is reported and dropped, and the remaining channels still
 * produce a result. When only enhancement channels survive, the baseline floor
 * has nothing to protect, which is why the report says the result is degraded.
 */
export class Retriever {
  private readonly opts: Required<Omit<RetrieverOptions, 'weights'>> & { weights: Record<string, number> }

  constructor(options: RetrieverOptions) {
    this.opts = {
      store: options.store,
      channels: options.channels,
      weights: options.weights ?? {},
      channelTimeoutMs: options.channelTimeoutMs ?? DEFAULTS.channelTimeoutMs,
      budgetMs: options.budgetMs ?? DEFAULTS.budgetMs,
      coldStartUnits: options.coldStartUnits ?? DEFAULTS.coldStartUnits,
      baselineFloor: options.baselineFloor ?? DEFAULTS.baselineFloor,
    }
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const k = request.k ?? DEFAULTS.k
    const coldStart = this.opts.store.countUnits() < this.opts.coldStartUnits
    const reports: ChannelReport[] = []
    const results: ChannelResult[] = []

    const runs = this.opts.channels.map(async channel => {
      if (coldStart && !channel.baseline) {
        reports.push({ channel: channel.name, status: 'skipped', ms: 0, count: 0, reason: 'cold start' })
        return
      }
      const started = Date.now()
      try {
        const budget = Math.min(this.opts.channelTimeoutMs, this.opts.budgetMs, request.budgetMs ?? Infinity)
        const candidates = await withTimeout(channel.retrieve(request), budget)
        results.push({ channel: channel.name, candidates })
        reports.push({ channel: channel.name, status: 'ok', ms: Date.now() - started, count: candidates.length })
      } catch (error) {
        const timedOut = error instanceof TimeoutError
        reports.push({
          channel: channel.name,
          status: timedOut ? 'timeout' : 'failed',
          ms: Date.now() - started,
          count: 0,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })

    await Promise.all(runs)

    const fused = fuseRRF(results, { weights: this.opts.weights })
    const baselineChannels = this.opts.channels.filter(channel => channel.baseline).map(channel => channel.name)
    const ranked = applyBaselineFloor(fused, { baselineChannels, k, floor: this.opts.baselineFloor })

    const items: RetrievedMemory[] = []
    for (const item of ranked) {
      const unit = this.opts.store.get(item.id)
      // A candidate can name a memory that was archived or purged since indexing.
      if (unit) items.push({ unit, score: item.score, contributions: item.contributions })
    }

    return {
      items,
      channels: reports.sort((a, b) => a.channel.localeCompare(b.channel)),
      degraded: reports.some(report => report.status !== 'ok'),
    }
  }
}
