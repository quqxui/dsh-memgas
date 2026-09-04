import type { MemoryStore } from '../store/store.ts'
import type { Embedder } from '../embedding/types.ts'
import type { Candidate } from './fusion.ts'
import type { RetrievalChannel, RetrievalRequest } from './retriever.ts'

const OVERFETCH = 3

/** C1: full-text matching. Wins on identifiers, paths and exact wording. */
export function lexicalChannel(store: MemoryStore): RetrievalChannel {
  return {
    name: 'lexical',
    baseline: true,
    async retrieve(request: RetrievalRequest): Promise<Candidate[]> {
      return store.searchLexical(request.query, {
        limit: (request.k ?? 8) * OVERFETCH,
        ...(request.scopes ? { scopes: request.scopes } : {}),
      })
    },
  }
}

/** C2: vector similarity. Wins when the question is worded differently. */
export function denseChannel(store: MemoryStore, embedder: Embedder): RetrievalChannel {
  return {
    name: 'dense',
    baseline: true,
    async retrieve(request: RetrievalRequest): Promise<Candidate[]> {
      const [vector] = await embedder.embed([request.query])
      if (!vector) return []
      return store
        .searchDense(vector, {
          embedderId: embedder.id,
          limit: (request.k ?? 8) * OVERFETCH,
          ...(request.scopes ? { scopes: request.scopes } : {}),
        })
        // A cosine near zero is noise, not a memory about this query.
        .filter(candidate => candidate.score > 0.05)
    },
  }
}
