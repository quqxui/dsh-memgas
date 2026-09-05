import { describe, expect, test } from 'vitest'
import { filterResults } from '../src/retrieval/filter.ts'
import { buildFilterPrompt, FILTER_PROMPT_VERSION } from '../src/prompts/filter-results.ts'
import type { RetrievedMemory } from '../src/retrieval/retriever.ts'
import type { MemoryUnit } from '../src/types.ts'

const item = (id: string, content: string): RetrievedMemory => ({
  unit: {
    id, content, scope: 'project:p', granularity: 'summary',
    createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
    status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
    provenance: { occurredAt: 1 }, derivedFrom: [],
  } as MemoryUnit,
  score: 1,
  contributions: [],
})

const llmSaying = (reply: string) => ({ async complete() { return reply } })

describe('filterResults', () => {
  const items = [item('m_aaaaaaaaaa', 'zod 校验'), item('m_bbbbbbbbbb', '发布流程'), item('m_cccccccccc', 'zod 版本')]

  test('keeps exactly the ids the model selected', async () => {
    const kept = await filterResults(llmSaying('{"keep":["m_aaaaaaaaaa","m_cccccccccc"]}'), 'zod', items, { minKeep: 1 })
    expect(kept.items.map(i => i.unit.id)).toEqual(['m_aaaaaaaaaa', 'm_cccccccccc'])
    expect(kept.applied).toBe(true)
  })

  test('returns the unfiltered list when the model output is unusable', async () => {
    const kept = await filterResults(llmSaying('无法判断'), 'zod', items, { minKeep: 1 })
    expect(kept.items).toHaveLength(3)
    expect(kept.applied).toBe(false)
  })

  test('returns the unfiltered list when the model would leave too few', async () => {
    const kept = await filterResults(llmSaying('{"keep":[]}'), 'zod', items, { minKeep: 1 })
    expect(kept.items).toHaveLength(3)
    expect(kept.applied).toBe(false)
  })

  test('ignores ids the model invented', async () => {
    const kept = await filterResults(llmSaying('{"keep":["m_aaaaaaaaaa","m_zzzzzzzzzz"]}'), 'zod', items, { minKeep: 1 })
    expect(kept.items.map(i => i.unit.id)).toEqual(['m_aaaaaaaaaa'])
  })
})

describe('buildFilterPrompt', () => {
  test('lists every candidate with its id and is versioned', () => {
    const built = buildFilterPrompt({ query: 'zod', cards: [{ id: 'm_aaaaaaaaaa', text: 'zod 校验' }] })
    expect(built.prompt).toContain('m_aaaaaaaaaa')
    expect(built.prompt).toContain('zod 校验')
    expect(built.version).toBe(FILTER_PROMPT_VERSION)
  })
})
