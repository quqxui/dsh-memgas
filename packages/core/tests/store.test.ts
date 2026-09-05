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

describe('MemoryStore extensions', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('round-trips fact kind and confidence', () => {
    store.put(unit({ id: 'm1', content: 'c', kind: 'decision', confidence: 0.8 }))
    expect(store.get('m1')).toMatchObject({ kind: 'decision', confidence: 0.8 })
  })

  test('stores string metadata such as harvest cursors', () => {
    expect(store.getMeta('cursor:s1')).toBeNull()
    store.setMeta('cursor:s1', '12')
    expect(store.getMeta('cursor:s1')).toBe('12')
    store.setMeta('cursor:s1', '13')
    expect(store.getMeta('cursor:s1')).toBe('13')
  })

  test('touch bumps access count and last access time without changing content', () => {
    store.put(unit({ id: 'm1', content: 'c' }))
    store.touch(['m1', 'missing'], 1_800_000_000_000)
    expect(store.get('m1')).toMatchObject({ accessCount: 1, lastAccessedAt: 1_800_000_000_000, content: 'c' })
  })

  test('lists active units of a scope by importance, most important first', () => {
    store.put(unit({ id: 'low', content: 'a', scope: 'global', importance: 0.2 }))
    store.put(unit({ id: 'high', content: 'b', scope: 'global', importance: 0.9 }))
    store.put(unit({ id: 'archived', content: 'c', scope: 'global', importance: 1, status: 'archived' }))
    store.put(unit({ id: 'elsewhere', content: 'd', scope: 'project:p', importance: 1 }))
    expect(store.listActive({ scopes: ['global'], limit: 10 }).map(u => u.id)).toEqual(['high', 'low'])
  })

  test('listActive can be narrowed to fact kinds', () => {
    store.put(unit({ id: 'pref', content: 'a', scope: 'global', kind: 'preference' }))
    store.put(unit({ id: 'todo', content: 'b', scope: 'global', kind: 'todo' }))
    expect(store.listActive({ scopes: ['global'], limit: 10, kinds: ['preference'] }).map(u => u.id)).toEqual(['pref'])
  })
})

describe('MemoryStore graph and unit patching', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('dense search can be limited to granularities', () => {
    store.put(unit({ id: 'k', content: 'a', granularity: 'keyword', embedderId: 'e' }))
    store.put(unit({ id: 't', content: 'b', granularity: 'turn', embedderId: 'e' }))
    store.putVector('k', 'e', Float32Array.from([1, 0]))
    store.putVector('t', 'e', Float32Array.from([1, 0]))
    expect(store.searchDense(Float32Array.from([1, 0]), { embedderId: 'e', limit: 5, granularities: ['keyword'] }).map(c => c.id)).toEqual(['k'])
  })

  test('upserts edges and lists every edge touching the given ids', () => {
    store.putEdge({ from: 'a', to: 'b', weight: 0.5, kind: 'association' })
    store.putEdge({ from: 'a', to: 'b', weight: 0.9, kind: 'association' })
    store.putEdge({ from: 'b', to: 'c', weight: 0.2, kind: 'coRetrieval' })
    const edges = store.edges(['a'])
    expect(edges).toEqual([{ from: 'a', to: 'b', weight: 0.9, kind: 'association' }])
    expect(store.edges(['b'], { kinds: ['coRetrieval'] })).toHaveLength(1)
  })

  test('reports edge statistics for health checks', () => {
    store.putEdge({ from: 'a', to: 'b', weight: 1, kind: 'association' })
    store.putEdge({ from: 'a', to: 'c', weight: 1, kind: 'association' })
    store.putEdge({ from: 'a', to: 'd', weight: 1, kind: 'association' })
    const stats = store.edgeStats('association')
    expect(stats).toMatchObject({ count: 3, maxDegree: 3 })
    expect(stats.avgDegree).toBeCloseTo(1.5)
  })

  test('deletes a single edge', () => {
    store.putEdge({ from: 'a', to: 'b', weight: 1, kind: 'association' })
    store.deleteEdge({ from: 'a', to: 'b', kind: 'association' })
    expect(store.edges(['a'])).toEqual([])
  })

  test('patches mutable fields of a unit in place', () => {
    store.put(unit({ id: 'm1', content: 'c' }))
    store.patch('m1', { status: 'superseded', supersededBy: 'm2', importance: 0.1 })
    expect(store.get('m1')).toMatchObject({ status: 'superseded', supersededBy: 'm2', importance: 0.1, content: 'c' })
  })

  test('lists units filtered by status and granularity', () => {
    store.put(unit({ id: 'a', content: 'a', status: 'pending', granularity: 'summary' }))
    store.put(unit({ id: 'b', content: 'b', status: 'active', granularity: 'summary' }))
    store.put(unit({ id: 'c', content: 'c', status: 'active', granularity: 'turn' }))
    expect(store.listUnits({ scopes: ['project:github.com/a/b'], statuses: ['pending'], limit: 10 }).map(u => u.id)).toEqual(['a'])
    expect(store.listUnits({ scopes: ['project:github.com/a/b'], statuses: ['active'], granularities: ['turn'], limit: 10 }).map(u => u.id)).toEqual(['c'])
  })

  test('purges every unit, vector and edge of a scope', () => {
    store.put(unit({ id: 'a', content: 'a', scope: 'project:x' }))
    store.put(unit({ id: 'b', content: 'b', scope: 'global' }))
    store.putEdge({ from: 'a', to: 'b', weight: 1, kind: 'association' })
    store.purgeScope('project:x')
    expect(store.get('a')).toBeNull()
    expect(store.get('b')).not.toBeNull()
    expect(store.edges(['a'])).toEqual([])
  })
})
