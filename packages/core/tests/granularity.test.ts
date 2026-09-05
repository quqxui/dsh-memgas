import { describe, expect, test } from 'vitest'
import { entropyWeights, granularityChannel } from '../src/retrieval/granularity-channel.ts'
import { openStore } from '../src/store/store.ts'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import type { MemoryUnit } from '../src/types.ts'

describe('entropyWeights', () => {
  test('gives more weight to the granularity whose scores single out a match', () => {
    const weights = entropyWeights({
      keyword: [0.95, 0.1, 0.1, 0.1],
      turn: [0.4, 0.4, 0.4, 0.4],
    }, { lambda: 0.1 })
    expect(weights.weights['keyword']).toBeGreaterThan(weights.weights['turn']!)
    expect(weights.degraded).toBe(false)
  })

  test('falls back to uniform weights when no granularity is more certain than another', () => {
    const weights = entropyWeights({ keyword: [0.4, 0.4, 0.4], turn: [0.5, 0.5, 0.5] }, { lambda: 0.1 })
    expect(weights.weights['keyword']).toBeCloseTo(weights.weights['turn']!)
    expect(weights.degraded).toBe(true)
  })

  test('ignores granularities with no candidates', () => {
    const weights = entropyWeights({ keyword: [], turn: [0.9, 0.1] }, { lambda: 0.1 })
    expect(weights.weights['keyword']).toBeUndefined()
    expect(weights.weights['turn']).toBeCloseTo(1)
  })
})

describe('granularityChannel', () => {
  const unit = (id: string, granularity: MemoryUnit['granularity'], content: string): MemoryUnit => ({
    id, content, scope: 'project:p', granularity,
    createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
    status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: 'lexical-v1',
    provenance: { occurredAt: 1 }, derivedFrom: [],
  })

  test('returns candidates from every granularity, scored by routed weight times similarity', async () => {
    const store = openStore({ path: ':memory:' })
    const embedder = new LexicalEmbedder()
    const units = [
      unit('k', 'keyword', 'zod, vitest, pnpm'),
      unit('s', 'summary', '接口层统一用 zod 做参数校验'),
      unit('t', 'turn', 'user: 今天聊聊发布流程\nassistant: 好'),
    ]
    for (const u of units) {
      store.put(u)
      const [v] = await embedder.embed([u.content])
      store.putVector(u.id, embedder.id, v!)
    }
    const channel = granularityChannel(store, embedder, { lambda: 0.1 })
    const candidates = await channel.retrieve({ query: 'zod 参数校验', scopes: ['project:p'], k: 5 })
    expect(candidates.map(c => c.id)).toContain('s')
    expect(candidates.find(c => c.id === 's')!.score).toBeGreaterThan(candidates.find(c => c.id === 't')?.score ?? 0)
    expect(channel.name).toBe('granularity')
    expect(channel.baseline).toBe(false)
  })
})
