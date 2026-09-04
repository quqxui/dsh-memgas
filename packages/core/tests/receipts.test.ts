import { describe, expect, test } from 'vitest'
import { referencedMemoryIds } from '../src/recall/receipts.ts'

describe('referencedMemoryIds', () => {
  test('finds memory ids the assistant quoted back', () => {
    expect(referencedMemoryIds('按 memory:m_0123456789 的约定，我用 zod（见 [memory:m_abcdef0123 | project]）'))
      .toEqual(['m_0123456789', 'm_abcdef0123'])
  })

  test('dedupes repeated references', () => {
    expect(referencedMemoryIds('memory:m_0123456789 和 memory:m_0123456789')).toEqual(['m_0123456789'])
  })

  test('returns nothing for text without references', () => {
    expect(referencedMemoryIds('改好了')).toEqual([])
  })
})
