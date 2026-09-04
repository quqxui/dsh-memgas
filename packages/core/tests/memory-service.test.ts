import { describe, expect, test } from 'vitest'
import { createMemoryService } from '../src/service.ts'

const service = () => createMemoryService({ path: ':memory:' })

describe('MemoryService', () => {
  test('makes a saved memory findable by a word it contains', async () => {
    const memory = service()
    await memory.save({ content: '接口层统一用 zod 做参数校验', scope: 'project:p' })
    const result = await memory.search({ query: 'zod 校验', scopes: ['project:p'], k: 5 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.unit.content).toContain('zod')
  })

  test('strips credentials before they reach the store', async () => {
    const memory = service()
    const saved = await memory.save({ content: '线上用 api_key = "sk-abcd1234abcd1234abcd" 调用', scope: 'global' })
    expect(saved!.content).not.toContain('sk-abcd1234abcd1234abcd')
    expect(memory.status().redactions).toBe(1)
  })

  test('gives every memory a short hex id', async () => {
    const memory = service()
    const saved = await memory.save({ content: '一条记忆', scope: 'global' })
    expect(saved!.id).toMatch(/^m_[0-9a-f]{10}$/)
  })

  test('refuses to store content that is empty after trimming', async () => {
    const memory = service()
    expect(await memory.save({ content: '   ', scope: 'global' })).toBeNull()
    expect(memory.status().units).toBe(0)
  })

  test('finds a paraphrase through the dense channel when wording differs', async () => {
    const memory = service()
    await memory.save({ content: '参数校验统一走 zod', scope: 'project:p' })
    const result = await memory.search({ query: '统一 zod 参数', scopes: ['project:p'], k: 5 })
    expect(result.items.map(item => item.contributions.map(c => c.channel)).flat()).toContain('dense')
  })

  test('reports both baseline channels for a query that both matched', async () => {
    const memory = service()
    await memory.save({ content: '把 packages/core/src/store.ts 的超时改成 500ms', scope: 'project:p' })
    const result = await memory.search({ query: 'store.ts 超时', scopes: ['project:p'], k: 5 })
    const channels = result.channels.map(report => report.channel).sort()
    expect(channels).toEqual(['dense', 'lexical'])
    expect(result.channels.every(report => report.status === 'ok')).toBe(true)
  })

  test('returns an empty result rather than an error when nothing matches', async () => {
    const memory = service()
    await memory.save({ content: '发布流程', scope: 'project:p' })
    const result = await memory.search({ query: 'kubernetes 扩容', scopes: ['project:p'], k: 5 })
    expect(result.items).toEqual([])
  })

  test('reports embedder and index backend in status', async () => {
    const memory = service()
    expect(memory.status().embedder).toBe('lexical-v1')
    expect(memory.status().lexicalIndex).toBe('fts5')
  })
})
