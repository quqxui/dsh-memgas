import { beforeEach, describe, expect, test } from 'vitest'
import { associate } from '../src/graph/association.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import type { MemoryUnit } from '../src/types.ts'

const unit = (id: string): MemoryUnit => ({
  id, content: id, scope: 'project:p', granularity: 'summary',
  createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
  status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: 'e',
  provenance: { occurredAt: 1 }, derivedFrom: [],
})

/** Unit vectors at a given angle so cosine similarity is controllable. */
const at = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)])

describe('associate', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  const seed = (angles: number[]) => angles.forEach((deg, i) => {
    store.put(unit(`u${i}`))
    store.putVector(`u${i}`, 'e', at(deg))
  })

  /** What real embedding similarity looks like: unrelated memories bunch near 0. */
  const unrelated = Array.from({ length: 30 }, (_, i) => 78 + (i % 15))
  const related = Array.from({ length: 6 }, (_, i) => 14 + i * 2)

  test('links a new memory only to the clearly similar cluster', () => {
    seed([...related, ...unrelated])
    store.put(unit('new'))
    const outcome = associate(store, { unitId: 'new', scope: 'project:p', embedderId: 'e', vector: at(0) })
    expect(outcome.method).toBe('gmm')
    const linked = store.edges(['new'], { kinds: ['association'] }).map(e => e.to).sort()
    expect(linked).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5'])
  })

  test('falls back to a percentile cut when the similarities are not bimodal', () => {
    seed(Array.from({ length: 40 }, (_, i) => 40 + i * 0.6))
    store.put(unit('new'))
    const outcome = associate(store, { unitId: 'new', scope: 'project:p', embedderId: 'e', vector: at(0) }, { fallbackPercentile: 0.9 })
    expect(outcome.method).toBe('percentile')
    expect(store.edges(['new'], { kinds: ['association'] }).length).toBeGreaterThan(0)
    expect(store.edges(['new'], { kinds: ['association'] }).length).toBeLessThanOrEqual(5)
  })

  test('does nothing while the scope is too small to have structure', () => {
    seed([5, 10])
    store.put(unit('new'))
    const outcome = associate(store, { unitId: 'new', scope: 'project:p', embedderId: 'e', vector: at(0) })
    expect(outcome.method).toBe('skipped')
    expect(store.edges(['new'])).toEqual([])
  })

  test('never gives a node more edges than the cap', () => {
    seed(Array.from({ length: 40 }, (_, i) => 5 + i * 0.4))
    store.put(unit('new'))
    associate(store, { unitId: 'new', scope: 'project:p', embedderId: 'e', vector: at(0) }, { maxEdgesPerNode: 5, fallbackPercentile: 0.5 })
    expect(store.edges(['new'], { kinds: ['association'] }).length).toBeLessThanOrEqual(5)
  })
})
