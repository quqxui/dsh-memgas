import { describe, expect, test } from 'vitest'
import { planInjection } from '../src/recall/injector.ts'
import type { RetrievalResult, RetrievedMemory } from '../src/retrieval/retriever.ts'
import type { MemoryUnit } from '../src/types.ts'

const unit = (id: string, content = `memory ${id}`): MemoryUnit => ({
  id, content, scope: 'project:p', granularity: 'summary',
  createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
  status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
  provenance: { occurredAt: 1 }, derivedFrom: [],
})

const item = (id: string, contributions: RetrievedMemory['contributions'], content?: string): RetrievedMemory =>
  ({ unit: unit(id, content), score: 0.02, contributions })

const result = (items: RetrievedMemory[]): RetrievalResult => ({ items, channels: [], degraded: false })

const defaults = { denseThreshold: 0.6, budgetTokens: 600, exclude: new Set<string>() }

describe('planInjection', () => {
  test('returns null when nothing was retrieved', () => {
    expect(planInjection(result([]), defaults)).toBeNull()
  })

  test('does not inject a weak single-channel hit', () => {
    const weak = result([item('a', [{ channel: 'dense', rank: 1, score: 0.3 }])])
    expect(planInjection(weak, defaults)).toBeNull()
  })

  test('injects a memory two channels agreed on', () => {
    const agreed = result([item('a', [{ channel: 'lexical', rank: 1, score: 3 }, { channel: 'dense', rank: 2, score: 0.4 }])])
    expect(planInjection(agreed, defaults)?.ids).toEqual(['a'])
  })

  test('injects a memory the dense channel is confident about on its own', () => {
    const confident = result([item('a', [{ channel: 'dense', rank: 1, score: 0.8 }])])
    expect(planInjection(confident, defaults)?.ids).toEqual(['a'])
  })

  test('skips memories already injected in this session', () => {
    const agreed = result([item('a', [{ channel: 'lexical', rank: 1, score: 3 }, { channel: 'dense', rank: 1, score: 0.9 }])])
    expect(planInjection(agreed, { ...defaults, exclude: new Set(['a']) })).toBeNull()
  })

  test('stops adding cards once the token budget is spent', () => {
    const strong = (id: string) => item(id, [{ channel: 'dense', rank: 1, score: 0.9 }], 'x'.repeat(400))
    const many = result([strong('a'), strong('b'), strong('c')])
    const plan = planInjection(many, { ...defaults, budgetTokens: 300 })
    expect(plan?.ids.length).toBe(1)
  })

  test('wraps the cards in a header that tells the model what they are', () => {
    const confident = result([item('a', [{ channel: 'dense', rank: 1, score: 0.8 }], '接口层用 zod 校验')])
    const plan = planInjection(confident, defaults)!
    expect(plan.text).toMatch(/长期记忆/)
    expect(plan.text).toContain('[memory:a')
    expect(plan.text).toContain('接口层用 zod 校验')
  })
})
