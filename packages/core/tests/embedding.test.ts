import { describe, expect, test } from 'vitest'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import { cosine } from '../src/embedding/vector.ts'

describe('cosine', () => {
  test('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
  })

  test('returns 0 rather than NaN when a vector is all zeros', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0)
  })
})

describe('LexicalEmbedder', () => {
  const embedder = new LexicalEmbedder()

  test('is deterministic across calls', async () => {
    const [a] = await embedder.embed(['接口层统一用 zod 做参数校验'])
    const [b] = await embedder.embed(['接口层统一用 zod 做参数校验'])
    expect(Array.from(a!)).toEqual(Array.from(b!))
  })

  test('produces unit-length vectors', async () => {
    const [v] = await embedder.embed(['packages/core/src/store.ts'])
    let sum = 0
    for (const x of v!) sum += x * x
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5)
  })

  test('scores a paraphrase above an unrelated sentence', async () => {
    const [query, related, unrelated] = await embedder.embed([
      '用 zod 做参数校验',
      '参数校验统一用 zod',
      '把日志级别调成 debug',
    ])
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!))
  })

  test('handles empty text without producing NaN', async () => {
    const [v] = await embedder.embed([''])
    expect(Array.from(v!).some(Number.isNaN)).toBe(false)
  })

  test('reports a stable id so stored vectors can be matched to their model', () => {
    expect(embedder.id).toBe('lexical-v1')
  })
})
