import type { Edge, MemoryStore } from '../store/store.ts'
import type { Candidate, ChannelResult } from './fusion.ts'
import type { RetrievalChannel, RetrievalRequest } from './retriever.ts'

export interface GraphHealth {
  status: 'ok' | 'sparse' | 'hub'
  edges: number
  avgDegree: number
  maxDegree: number
}

export interface GraphChannel extends RetrievalChannel {
  health(): GraphHealth
}

const DEFAULTS = {
  /** Below a handful of edges there is no structure to walk; the count is not a quality bar. */
  minEdges: 3,
  alpha: 0.15,
  iterations: 20,
  /** A node wired to this share of the graph spreads noise rather than meaning. */
  hubShare: 0.5,
  /** Strongest edges kept for such a node when building the walk. */
  hubEdgeCap: 8,
  overfetch: 3,
}

/**
 * Keep only each node's strongest edges once it exceeds `cap`.
 *
 * A memory that everything links to would otherwise smear PageRank mass across
 * the whole store. Trimming it keeps the rest of the graph usable, which is
 * better than switching the channel off over one badly connected node.
 */
function capHubs(edges: Edge[], cap: number): Edge[] {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const hubs = new Set([...degree.entries()].filter(([, count]) => count > cap).map(([id]) => id))
  if (hubs.size === 0) return edges

  const kept = new Set<Edge>()
  const nonHub = edges.filter(edge => !hubs.has(edge.from) && !hubs.has(edge.to))
  for (const edge of nonHub) kept.add(edge)
  for (const hub of hubs) {
    const touching = edges
      .filter(edge => edge.from === hub || edge.to === hub)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, cap)
    for (const edge of touching) kept.add(edge)
  }
  return [...kept]
}

/**
 * Personalized PageRank over the association graph.
 *
 * Edges are treated as undirected: association is symmetric, and a memory is
 * just as relevant reached from either end.
 */
export function personalizedPageRank(
  edges: Edge[],
  seeds: Map<string, number>,
  opts: { alpha: number; iterations: number },
): Map<string, number> {
  const neighbours = new Map<string, { id: string; weight: number }[]>()
  const add = (from: string, to: string, weight: number) => {
    const list = neighbours.get(from) ?? []
    list.push({ id: to, weight })
    neighbours.set(from, list)
  }
  for (const edge of edges) {
    add(edge.from, edge.to, edge.weight)
    add(edge.to, edge.from, edge.weight)
  }

  const seedTotal = [...seeds.values()].reduce((sum, value) => sum + value, 0) || 1
  const restart = new Map<string, number>()
  for (const [id, value] of seeds) restart.set(id, value / seedTotal)

  let current = new Map(restart)
  for (let iteration = 0; iteration < opts.iterations; iteration += 1) {
    const next = new Map<string, number>()
    for (const [id, mass] of current) {
      const list = neighbours.get(id)
      if (!list || list.length === 0) {
        // Dangling mass returns to the seeds instead of leaking away.
        for (const [seedId, share] of restart) next.set(seedId, (next.get(seedId) ?? 0) + mass * (1 - opts.alpha) * share)
        continue
      }
      const total = list.reduce((sum, edge) => sum + edge.weight, 0) || 1
      for (const edge of list) {
        next.set(edge.id, (next.get(edge.id) ?? 0) + mass * (1 - opts.alpha) * (edge.weight / total))
      }
    }
    for (const [seedId, share] of restart) next.set(seedId, (next.get(seedId) ?? 0) + opts.alpha * share)
    current = next
  }
  return current
}

/**
 * C4: expands whatever the baseline channels already found, one or two hops
 * along the association graph. It never seeds itself, so it can only add
 * context around real hits — and it withdraws entirely when the graph is too
 * sparse to carry meaning or has a hub that would smear mass over everything.
 */
export function graphChannel(store: MemoryStore, opts: GraphChannelOptions = {}): GraphChannel {
  const settings = { ...DEFAULTS, ...opts }
  let lastHealth: GraphHealth = { status: 'sparse', edges: 0, avgDegree: 0, maxDegree: 0 }

  return {
    name: 'graph',
    baseline: false,
    dependsOnBaseline: true,
    health: () => lastHealth,
    async retrieve(request: RetrievalRequest, context?: { baseline: ChannelResult[] }): Promise<Candidate[]> {
      const stats = store.edgeStats('association')
      const hubbed = stats.count > 0 && stats.maxDegree > Math.max(10, stats.count * settings.hubShare)
      lastHealth = {
        status: stats.count < settings.minEdges ? 'sparse' : hubbed ? 'hub' : 'ok',
        edges: stats.count,
        avgDegree: stats.avgDegree,
        maxDegree: stats.maxDegree,
      }
      // A hub is trimmed, not fatal; only a graph with nothing in it is.
      if (lastHealth.status === 'sparse') return []

      const seeds = new Map<string, number>()
      for (const result of context?.baseline ?? []) {
        result.candidates.forEach((candidate, index) => {
          const mass = 1 / (index + 1)
          seeds.set(candidate.id, (seeds.get(candidate.id) ?? 0) + mass)
        })
      }
      if (seeds.size === 0) return []

      const edges = store.edges([...seeds.keys()], { kinds: ['association', 'coRetrieval'] })
      const expanded = new Set<string>()
      for (const edge of edges) {
        expanded.add(edge.from)
        expanded.add(edge.to)
      }
      const frontier = capHubs(
        store.edges([...expanded], { kinds: ['association', 'coRetrieval'] }),
        settings.hubEdgeCap,
      )
      const scores = personalizedPageRank(frontier, seeds, { alpha: settings.alpha, iterations: settings.iterations })

      return [...scores.entries()]
        .filter(([id]) => !seeds.has(id))
        .map(([id, score]) => ({ id, score }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, (request.k ?? 8) * settings.overfetch)
    },
  }
}

export interface GraphChannelOptions {
  minEdges?: number
  alpha?: number
  iterations?: number
  hubShare?: number
  hubEdgeCap?: number
  overfetch?: number
}
