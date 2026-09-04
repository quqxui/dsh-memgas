import { describe, expect, test } from 'vitest'
import { applyBaselineFloor, fuseRRF } from '../src/retrieval/fusion.ts'

const channel = (name: string, ids: string[]) => ({
  channel: name,
  candidates: ids.map((id, i) => ({ id, score: 1 - i * 0.01 })),
})

describe('fuseRRF', () => {
  test('ranks an item found by two channels above one found by a single channel', () => {
    const fused = fuseRRF([channel('lexical', ['a', 'b']), channel('dense', ['a', 'c'])])
    expect(fused[0]!.id).toBe('a')
  })

  test('records which channel and rank contributed each item', () => {
    const fused = fuseRRF([channel('lexical', ['a']), channel('dense', ['b', 'a'])])
    const a = fused.find(item => item.id === 'a')!
    expect(a.contributions.map(c => [c.channel, c.rank])).toEqual([
      ['lexical', 1],
      ['dense', 2],
    ])
  })

  test('applies per-channel weights', () => {
    const weighted = fuseRRF([channel('lexical', ['a']), channel('graph', ['b'])], {
      weights: { lexical: 1, graph: 0.1 },
    })
    expect(weighted[0]!.id).toBe('a')
  })

  test('ignores channels that returned nothing', () => {
    const fused = fuseRRF([channel('lexical', ['a']), channel('graph', [])])
    expect(fused.map(item => item.id)).toEqual(['a'])
  })
})

describe('applyBaselineFloor', () => {
  // graph outranks dense everywhere; without a floor it would take every slot.
  const fused = () => fuseRRF([
    { channel: 'graph', candidates: ['g1', 'g2', 'g3', 'g4'].map((id, i) => ({ id, score: 1 - i * 0.01 })) },
    { channel: 'dense', candidates: ['d1', 'd2', 'd3'].map((id, i) => ({ id, score: 0.5 - i * 0.01 })) },
  ], { weights: { graph: 10, dense: 1 } })

  test('reserves half the slots for baseline channels when enhancements dominate', () => {
    const final = applyBaselineFloor(fused(), { baselineChannels: ['lexical', 'dense'], k: 4, floor: 0.5 })
    expect(final).toHaveLength(4)
    const baselineBacked = final.filter(item =>
      item.contributions.some(c => c.channel === 'dense' || c.channel === 'lexical'))
    expect(baselineBacked.length).toBeGreaterThanOrEqual(2)
  })

  test('keeps the highest ranked enhancement results in the remaining slots', () => {
    const final = applyBaselineFloor(fused(), { baselineChannels: ['dense'], k: 4, floor: 0.5 })
    expect(final.map(item => item.id)).toContain('g1')
  })

  test('never returns the same memory twice', () => {
    const final = applyBaselineFloor(fused(), { baselineChannels: ['dense'], k: 6, floor: 0.5 })
    expect(new Set(final.map(item => item.id)).size).toBe(final.length)
  })

  test('returns everything it has when there are fewer results than k', () => {
    const small = fuseRRF([channel('dense', ['only'])])
    expect(applyBaselineFloor(small, { baselineChannels: ['dense'], k: 5, floor: 0.5 })).toHaveLength(1)
  })
})
