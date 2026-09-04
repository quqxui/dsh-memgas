import { randomBytes } from 'node:crypto'
import type { Granularity, MemoryUnit, Provenance } from './types.ts'
import { openStore, type MemoryStore } from './store/store.ts'
import { LexicalEmbedder } from './embedding/lexical.ts'
import type { Embedder } from './embedding/types.ts'
import { redactSecrets } from './secrets.ts'
import { Retriever, type RetrievalResult } from './retrieval/retriever.ts'
import { denseChannel, lexicalChannel } from './retrieval/channels.ts'

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
  lexicalIndex: 'fts5' | 'memory'
  redactions: number
}

export interface MemoryService {
  readonly store: MemoryStore
  readonly embedder: Embedder
  save(input: SaveInput): Promise<MemoryUnit | null>
  search(request: { query: string; scopes?: string[]; k?: number; budgetMs?: number }): Promise<RetrievalResult>
  status(): MemoryStatus
  close(): void
}

export interface MemoryServiceOptions {
  path: string
  embedder?: Embedder
  store?: MemoryStore
  coldStartUnits?: number
  baselineFloor?: number
  weights?: Record<string, number>
}

class DefaultMemoryService implements MemoryService {
  readonly store: MemoryStore
  readonly embedder: Embedder
  private readonly retriever: Retriever
  private redactions = 0

  constructor(options: MemoryServiceOptions) {
    this.store = options.store ?? openStore({ path: options.path })
    this.embedder = options.embedder ?? new LexicalEmbedder()
    this.retriever = new Retriever({
      store: this.store,
      channels: [lexicalChannel(this.store), denseChannel(this.store, this.embedder)],
      // Baseline channels only, so cold start has nothing to hold back yet.
      coldStartUnits: options.coldStartUnits ?? 0,
      baselineFloor: options.baselineFloor ?? 0.5,
      weights: options.weights ?? {},
    })
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
    if (vector) this.store.putVector(unit.id, this.embedder.id, vector)
    return unit
  }

  async search(request: { query: string; scopes?: string[]; k?: number; budgetMs?: number }): Promise<RetrievalResult> {
    return this.retriever.retrieve(request)
  }

  status(): MemoryStatus {
    return {
      units: this.store.countUnits(),
      embedder: this.embedder.id,
      lexicalIndex: this.store.capabilities.lexicalIndex,
      redactions: this.redactions,
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
