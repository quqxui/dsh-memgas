import type { MemoryStore } from '../store/store.ts'
import type { LlmClient } from '../llm/client.ts'
import type { Embedder } from '../embedding/types.ts'
import type { BackgroundQueue } from '../queue.ts'
import { reconcileFact } from './reconcile.ts'
import { coRetrievalEdges, reinforce } from './reinforce.ts'
import { decay } from './decay.ts'
import { abstractCluster, findCluster } from './abstract.ts'
import { reassociate } from './reassociate.ts'

export interface EvolutionStats {
  reconciled: number
  archived: number
  abstracted: number
  reassociations: number
  failures: number
  lastFailure: string | null
}

export interface EvolutionRunnerOptions {
  store: MemoryStore
  llm: LlmClient
  embedder: Embedder
  queue: BackgroundQueue
  scope: string
  enabled?: boolean
  now?: () => number
  halfLifeDays?: number
  archiveBelow?: number
  maxActive?: number
  abstractClusterSize?: number
  /** Rebuild association edges once this many facts have been stored. */
  reassociateEvery?: number
  reassociateWindow?: number
  sessionId?: string
}

const DEFAULTS = {
  enabled: true,
  halfLifeDays: 30,
  archiveBelow: 0.15,
  maxActive: 5000,
  abstractClusterSize: 12,
  reassociateEvery: 200,
  reassociateWindow: 100,
}

/**
 * Drives the six maintenance processes off the events that should trigger them.
 *
 * Every process runs on the background queue and swallows its own failures:
 * memory maintenance must never be the reason a turn fails, and a broken model
 * or a corrupt graph must not stop the other processes from running.
 */
export class EvolutionRunner {
  private readonly opts: EvolutionRunnerOptions & typeof DEFAULTS & { now: () => number }
  private readonly stats_: EvolutionStats = {
    reconciled: 0, archived: 0, abstracted: 0, reassociations: 0, failures: 0, lastFailure: null,
  }
  private storedSinceReassociate = 0

  constructor(options: EvolutionRunnerOptions) {
    this.opts = { ...DEFAULTS, now: () => Date.now(), ...options }
  }

  idle(): Promise<void> {
    return this.opts.queue.idle()
  }

  stats(): EvolutionStats {
    return { ...this.stats_ }
  }

  private run(name: string, task: (signal: AbortSignal) => Promise<void>): void {
    if (!this.opts.enabled) return
    this.opts.queue.enqueue(name, async signal => {
      try {
        await task(signal)
      } catch (error) {
        this.stats_.failures += 1
        this.stats_.lastFailure = `${name}: ${error instanceof Error ? error.message : String(error)}`
      }
    })
  }

  /** A fact was just written: reconcile it, and periodically refresh the graph. */
  onFactStored(id: string): void {
    this.storedSinceReassociate += 1
    this.run(`reconcile:${id}`, async signal => {
      const unit = this.opts.store.get(id)
      if (!unit) return
      const outcome = await reconcileFact(this.opts.store, this.opts.llm, this.opts.embedder, unit, {
        signal,
        ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
      })
      if (outcome.relation !== 'unrelated') this.stats_.reconciled += 1
      if (outcome.degraded && outcome.reason) this.stats_.lastFailure = `reconcile: ${outcome.reason}`
    })

    if (this.storedSinceReassociate >= this.opts.reassociateEvery) {
      this.storedSinceReassociate = 0
      this.run('reassociate', async () => {
        await reassociate(this.opts.store, this.opts.embedder, {
          scope: this.opts.scope,
          window: this.opts.reassociateWindow,
        })
        this.stats_.reassociations += 1
      })
    }
  }

  /** Memories that reached the model: strengthen them and their joint use. */
  onRecallUsed(ids: string[]): void {
    if (ids.length === 0) return
    this.run('reinforce', async () => {
      reinforce(this.opts.store, ids, { at: this.opts.now() })
      coRetrievalEdges(this.opts.store, ids)
    })
  }

  /** Session boundaries are the natural moment for the sweeping processes. */
  onSessionStart(): void {
    this.run('decay', async () => {
      const outcome = decay(this.opts.store, {
        scopes: [this.opts.scope],
        now: this.opts.now(),
        halfLifeDays: this.opts.halfLifeDays,
        archiveBelow: this.opts.archiveBelow,
        maxActive: this.opts.maxActive,
      })
      this.stats_.archived += outcome.archived
    })

    this.run('abstract', async signal => {
      const cluster = findCluster(this.opts.store, {
        scopes: [this.opts.scope],
        minSize: this.opts.abstractClusterSize,
      })
      if (!cluster) return
      const outcome = await abstractCluster(this.opts.store, this.opts.llm, cluster, {
        scope: this.opts.scope,
        embedderId: this.opts.embedder.id,
        now: this.opts.now(),
        signal,
        ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
      })
      if (outcome.created) this.stats_.abstracted += 1
    })
  }
}
