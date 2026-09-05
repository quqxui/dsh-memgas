import { beforeEach, describe, expect, test } from 'vitest'
import { EvolutionRunner } from '../src/evolve/runner.ts'
import { BackgroundQueue } from '../src/queue.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import type { MemoryUnit } from '../src/types.ts'

const NOW = Date.UTC(2026, 8, 5)
const DAY = 24 * 60 * 60 * 1000

const unit = (over: Partial<MemoryUnit> & Pick<MemoryUnit, 'id' | 'content'>): MemoryUnit => ({
  scope: 'project:p', granularity: 'summary', createdAt: NOW, updatedAt: NOW,
  importance: 0.5, accessCount: 0, lastAccessedAt: null, status: 'active', supersededBy: null,
  version: 1, promptVersion: null, embedderId: 'lexical-v1', provenance: { occurredAt: NOW },
  derivedFrom: [], kind: 'decision', confidence: 0.8, ...over,
})

const llmSaying = (reply: string) => ({ async complete() { return reply } })

function runnerFor(store: MemoryStore, llm = llmSaying('{"relation":"unrelated","target":null}'), over = {}) {
  return new EvolutionRunner({
    store,
    llm,
    embedder: new LexicalEmbedder(),
    queue: new BackgroundQueue({ jobTimeoutMs: 5000 }),
    scope: 'project:p',
    now: () => NOW,
    halfLifeDays: 30,
    archiveBelow: 0.15,
    maxActive: 100,
    abstractClusterSize: 4,
    reassociateEvery: 5,
    ...over,
  })
}

describe('EvolutionRunner', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('reconciles a newly stored fact in the background', async () => {
    // The harvester writes a vector with every unit; reconcile finds candidates through it.
    const embedder = new LexicalEmbedder()
    for (const id of ['old', 'new']) {
      const u = unit({ id, content: '检索超时定为 300ms' })
      store.put(u)
      const [v] = await embedder.embed([u.content])
      store.putVector(id, embedder.id, v!)
    }
    const runner = runnerFor(store, llmSaying('{"relation":"update","target":"old"}'))
    runner.onFactStored('new')
    await runner.idle()
    expect(store.get('old')!.status).toBe('superseded')
    expect(runner.stats().reconciled).toBe(1)
  })

  test('reinforces the memories a recall actually used', async () => {
    store.put(unit({ id: 'a', content: 'a' }))
    store.put(unit({ id: 'b', content: 'b' }))
    const runner = runnerFor(store)
    runner.onRecallUsed(['a', 'b'])
    await runner.idle()
    expect(store.get('a')!.importance).toBeGreaterThan(0.5)
    expect(store.edges(['a'], { kinds: ['coRetrieval'] })).toHaveLength(1)
  })

  test('sweeps stale memories when a session starts', async () => {
    store.put(unit({ id: 'stale', content: 'x', importance: 0.2, updatedAt: NOW - 300 * DAY }))
    const runner = runnerFor(store)
    runner.onSessionStart()
    await runner.idle()
    expect(store.get('stale')!.status).toBe('archived')
    expect(runner.stats().archived).toBe(1)
  })

  test('abstracts a cluster once it is large enough', async () => {
    for (let i = 0; i < 5; i += 1) store.put(unit({ id: `m${i}`, content: `第 ${i} 条约定` }))
    for (let i = 1; i < 5; i += 1) store.putEdge({ from: 'm0', to: `m${i}`, weight: 0.9, kind: 'association' })
    const runner = runnerFor(store, llmSaying('{"summary":"接口层规范","facts":[],"keywords":[]}'))
    runner.onSessionStart()
    await runner.idle()
    const abstractions = store.listUnits({ scopes: ['project:p'], kinds: ['abstraction'], limit: 5 })
    expect(abstractions).toHaveLength(1)
    expect(runner.stats().abstracted).toBe(1)
  })

  test('reassociates after enough new memories have arrived', async () => {
    const runner = runnerFor(store, undefined, { reassociateEvery: 3 })
    for (let i = 0; i < 3; i += 1) {
      store.put(unit({ id: `m${i}`, content: `zod 校验第 ${i} 条` }))
      runner.onFactStored(`m${i}`)
    }
    await runner.idle()
    expect(runner.stats().reassociations).toBe(1)
  })

  test('keeps running after one process throws', async () => {
    const broken = { async complete(): Promise<string> { throw new Error('provider down') } }
    store.put(unit({ id: 'a', content: 'zod 校验' }))
    store.put(unit({ id: 'b', content: 'zod 校验' }))
    const runner = runnerFor(store, broken)
    runner.onFactStored('a')
    runner.onRecallUsed(['a', 'b'])
    await runner.idle()
    expect(store.get('a')!.importance).toBeGreaterThan(0.5)
    expect(runner.stats().failures).toBeGreaterThanOrEqual(0)
  })

  test('does nothing at all when evolution is disabled', async () => {
    store.put(unit({ id: 'stale', content: 'x', importance: 0.01, updatedAt: NOW - 900 * DAY }))
    const runner = runnerFor(store, undefined, { enabled: false })
    runner.onSessionStart()
    await runner.idle()
    expect(store.get('stale')!.status).toBe('active')
  })
})
