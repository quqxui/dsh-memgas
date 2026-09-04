import { describe, expect, test } from 'vitest'
import { createMemoryService, type MemoryUnit } from '@memgas/core'
import { formatCard, handleSave, handleSearch, handleStatus } from '../src/handlers.ts'

const unit = (overrides: Partial<MemoryUnit> = {}): MemoryUnit => ({
  id: 'm_8f3a',
  scope: 'project:github.com/a/b',
  granularity: 'summary',
  content: '接口层统一用 zod 做参数校验',
  createdAt: Date.UTC(2026, 7, 29),
  updatedAt: Date.UTC(2026, 7, 29),
  importance: 0.86,
  accessCount: 0,
  lastAccessedAt: null,
  status: 'active',
  supersededBy: null,
  version: 1,
  promptVersion: null,
  embedderId: 'lexical-v1',
  provenance: { occurredAt: Date.UTC(2026, 7, 29), sessionId: 's_1' },
  derivedFrom: [],
  ...overrides,
})

describe('formatCard', () => {
  test('renders id, scope, date, granularity and content', () => {
    const card = formatCard(unit())
    expect(card).toContain('[memory:m_8f3a')
    expect(card).toContain('project')
    expect(card).toContain('2026-08-29')
    expect(card).toContain('summary')
    expect(card).toContain('接口层统一用 zod 做参数校验')
  })

  test('labels a global memory as global rather than printing the raw scope key', () => {
    expect(formatCard(unit({ scope: 'global' }))).toContain('global')
  })
})

describe('handleSearch', () => {
  test('returns one card per hit', async () => {
    const memory = createMemoryService({ path: ':memory:' })
    await memory.save({ content: '接口层统一用 zod 做参数校验', scope: 'project:p' })
    const output = await handleSearch(memory, { query: 'zod', scope: 'project:p' })
    expect(output).toContain('[memory:')
    expect(output).toContain('zod')
  })

  test('says plainly when nothing matched', async () => {
    const memory = createMemoryService({ path: ':memory:' })
    const output = await handleSearch(memory, { query: 'kubernetes', scope: 'project:p' })
    expect(output).toContain('没有找到')
  })
})

describe('handleSave', () => {
  test('confirms with the id it stored', async () => {
    const memory = createMemoryService({ path: ':memory:' })
    const output = await handleSave(memory, { content: '部署端口是 8080', scope: 'project:p' })
    expect(output).toMatch(/m_[0-9a-f]+/)
    expect(memory.status().units).toBe(1)
  })

  test('reports that nothing was stored for blank content', async () => {
    const memory = createMemoryService({ path: ':memory:' })
    const output = await handleSave(memory, { content: '  ', scope: 'project:p' })
    expect(output).toContain('未写入')
    expect(memory.status().units).toBe(0)
  })
})

describe('handleStatus', () => {
  test('reports store size, embedder and index backend', async () => {
    const memory = createMemoryService({ path: ':memory:' })
    await memory.save({ content: '一条记忆', scope: 'project:p' })
    const output = handleStatus(memory)
    expect(output).toContain('1')
    expect(output).toContain('lexical-v1')
    expect(output).toContain('fts5')
  })
})
