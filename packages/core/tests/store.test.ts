import { beforeEach, describe, expect, test } from 'vitest'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import type { MemoryUnit } from '../src/types.ts'

function unit(overrides: Partial<MemoryUnit> & Pick<MemoryUnit, 'id' | 'content'>): MemoryUnit {
  return {
    scope: 'project:github.com/a/b',
    granularity: 'turn',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    version: 1,
    promptVersion: null,
    embedderId: null,
    provenance: { occurredAt: 1_700_000_000_000 },
    derivedFrom: [],
    ...overrides,
  }
}

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('reads back a stored unit', () => {
    store.put(unit({ id: 'm1', content: '接口层统一用 zod 做参数校验' }))
    expect(store.get('m1')?.content).toBe('接口层统一用 zod 做参数校验')
  })

  test('replaces rather than duplicates a unit with the same id', () => {
    store.put(unit({ id: 'm1', content: '第一版' }))
    store.put(unit({ id: 'm1', content: '第二版', version: 2 }))
    expect(store.get('m1')?.content).toBe('第二版')
    expect(store.countUnits()).toBe(1)
  })

  test('finds a unit by a file path it mentions', () => {
    store.put(unit({ id: 'm1', content: '把 packages/core/src/store.ts 的超时改成 500ms' }))
    store.put(unit({ id: 'm2', content: '今天讨论了发布流程' }))
    expect(store.searchLexical('store.ts 超时', { limit: 5 }).map(c => c.id)).toEqual(['m1'])
  })

  test('survives FTS5 syntax characters in a user query', () => {
    store.put(unit({ id: 'm1', content: 'zod 校验' }))
    expect(() => store.searchLexical('"zod" AND * OR (校验', { limit: 5 })).not.toThrow()
  })

  test('limits lexical search to the requested scopes', () => {
    store.put(unit({ id: 'm1', content: 'zod 校验', scope: 'project:github.com/a/b' }))
    store.put(unit({ id: 'm2', content: 'zod 校验', scope: 'global' }))
    expect(store.searchLexical('zod', { scopes: ['global'], limit: 5 }).map(c => c.id)).toEqual(['m2'])
  })

  test('excludes archived units from search', () => {
    store.put(unit({ id: 'm1', content: 'zod 校验', status: 'archived' }))
    expect(store.searchLexical('zod', { limit: 5 })).toHaveLength(0)
  })

  test('ranks the nearest vector first in dense search', () => {
    store.put(unit({ id: 'near', content: 'a', embedderId: 'e1' }))
    store.put(unit({ id: 'far', content: 'b', embedderId: 'e1' }))
    store.putVector('near', 'e1', Float32Array.from([1, 0]))
    store.putVector('far', 'e1', Float32Array.from([0, 1]))
    const hits = store.searchDense(Float32Array.from([0.9, 0.1]), { embedderId: 'e1', limit: 2 })
    expect(hits[0]!.id).toBe('near')
  })

  test('never compares vectors across embedders', () => {
    store.put(unit({ id: 'old', content: 'a', embedderId: 'lexical-v1' }))
    store.putVector('old', 'lexical-v1', Float32Array.from([1, 0]))
    expect(store.searchDense(Float32Array.from([1, 0]), { embedderId: 'e5-small', limit: 5 })).toHaveLength(0)
  })

  test('reports which lexical index backend is in use', () => {
    expect(store.capabilities.lexicalIndex).toBe('fts5')
  })

  test('still searches lexically when FTS5 is unavailable', () => {
    const fallback = openStore({ path: ':memory:', forceLexicalFallback: true })
    fallback.put(unit({ id: 'm1', content: '把 packages/core/src/store.ts 的超时改成 500ms' }))
    fallback.put(unit({ id: 'm2', content: '今天讨论了发布流程' }))
    expect(fallback.capabilities.lexicalIndex).toBe('memory')
    expect(fallback.searchLexical('store.ts 超时', { limit: 5 }).map(c => c.id)).toEqual(['m1'])
  })
})
