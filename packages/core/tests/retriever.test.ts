import { beforeEach, describe, expect, test } from 'vitest'
import { Retriever, type RetrievalChannel } from '../src/retrieval/retriever.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import type { MemoryUnit } from '../src/types.ts'

function unit(id: string, content: string): MemoryUnit {
  return {
    id, content, scope: 'project:p', granularity: 'turn',
    createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
    status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
    provenance: { occurredAt: 1 }, derivedFrom: [],
  }
}

const channelOf = (name: string, baseline: boolean, ids: string[]): RetrievalChannel => ({
  name,
  baseline,
  async retrieve() {
    return ids.map((id, i) => ({ id, score: 1 - i * 0.1 }))
  },
})

const failing = (name: string): RetrievalChannel => ({
  name,
  baseline: false,
  async retrieve() {
    throw new Error('graph index corrupt')
  },
})

const slow = (name: string, ms: number): RetrievalChannel => ({
  name,
  baseline: false,
  async retrieve() {
    await new Promise(resolve => setTimeout(resolve, ms))
    return [{ id: 'slow', score: 1 }]
  },
})

describe('Retriever', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) store.put(unit(id, `memory ${id}`))
  })

  test('returns hydrated memories with per-channel attribution', async () => {
    const retriever = new Retriever({ store, channels: [channelOf('lexical', true, ['a', 'b'])] })
    const result = await retriever.retrieve({ query: 'memory', k: 2 })
    expect(result.items.map(item => item.unit.id)).toEqual(['a', 'b'])
    expect(result.items[0]!.contributions[0]!.channel).toBe('lexical')
  })

  test('keeps serving results when an enhancement channel throws', async () => {
    const retriever = new Retriever({
      store,
      channels: [channelOf('lexical', true, ['a']), failing('graph')],
      coldStartUnits: 0,
    })
    const result = await retriever.retrieve({ query: 'memory', k: 3 })
    expect(result.items.map(item => item.unit.id)).toEqual(['a'])
    const graph = result.channels.find(report => report.channel === 'graph')!
    expect(graph.status).toBe('failed')
    expect(graph.reason).toContain('graph index corrupt')
    expect(result.degraded).toBe(true)
  })

  test('drops a channel that blows its timeout without dropping the others', async () => {
    const retriever = new Retriever({
      store,
      channels: [channelOf('dense', true, ['a']), slow('graph', 200)],
      channelTimeoutMs: 20,
      coldStartUnits: 0,
    })
    const result = await retriever.retrieve({ query: 'memory', k: 3 })
    expect(result.items.map(item => item.unit.id)).toEqual(['a'])
    expect(result.channels.find(report => report.channel === 'graph')!.status).toBe('timeout')
  })

  test('honours a tighter per-request budget than the configured timeout', async () => {
    const retriever = new Retriever({
      store,
      channels: [{ ...slow('dense', 100), baseline: true }],
      channelTimeoutMs: 1000,
    })
    const result = await retriever.retrieve({ query: 'memory', k: 3, budgetMs: 10 })
    expect(result.channels[0]!.status).toBe('timeout')
  })

  test('skips enhancement channels until the store leaves cold start', async () => {
    const retriever = new Retriever({
      store,
      channels: [channelOf('lexical', true, ['a']), channelOf('graph', false, ['b'])],
      coldStartUnits: 50,
    })
    const result = await retriever.retrieve({ query: 'memory', k: 3 })
    expect(result.items.map(item => item.unit.id)).toEqual(['a'])
    expect(result.channels.find(report => report.channel === 'graph')!.status).toBe('skipped')
  })

  test('reserves slots for baseline channels when an enhancement channel dominates', async () => {
    const retriever = new Retriever({
      store,
      channels: [channelOf('dense', true, ['a', 'b']), channelOf('graph', false, ['c', 'd', 'e', 'f'])],
      weights: { graph: 10, dense: 1 },
      coldStartUnits: 0,
      baselineFloor: 0.5,
    })
    const result = await retriever.retrieve({ query: 'memory', k: 4 })
    const baselineBacked = result.items.filter(item =>
      item.contributions.some(contribution => contribution.channel === 'dense'))
    expect(baselineBacked.length).toBeGreaterThanOrEqual(2)
  })

  test('returns an empty result instead of throwing when every channel fails', async () => {
    const retriever = new Retriever({ store, channels: [failing('lexical'), failing('graph')], coldStartUnits: 0 })
    const result = await retriever.retrieve({ query: 'memory', k: 3 })
    expect(result.items).toEqual([])
    expect(result.degraded).toBe(true)
  })

  test('drops memories that vanished from the store between indexing and hydration', async () => {
    const retriever = new Retriever({ store, channels: [channelOf('lexical', true, ['a', 'ghost'])] })
    const result = await retriever.retrieve({ query: 'memory', k: 5 })
    expect(result.items.map(item => item.unit.id)).toEqual(['a'])
  })
})
