import { describe, expect, test } from 'vitest'
import { buildProfileSection } from '../src/recall/profile.ts'
import type { MemoryUnit } from '../src/types.ts'

const unit = (overrides: Partial<MemoryUnit>): MemoryUnit => ({
  id: 'm', content: 'c', scope: 'global', granularity: 'summary',
  createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
  status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
  provenance: { occurredAt: 1 }, derivedFrom: [], kind: 'preference', ...overrides,
})

describe('buildProfileSection', () => {
  test('is empty when there is nothing to say', () => {
    expect(buildProfileSection([], { budgetTokens: 400 })).toBe('')
  })

  test('lists facts with their kind under a heading that names the source', () => {
    const text = buildProfileSection([unit({ id: 'a', content: '回复用中文', kind: 'preference' })], { budgetTokens: 400 })
    expect(text).toMatch(/长期记忆/)
    expect(text).toContain('[preference] 回复用中文')
  })

  test('leaves raw turns and keyword lists out of the profile', () => {
    const text = buildProfileSection([
      unit({ id: 'a', content: 'user: 你好', granularity: 'turn', kind: null }),
      unit({ id: 'b', content: 'zod, vitest', granularity: 'keyword', kind: null }),
      unit({ id: 'c', content: '偏好 pnpm', granularity: 'summary', kind: 'preference' }),
    ], { budgetTokens: 400 })
    expect(text).not.toContain('你好')
    expect(text).not.toContain('vitest')
    expect(text).toContain('偏好 pnpm')
  })

  test('stops before exceeding the token budget', () => {
    const units = Array.from({ length: 20 }, (_, i) => unit({ id: `m${i}`, content: `事实${i} ` + 'x'.repeat(100) }))
    const text = buildProfileSection(units, { budgetTokens: 150 })
    expect(text.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThan(5)
  })
})
