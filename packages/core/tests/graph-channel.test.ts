import { beforeEach, describe, expect, test } from 'vitest'
import { graphChannel, personalizedPageRank } from '../src/retrieval/graph-channel.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import type { MemoryUnit } from '../src/types.ts'

describe('personalizedPageRank', () => {
  const edges = [
    { from: 'a', to: 'b', weight: 1, kind: 'association' },
    { from: 'b', to: 'c', weight: 1, kind: 'association' },
    { from: 'x', to: 'y', weight: 1, kind: 'association' },
  ]

  test('ranks a one-hop neighbour above a two-hop one and never reaches another component', () => {
    const scores = personalizedPageRank(edges, new Map([['a', 1]]), { alpha: 0.15, iterations: 30 })
    expect(scores.get('b')!).toBeGreaterThan(scores.get('c')!)
    expect(scores.get('c')!).toBeGreaterThan(0)
    expect(scores.get('x') ?? 0).toBe(0)
    expect(scores.get('y') ?? 0).toBe(0)
  })

  test('returns the seed distribution when there are no edges', () => {
    const scores = personalizedPageRank([], new Map([['a', 0.7], ['b', 0.3]]), { alpha: 0.15, iterations: 10 })
    expect(scores.get('a')!).toBeCloseTo(0.7)
  })
})

describe('graphChannel', () => {
  let store: MemoryStore
  const unit = (id: string): MemoryUnit => ({
    id, content: id, scope: 'project:p', granularity: 'summary',
    createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
    status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
    provenance: { occurredAt: 1 }, derivedFrom: [],
  })

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) store.put(unit(id))
  })

  test('reaches a memory two hops from the baseline hits', async () => {
    store.putEdge({ from: 'a', to: 'b', weight: 1, kind: 'association' })
    store.putEdge({ from: 'b', to: 'c', weight: 1, kind: 'association' })
    store.putEdge({ from: 'd', to: 'e', weight: 1, kind: 'association' })
    const channel = graphChannel(store, { minEdges: 1 })
    const candidates = await channel.retrieve(
      { query: 'q', scopes: ['project:p'], k: 5 },
      { baseline: [{ channel: 'dense', candidates: [{ id: 'a', score: 0.9 }] }] },
    )
    const ids = candidates.map(c => c.id)
    expect(ids).toContain('c')
    expect(ids).not.toContain('e')
    expect(channel.dependsOnBaseline).toBe(true)
  })

  test('stays silent when the graph is too sparse to mean anything', async () => {
    const channel = graphChannel(store, { minEdges: 5 })
    const candidates = await channel.retrieve(
      { query: 'q', scopes: ['project:p'], k: 5 },
      { baseline: [{ channel: 'dense', candidates: [{ id: 'a', score: 0.9 }] }] },
    )
    expect(candidates).toEqual([])
    expect(channel.health().status).toBe('sparse')
  })

  test('caps a hub node instead of abandoning the graph', async () => {
    // A star: every filler points at the anchor, which also holds the real neighbour.
    for (let i = 0; i < 25; i += 1) {
      store.put({ ...unit(`f${i}`) })
      store.putEdge({ from: `f${i}`, to: 'a', weight: 0.1, kind: 'association' })
    }
    store.putEdge({ from: 'a', to: 'b', weight: 0.9, kind: 'association' })
    const channel = graphChannel(store, { minEdges: 1, hubEdgeCap: 5 })
    const candidates = await channel.retrieve(
      { query: 'q', scopes: ['project:p'], k: 5 },
      { baseline: [{ channel: 'dense', candidates: [{ id: 'a', score: 0.9 }] }] },
    )
    expect(channel.health().status).toBe('hub')
    expect(candidates.map(c => c.id)).toContain('b')
  })

  test('returns nothing when the baseline found no seeds', async () => {
    store.putEdge({ from: 'a', to: 'b', weight: 1, kind: 'association' })
    const channel = graphChannel(store, { minEdges: 1 })
    expect(await channel.retrieve({ query: 'q', k: 5 }, { baseline: [] })).toEqual([])
  })
})
