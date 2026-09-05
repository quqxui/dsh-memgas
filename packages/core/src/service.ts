import { randomBytes } from 'node:crypto'
import type { Granularity, MemoryUnit, Provenance } from './types.ts'
import { openStore, type MemoryStore } from './store/store.ts'
import { LexicalEmbedder } from './embedding/lexical.ts'
import { AdaptiveEmbedder, type AdaptiveStatus } from './embedding/adaptive.ts'
import { loadOnnxEmbedder } from './embedding/onnx.ts'
import { backfillVectors } from './embedding/backfill.ts'
import type { Embedder } from './embedding/types.ts'
import { redactSecrets } from './secrets.ts'
import { Retriever, type RetrievalChannel, type RetrievalResult } from './retrieval/retriever.ts'
import { denseChannel, lexicalChannel } from './retrieval/channels.ts'
import { granularityChannel } from './retrieval/granularity-channel.ts'
import { graphChannel, type GraphChannel, type GraphChannelOptions } from './retrieval/graph-channel.ts'
import { retrievalProfile, type RetrievalMode, type RetrievalOverrides } from './retrieval/modes.ts'
import { associate } from './graph/association.ts'

export interface SaveInput {
  content: string
  scope: string
  granularity?: Granularity
  /** Fact taxonomy entry, or `note` for something the user asked to keep verbatim. */
  kind?: string
  provenance?: Partial<Provenance>
}

export interface MemoryStatus {
  units: number
  embedder: string
  /** Null unless a local model is configured. */
  embedderLoading: AdaptiveStatus | null
  lexicalIndex: 'fts5' | 'memory'
  redactions: number
  mode: RetrievalMode
  channels: string[]
  graph: { edges: number; status: string }
}

export interface SearchRequest {
  query: string
  scopes?: string[]
  k?: number
  budgetMs?: number
  /** Overrides the configured mode for this call only. */
  mode?: RetrievalMode
}

export interface MemoryService {
  readonly store: MemoryStore
  readonly embedder: Embedder
  save(input: SaveInput): Promise<MemoryUnit | null>
  search(request: SearchRequest): Promise<RetrievalResult>
  status(): MemoryStatus
  close(): void
}

export interface MemoryServiceOptions {
  path: string
  embedder?: Embedder
  store?: MemoryStore
  coldStartUnits?: number
  mode?: RetrievalMode
  overrides?: RetrievalOverrides
  /** Entropy temperature of the granularity router. */
  lambda?: number
  /** Build association edges when a memory is saved. */
  associateOnSave?: boolean
  graph?: GraphChannelOptions
  /**
   * Local sentence-embedding model to load in the background. Retrieval runs
   * on the lexical fallback until it is ready, and never stops if it fails.
   */
  localModel?: { model: string; cacheDir?: string; mirror?: string } | null
}

class DefaultMemoryService implements MemoryService {
  readonly store: MemoryStore
  readonly embedder: Embedder
  private readonly retrievers = new Map<RetrievalMode, Retriever>()
  private readonly graph: GraphChannel
  private readonly options: MemoryServiceOptions
  private adaptive: AdaptiveEmbedder | null = null
  private redactions = 0

  constructor(options: MemoryServiceOptions) {
    this.options = options
    this.store = options.store ?? openStore({ path: options.path })
    this.embedder = options.embedder ?? this.buildEmbedder()
    this.graph = graphChannel(this.store, options.graph ?? {})
  }

  private buildEmbedder(): Embedder {
    const local = this.options.localModel
    if (!local) return new LexicalEmbedder()
    const adaptive = new AdaptiveEmbedder({
      fallback: new LexicalEmbedder(),
      load: () => loadOnnxEmbedder(local),
      // Vectors are never compared across models, so everything written while
      // the fallback was serving has to be re-embedded before it is findable.
      onReady: () => { void this.backfill() },
    })
    this.adaptive = adaptive
    adaptive.start()
    return adaptive
  }

  private async backfill(): Promise<void> {
    try {
      const scopes = this.store.scopes()
      let processed = 0
      do {
        processed = (await backfillVectors(this.store, this.embedder, { scopes, batch: 64 })).processed
      } while (processed > 0)
    } catch {
      // Old vectors simply stay unusable; retrieval still works on the rest.
    }
  }

  private retrieverFor(mode: RetrievalMode): Retriever {
    const existing = this.retrievers.get(mode)
    if (existing) return existing

    const profile = retrievalProfile(mode, this.options.overrides ?? {})
    const channels: RetrievalChannel[] = []
    const weights: Record<string, number> = {}
    const add = (channel: RetrievalChannel, setting: { enabled: boolean; weight: number }) => {
      if (!setting.enabled) return
      channels.push(channel)
      weights[channel.name] = setting.weight
    }
    add(lexicalChannel(this.store), profile.channels.lexical)
    add(denseChannel(this.store, this.embedder), profile.channels.dense)
    add(granularityChannel(this.store, this.embedder, { lambda: this.options.lambda ?? 0.1 }), profile.channels.granularity)
    add(this.graph, profile.channels.graph)

    const retriever = new Retriever({
      store: this.store,
      channels,
      coldStartUnits: this.options.coldStartUnits ?? 0,
      baselineFloor: profile.baselineFloor,
      weights,
    })
    this.retrievers.set(mode, retriever)
    return retriever
  }

  async save(input: SaveInput): Promise<MemoryUnit | null> {
    const { text, redactions } = redactSecrets(input.content)
    this.redactions += redactions
    const content = text.trim()
    if (!content) return null

    const now = Date.now()
    const unit: MemoryUnit = {
      id: `m_${randomBytes(5).toString('hex')}`,
      scope: input.scope,
      granularity: input.granularity ?? 'turn',
      content,
      createdAt: now,
      updatedAt: now,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: null,
      status: 'active',
      supersededBy: null,
      version: 1,
      promptVersion: null,
      embedderId: this.embedder.id,
      provenance: { occurredAt: now, ...input.provenance },
      derivedFrom: [],
      kind: input.kind ?? null,
      confidence: null,
    }

    this.store.put(unit)
    const [vector] = await this.embedder.embed([content])
    if (vector) {
      this.store.putVector(unit.id, this.embedder.id, vector)
      if (this.options.associateOnSave) {
        try {
          associate(this.store, {
            unitId: unit.id,
            scope: unit.scope,
            embedderId: this.embedder.id,
            vector,
          })
        } catch {
          // A memory that could not be linked is still a memory.
        }
      }
    }
    return unit
  }

  async search(request: SearchRequest): Promise<RetrievalResult> {
    const mode = request.mode ?? this.options.mode ?? 'hybrid'
    return this.retrieverFor(mode).retrieve(request)
  }

  status(): MemoryStatus {
    const mode = this.options.mode ?? 'hybrid'
    const profile = retrievalProfile(mode, this.options.overrides ?? {})
    const health = this.graph.health()
    return {
      units: this.store.countUnits(),
      embedder: this.embedder.id,
      embedderLoading: this.adaptive?.status() ?? null,
      lexicalIndex: this.store.capabilities.lexicalIndex,
      redactions: this.redactions,
      mode,
      channels: Object.entries(profile.channels).filter(([, setting]) => setting.enabled).map(([name]) => name),
      graph: { edges: health.edges, status: health.status },
    }
  }

  close(): void {
    this.store.close()
  }
}

/** Store, embedder and the baseline channels wired together. */
export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  return new DefaultMemoryService(options)
}
