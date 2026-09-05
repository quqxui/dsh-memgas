import { describe, expect, test } from 'vitest'
import { formatDiagnostics } from '../src/retrieval/diag.ts'
import type { RetrievalResult } from '../src/retrieval/retriever.ts'
import type { MemoryUnit } from '../src/types.ts'

const unit: MemoryUnit = {
  id: 'm_aaaaaaaaaa', content: 'zod 校验', scope: 'project:p', granularity: 'summary',
  createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
  status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: null,
  provenance: { occurredAt: 1 }, derivedFrom: [],
}

describe('formatDiagnostics', () => {
  test('shows every channel status and each item\'s contributions', () => {
    const result: RetrievalResult = {
      items: [{ unit, score: 0.03, contributions: [{ channel: 'lexical', rank: 1, score: 2.1 }, { channel: 'graph', rank: 3, score: 0.02 }] }],
      channels: [
        { channel: 'lexical', status: 'ok', ms: 2, count: 1 },
        { channel: 'graph', status: 'ok', ms: 5, count: 3 },
        { channel: 'granularity', status: 'skipped', ms: 0, count: 0, reason: 'cold start' },
      ],
      degraded: true,
    }
    const text = formatDiagnostics('zod', result)
    expect(text).toContain('lexical')
    expect(text).toContain('granularity')
    expect(text).toContain('cold start')
    expect(text).toContain('m_aaaaaaaaaa')
    expect(text).toMatch(/lexical#1/)
    expect(text).toMatch(/graph#3/)
  })
})
