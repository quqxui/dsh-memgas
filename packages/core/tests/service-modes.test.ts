import { describe, expect, test } from 'vitest'
import { createMemoryService } from '../src/service.ts'
import type { Embedder } from '../src/embedding/types.ts'

const svc = (mode: 'lite' | 'hybrid' | 'memgas') => createMemoryService({ path: ':memory:', mode, coldStartUnits: 0 })

/**
 * Assigns each distinct topic its own dimension, so unrelated memories are
 * genuinely orthogonal. The hashed lexical fallback cannot express that: on a
 * small store its collisions make almost everything look slightly similar.
 */
class TopicEmbedder implements Embedder {
  readonly id = 'topic-test'
  readonly dimensions = 8
  private readonly topics = ['zod', 'problem+json', '周会', '磁盘', 'echarts', 'vercel', '飞书']
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text => {
      const vector = new Float32Array(this.dimensions)
      this.topics.forEach((topic, index) => { if (text.includes(topic)) vector[index] = 1 })
      return vector
    })
  }
}

describe('MemoryService retrieval modes', () => {
  test('lite reports only the two baseline channels', async () => {
    const memory = svc('lite')
    await memory.save({ content: 'zod 校验', scope: 'project:p' })
    const result = await memory.search({ query: 'zod', scopes: ['project:p'], k: 5 })
    expect(result.channels.map(c => c.channel).sort()).toEqual(['dense', 'lexical'])
  })

  test('hybrid reports all four channels', async () => {
    const memory = svc('hybrid')
    await memory.save({ content: 'zod 校验', scope: 'project:p' })
    const result = await memory.search({ query: 'zod', scopes: ['project:p'], k: 5 })
    expect(result.channels.map(c => c.channel).sort()).toEqual(['dense', 'granularity', 'graph', 'lexical'])
  })

  test('an enhancement channel never evicts a baseline hit', async () => {
    const memory = svc('memgas')
    const saved = []
    for (const content of ['zod 参数校验约定', '发布流程用 pnpm', '超时改成 500ms', '日志级别 debug']) {
      saved.push(await memory.save({ content, scope: 'project:p' }))
    }
    // Wire every memory to every other one so the graph channel is maximally noisy.
    for (const a of saved) for (const b of saved) {
      if (a && b && a.id !== b.id) memory.store.putEdge({ from: a.id, to: b.id, weight: 1, kind: 'association' })
    }
    const result = await memory.search({ query: 'zod 参数校验', scopes: ['project:p'], k: 2 })
    const baselineIds = new Set(
      (await memory.search({ query: 'zod 参数校验', scopes: ['project:p'], k: 2, mode: 'lite' })).items.map(i => i.unit.id),
    )
    const kept = result.items.filter(item => baselineIds.has(item.unit.id))
    expect(kept.length).toBeGreaterThanOrEqual(1)
  })

  test('the graph channel surfaces a memory the baseline channels cannot reach', async () => {
    const memory = createMemoryService({
      path: ':memory:', mode: 'memgas', coldStartUnits: 0, embedder: new TopicEmbedder(),
    })
    const anchor = (await memory.save({ content: 'zod 参数校验约定', scope: 'project:p' }))!
    // Shares no vocabulary with the query: only the association edge connects them.
    const linked = (await memory.save({ content: '错误码统一走 problem+json', scope: 'project:p' }))!
    memory.store.putEdge({ from: anchor.id, to: linked.id, weight: 0.9, kind: 'association' })
    for (const content of ['周会改到周三', '磁盘扩容到 2T', '图表换成 echarts', '站点部署在 vercel', '告警接入飞书']) {
      const filler = (await memory.save({ content, scope: 'project:p' }))!
      memory.store.putEdge({ from: filler.id, to: anchor.id, weight: 0.1, kind: 'association' })
    }

    const lite = await memory.search({ query: 'zod 参数校验', scopes: ['project:p'], k: 5, mode: 'lite' })
    const memgas = await memory.search({ query: 'zod 参数校验', scopes: ['project:p'], k: 5 })
    expect(lite.items.map(i => i.unit.id)).not.toContain(linked.id)
    expect(memgas.items.map(i => i.unit.id)).toContain(linked.id)
    expect(memgas.items.find(i => i.unit.id === linked.id)!.contributions.map(c => c.channel)).toContain('graph')
  })

  test('the enhancement channels leave the baseline hit at the top', async () => {
    const memory = createMemoryService({
      path: ':memory:', mode: 'memgas', coldStartUnits: 0, embedder: new TopicEmbedder(),
    })
    const anchor = (await memory.save({ content: 'zod 参数校验约定', scope: 'project:p' }))!
    const linked = (await memory.save({ content: '错误码统一走 problem+json', scope: 'project:p' }))!
    memory.store.putEdge({ from: anchor.id, to: linked.id, weight: 0.9, kind: 'association' })
    const result = await memory.search({ query: 'zod 参数校验', scopes: ['project:p'], k: 5 })
    expect(result.items[0]!.unit.id).toBe(anchor.id)
  })

  test('associates a new memory with its neighbours as it is saved', async () => {
    const memory = createMemoryService({ path: ':memory:', mode: 'hybrid', coldStartUnits: 0, associateOnSave: true })
    for (let i = 0; i < 12; i += 1) await memory.save({ content: `zod 参数校验的第 ${i} 条约定`, scope: 'project:p' })
    const latest = (await memory.save({ content: 'zod 参数校验还有一条约定', scope: 'project:p' }))!
    expect(memory.store.edges([latest.id], { kinds: ['association'] }).length).toBeGreaterThan(0)
  })

  test('a per-call mode override beats the configured mode', async () => {
    const memory = svc('hybrid')
    await memory.save({ content: 'zod 校验', scope: 'project:p' })
    const result = await memory.search({ query: 'zod', scopes: ['project:p'], k: 5, mode: 'lite' })
    expect(result.channels.map(c => c.channel).sort()).toEqual(['dense', 'lexical'])
  })
})
