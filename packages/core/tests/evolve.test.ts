import { beforeEach, describe, expect, test } from 'vitest'
import { reconcileFact } from '../src/evolve/reconcile.ts'
import { reinforce, coRetrievalEdges } from '../src/evolve/reinforce.ts'
import { decay } from '../src/evolve/decay.ts'
import { abstractCluster, findCluster } from '../src/evolve/abstract.ts'
import { reassociate } from '../src/evolve/reassociate.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import type { MemoryUnit } from '../src/types.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 5)

function unit(over: Partial<MemoryUnit> & Pick<MemoryUnit, 'id' | 'content'>): MemoryUnit {
  return {
    scope: 'project:p', granularity: 'summary', createdAt: NOW, updatedAt: NOW,
    importance: 0.5, accessCount: 0, lastAccessedAt: null, status: 'active', supersededBy: null,
    version: 1, promptVersion: null, embedderId: 'lexical-v1', provenance: { occurredAt: NOW },
    derivedFrom: [], kind: 'decision', confidence: 0.8, ...over,
  }
}

const llmSaying = (reply: string) => ({ async complete() { return reply } })
const llmThrowing = () => ({ async complete(): Promise<string> { throw new Error('provider down') } })

describe('reconcileFact', () => {
  let store: MemoryStore
  const embedder = new LexicalEmbedder()

  const incoming = unit({ id: 'new', content: '检索超时改为 500ms' })

  // reconcileFact works on units that are already stored: the harvester writes
  // first so nothing is lost if reconciliation cannot run.
  beforeEach(async () => {
    store = openStore({ path: ':memory:' })
    for (const u of [unit({ id: 'old', content: '检索超时定为 300ms' }), incoming]) {
      store.put(u)
      const [v] = await embedder.embed([u.content])
      store.putVector(u.id, embedder.id, v!)
    }
  })

  test('supersedes the old fact and keeps a version chain', async () => {
    const outcome = await reconcileFact(store, llmSaying('{"relation":"update","target":"old"}'), embedder, incoming, {})
    expect(outcome.relation).toBe('update')
    expect(store.get('old')).toMatchObject({ status: 'superseded', supersededBy: 'new' })
    expect(store.get('new')).toMatchObject({ status: 'active', version: 2 })
  })

  test('drops a duplicate and reinforces the memory that already said it', async () => {
    const before = store.get('old')!.importance
    const outcome = await reconcileFact(store, llmSaying('{"relation":"duplicate","target":"old"}'), embedder, incoming, {})
    expect(outcome.relation).toBe('duplicate')
    expect(store.get('new')).toBeNull()
    expect(store.get('old')!.importance).toBeGreaterThan(before)
  })

  test('keeps both and marks the conflict when they contradict', async () => {
    await reconcileFact(store, llmSaying('{"relation":"contradict","target":"old"}'), embedder, incoming, {})
    expect(store.get('old')!.status).toBe('active')
    expect(store.get('new')!.status).toBe('active')
    expect(store.edges(['new'], { kinds: ['contradicts'] })).toHaveLength(1)
  })

  test('stores the new fact untouched when the model call fails', async () => {
    const outcome = await reconcileFact(store, llmThrowing(), embedder, incoming, {})
    expect(outcome.relation).toBe('unrelated')
    expect(outcome.degraded).toBe(true)
    expect(store.get('new')!.status).toBe('active')
    expect(store.get('old')!.status).toBe('active')
  })

  test('ignores a target the model invented', async () => {
    const outcome = await reconcileFact(store, llmSaying('{"relation":"update","target":"ghost"}'), embedder, incoming, {})
    expect(outcome.relation).toBe('unrelated')
    expect(store.get('new')!.status).toBe('active')
  })

  test('does not call the model when nothing similar exists', async () => {
    const empty = openStore({ path: ':memory:' })
    empty.put(incoming)
    let called = false
    const llm = { async complete() { called = true; return '{}' } }
    const outcome = await reconcileFact(empty, llm, embedder, incoming, {})
    expect(called).toBe(false)
    expect(outcome.relation).toBe('unrelated')
  })
})

describe('reinforce', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
    store.put(unit({ id: 'a', content: 'a', importance: 0.5 }))
    store.put(unit({ id: 'b', content: 'b', importance: 0.5 }))
  })

  test('raises importance for memories that were used', () => {
    reinforce(store, ['a'], { at: NOW })
    expect(store.get('a')!.importance).toBeGreaterThan(0.5)
    expect(store.get('a')!.accessCount).toBe(1)
    expect(store.get('b')!.importance).toBe(0.5)
  })

  test('never lets importance exceed 1', () => {
    for (let i = 0; i < 50; i += 1) reinforce(store, ['a'], { at: NOW })
    expect(store.get('a')!.importance).toBeLessThanOrEqual(1)
  })

  test('links memories that keep coming back together', () => {
    coRetrievalEdges(store, ['a', 'b'])
    coRetrievalEdges(store, ['a', 'b'])
    const edge = store.edges(['a'], { kinds: ['coRetrieval'] })[0]!
    expect(edge.to === 'b' || edge.from === 'b').toBe(true)
    expect(edge.weight).toBeGreaterThan(0)
  })

  test('does not link a single memory to itself', () => {
    coRetrievalEdges(store, ['a'])
    expect(store.edges(['a'], { kinds: ['coRetrieval'] })).toEqual([])
  })
})

describe('decay', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('archives a memory nobody has touched in a long time', () => {
    store.put(unit({ id: 'stale', content: 'x', importance: 0.3, updatedAt: NOW - 200 * DAY }))
    const outcome = decay(store, { scopes: ['project:p'], now: NOW, halfLifeDays: 30, archiveBelow: 0.15, maxActive: 100 })
    expect(store.get('stale')!.status).toBe('archived')
    expect(outcome.archived).toBe(1)
  })

  test('keeps a memory that was used recently', () => {
    store.put(unit({ id: 'fresh', content: 'x', importance: 0.3, lastAccessedAt: NOW - DAY }))
    decay(store, { scopes: ['project:p'], now: NOW, halfLifeDays: 30, archiveBelow: 0.15, maxActive: 100 })
    expect(store.get('fresh')!.status).toBe('active')
  })

  test('never archives a pinned memory', () => {
    store.put(unit({ id: 'pin', content: 'x', importance: 0.01, kind: 'pinned', updatedAt: NOW - 500 * DAY }))
    decay(store, { scopes: ['project:p'], now: NOW, halfLifeDays: 30, archiveBelow: 0.15, maxActive: 100 })
    expect(store.get('pin')!.status).toBe('active')
  })

  test('archives the weakest when a scope exceeds its cap', () => {
    for (let i = 0; i < 5; i += 1) {
      store.put(unit({ id: `m${i}`, content: `x${i}`, importance: 0.5 + i * 0.05, lastAccessedAt: NOW }))
    }
    decay(store, { scopes: ['project:p'], now: NOW, halfLifeDays: 30, archiveBelow: 0, maxActive: 3 })
    expect(store.listActive({ scopes: ['project:p'], limit: 10 })).toHaveLength(3)
    expect(store.get('m0')!.status).toBe('archived')
    expect(store.get('m4')!.status).toBe('active')
  })

  test('deletes nothing, ever', () => {
    store.put(unit({ id: 'stale', content: 'x', importance: 0.01, updatedAt: NOW - 900 * DAY }))
    decay(store, { scopes: ['project:p'], now: NOW, halfLifeDays: 30, archiveBelow: 0.15, maxActive: 1 })
    expect(store.get('stale')).not.toBeNull()
  })
})

describe('abstract', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
    for (let i = 0; i < 5; i += 1) store.put(unit({ id: `m${i}`, content: `第 ${i} 条约定` }))
    for (let i = 1; i < 5; i += 1) store.putEdge({ from: 'm0', to: `m${i}`, weight: 0.9, kind: 'association' })
  })

  test('finds a densely connected group', () => {
    const cluster = findCluster(store, { scopes: ['project:p'], minSize: 4 })
    expect(cluster?.length).toBeGreaterThanOrEqual(4)
  })

  test('returns nothing when no group is large enough', () => {
    expect(findCluster(store, { scopes: ['project:p'], minSize: 20 })).toBeNull()
  })

  test('writes a lower-confidence summary that points back at its sources', async () => {
    const llm = llmSaying('{"summary":"这些约定合起来是接口层规范","facts":[],"keywords":[]}')
    const outcome = await abstractCluster(store, llm, ['m0', 'm1', 'm2', 'm3'], { scope: 'project:p', embedderId: 'lexical-v1', now: NOW })
    expect(outcome.created).not.toBeNull()
    const created = store.get(outcome.created!)!
    expect(created.content).toContain('接口层规范')
    expect(created.derivedFrom).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(created.confidence).toBeLessThan(0.8)
    // Sources stay usable: abstraction adds a layer, it does not replace one.
    for (const id of ['m0', 'm1', 'm2', 'm3']) expect(store.get(id)!.status).toBe('active')
  })

  test('leaves the sources alone when the model output is unusable', async () => {
    const outcome = await abstractCluster(store, llmSaying('说不清'), ['m0', 'm1'], { scope: 'project:p', embedderId: 'lexical-v1', now: NOW })
    expect(outcome.created).toBeNull()
    expect(store.get('m0')!.status).toBe('active')
  })
})

describe('reassociate', () => {
  test('rebuilds edges for the most recent units', async () => {
    const store = openStore({ path: ':memory:' })
    const embedder = new LexicalEmbedder()
    for (let i = 0; i < 15; i += 1) {
      const u = unit({ id: `m${i}`, content: `zod 参数校验的第 ${i} 条约定` })
      store.put(u)
      const [v] = await embedder.embed([u.content])
      store.putVector(u.id, embedder.id, v!)
    }
    const outcome = await reassociate(store, embedder, { scope: 'project:p', window: 10 })
    expect(outcome.processed).toBe(10)
    expect(store.edgeStats('association').count).toBeGreaterThan(0)
  })
})
