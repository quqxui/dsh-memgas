import type { MemoryStore } from '../store/store.ts'
import type { Embedder } from '../embedding/types.ts'
import type { Granularity } from '../types.ts'
import type { Candidate } from './fusion.ts'
import type { RetrievalChannel, RetrievalRequest } from './retriever.ts'

export interface EntropyWeights {
  weights: Record<string, number>
  entropies: Record<string, number>
  /** True when no granularity was more certain than another, so weights are uniform. */
  degraded: boolean
}

const GRANULARITIES: Granularity[] = ['session', 'turn', 'summary', 'keyword']
const OVERFETCH = 3
const MIN_ENTROPY = 1e-6
const UNIFORM_EPSILON = 0.02

/**
 * Weight each granularity by how decisively its similarity scores point at
 * something. A peaked distribution has low entropy and earns more weight; a
 * flat one earns less. When every granularity is equally (un)certain the
 * weights collapse to uniform and the routing is reported as degraded.
 */
export function entropyWeights(scores: Record<string, number[]>, opts: { lambda: number }): EntropyWeights {
  const entropies: Record<string, number> = {}
  for (const [granularity, values] of Object.entries(scores)) {
    if (values.length === 0) continue
    if (values.length === 1) {
      entropies[granularity] = MIN_ENTROPY
      continue
    }
    const scaled = values.map(value => Math.exp(value / opts.lambda))
    const total = scaled.reduce((sum, value) => sum + value, 0)
    let entropy = 0
    for (const value of scaled) {
      const p = value / total
      if (p > 0) entropy -= p * Math.log(p)
    }
    entropies[granularity] = Math.max(entropy, MIN_ENTROPY)
  }

  const names = Object.keys(entropies)
  if (names.length === 0) return { weights: {}, entropies, degraded: true }

  const inverse = names.map(name => 1 / entropies[name]!)
  const sum = inverse.reduce((a, b) => a + b, 0)
  const weights: Record<string, number> = {}
  names.forEach((name, index) => { weights[name] = inverse[index]! / sum })

  const uniform = 1 / names.length
  const degraded = names.every(name => Math.abs(weights[name]! - uniform) < UNIFORM_EPSILON)
  if (degraded) for (const name of names) weights[name] = uniform
  return { weights, entropies, degraded }
}

/**
 * C3: retrieves each granularity separately and merges them by routed weight,
 * so a query that is really about one specific turn is not drowned by session
 * summaries, and vice versa.
 */
export function granularityChannel(store: MemoryStore, embedder: Embedder, opts: { lambda: number }): RetrievalChannel {
  return {
    name: 'granularity',
    baseline: false,
    async retrieve(request: RetrievalRequest): Promise<Candidate[]> {
      const [vector] = await embedder.embed([request.query])
      if (!vector) return []
      const limit = (request.k ?? 8) * OVERFETCH

      const perGranularity: Record<string, Candidate[]> = {}
      const scores: Record<string, number[]> = {}
      for (const granularity of GRANULARITIES) {
        const hits = store.searchDense(vector, {
          embedderId: embedder.id,
          limit,
          granularities: [granularity],
          ...(request.scopes ? { scopes: request.scopes } : {}),
        }).filter(candidate => candidate.score > 0.05)
        if (hits.length === 0) continue
        perGranularity[granularity] = hits
        scores[granularity] = hits.map(hit => hit.score)
      }

      const routed = entropyWeights(scores, opts)
      const merged = new Map<string, number>()
      for (const [granularity, hits] of Object.entries(perGranularity)) {
        const weight = routed.weights[granularity] ?? 0
        for (const hit of hits) {
          merged.set(hit.id, Math.max(merged.get(hit.id) ?? 0, weight * hit.score))
        }
      }

      return [...merged.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
  }
}
