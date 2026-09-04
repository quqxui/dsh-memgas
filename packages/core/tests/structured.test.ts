import { describe, expect, test } from 'vitest'
import { parseStructured } from '../src/llm/structured.ts'
import { validateExtraction, type MemoryExtraction } from '../src/prompts/extraction.ts'

const asIs = (value: unknown) => value as Record<string, unknown>

describe('parseStructured', () => {
  test('parses a clean JSON object', () => {
    expect(parseStructured('{"a":1}', asIs)).toEqual({ ok: true, value: { a: 1 } })
  })

  test('strips a markdown code fence around the JSON', () => {
    const raw = '```json\n{"a":1}\n```'
    expect(parseStructured(raw, asIs)).toEqual({ ok: true, value: { a: 1 } })
  })

  test('finds the object when the model wrapped it in prose', () => {
    const raw = '好的，结果如下：\n{"a":{"b":[1,2]}}\n希望有帮助。'
    expect(parseStructured(raw, asIs)).toEqual({ ok: true, value: { a: { b: [1, 2] } } })
  })

  test('reports invalid JSON instead of throwing', () => {
    const result = parseStructured('{"a":', asIs)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('JSON')
  })

  test('reports a validator rejection with its reason', () => {
    const result = parseStructured('{"a":1}', () => { throw new Error('missing field b') })
    expect(result).toEqual({ ok: false, reason: 'missing field b' })
  })
})

describe('validateExtraction', () => {
  test('accepts the empty extraction the prompt asks for when nothing is worth keeping', () => {
    const value: MemoryExtraction = validateExtraction({ summary: '', facts: [], keywords: [] })
    expect(value).toEqual({ summary: '', facts: [], keywords: [] })
  })

  test('keeps well-formed facts and clamps confidence into [0, 1]', () => {
    const value = validateExtraction({
      summary: 's',
      facts: [{ kind: 'decision', content: '用 zod 做校验', confidence: 1.7, stated_by: 'user' }],
      keywords: [],
    })
    expect(value.facts).toEqual([{ kind: 'decision', content: '用 zod 做校验', confidence: 1, statedBy: 'user' }])
  })

  test('drops facts with an unknown kind or empty content instead of failing the whole batch', () => {
    const value = validateExtraction({
      summary: 's',
      facts: [
        { kind: 'gossip', content: 'x', confidence: 0.5, stated_by: 'user' },
        { kind: 'pitfall', content: '   ', confidence: 0.5, stated_by: 'user' },
        { kind: 'pitfall', content: 'FTS5 不切中文', confidence: 0.5, stated_by: 'user' },
      ],
      keywords: [],
    })
    expect(value.facts.map(fact => fact.content)).toEqual(['FTS5 不切中文'])
  })

  test('caps confidence of assistant-inferred facts below user-stated ones', () => {
    const value = validateExtraction({
      summary: 's',
      facts: [{ kind: 'convention', content: 'c', confidence: 0.95, stated_by: 'assistant' }],
      keywords: [],
    })
    expect(value.facts[0]!.confidence).toBeLessThanOrEqual(0.7)
  })

  test('dedupes keywords, drops blanks and caps the list', () => {
    const value = validateExtraction({
      summary: 's',
      facts: [],
      keywords: ['zod', 'zod', ' ', ...Array.from({ length: 30 }, (_, i) => `k${i}`)],
    })
    expect(value.keywords[0]).toBe('zod')
    expect(new Set(value.keywords).size).toBe(value.keywords.length)
    expect(value.keywords.length).toBeLessThanOrEqual(15)
  })

  test('rejects a payload that is not an object with a facts array', () => {
    expect(() => validateExtraction({ summary: 's' })).toThrow(/facts/)
  })
})
