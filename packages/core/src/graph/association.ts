import type { MemoryStore } from '../store/store.ts'
import { cosine } from '../embedding/vector.ts'
import { fitTwoComponentGmm } from './gmm.ts'

export interface AssociateInput {
  unitId: string
  scope: string
  embedderId: string
  vector: Float32Array
}

export interface AssociateOptions {
  /** Below this many neighbours there is no distribution to cluster. */
  minNeighbors?: number
  /** Similarity quantile used when the mixture is not separable. */
  fallbackPercentile?: number
  maxEdgesPerNode?: number
  /** Accept sets outside this share of the sample mean the split is not credible. */
  acceptShareRange?: [number, number]
  candidateLimit?: number
}

export interface AssociateOutcome {
  method: 'gmm' | 'percentile' | 'skipped'
  linked: number
}

const DEFAULTS = {
  minNeighbors: 8,
  fallbackPercentile: 0.9,
  maxEdgesPerNode: 12,
  acceptShareRange: [0.02, 0.6] as [number, number],
  candidateLimit: 400,
}

/**
 * Link a new memory to the historical ones it belongs with.
 *
 * The similarity distribution decides the cut, not a hand-tuned threshold: a
 * two-component mixture splits neighbours into accept and reject. When the
 * sample is unimodal, or the accept set is implausibly large or small, the
 * mixture is not trusted and a percentile cut takes over, so the graph keeps
 * growing sensibly instead of linking everything to everything.
 */
export function associate(store: MemoryStore, input: AssociateInput, opts: AssociateOptions = {}): AssociateOutcome {
  const settings = { ...DEFAULTS, ...opts }
  const neighbours = store
    .searchDense(input.vector, {
      embedderId: input.embedderId,
      limit: settings.candidateLimit,
      scopes: [input.scope],
    })
    .filter(candidate => candidate.id !== input.unitId)

  if (neighbours.length < settings.minNeighbors) return { method: 'skipped', linked: 0 }

  const scores = neighbours.map(candidate => candidate.score)
  const fit = fitTwoComponentGmm(scores)
  const [minShare, maxShare] = settings.acceptShareRange
  const trustGmm = fit.separable && fit.acceptShare >= minShare && fit.acceptShare <= maxShare

  let accepted: typeof neighbours
  let method: AssociateOutcome['method']
  if (trustGmm) {
    accepted = neighbours.filter(candidate => fit.assign(candidate.score) === 'accept')
    method = 'gmm'
  } else {
    const sorted = [...scores].sort((a, b) => a - b)
    const cut = sorted[Math.min(sorted.length - 1, Math.floor(settings.fallbackPercentile * sorted.length))]!
    accepted = neighbours.filter(candidate => candidate.score >= cut)
    method = 'percentile'
  }

  const linked = accepted
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.maxEdgesPerNode)
  for (const candidate of linked) {
    store.putEdge({ from: input.unitId, to: candidate.id, weight: candidate.score, kind: 'association' })
  }
  return { method, linked: linked.length }
}
