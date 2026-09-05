import { describe, expect, test } from 'vitest'
import { retrievalProfile } from '../src/retrieval/modes.ts'

describe('retrievalProfile', () => {
  test('lite runs baseline channels only', () => {
    const profile = retrievalProfile('lite')
    expect(profile.channels.granularity.enabled).toBe(false)
    expect(profile.channels.graph.enabled).toBe(false)
  })

  test('hybrid enables enhancements behind a half-baseline floor', () => {
    const profile = retrievalProfile('hybrid')
    expect(profile.channels.granularity.enabled).toBe(true)
    expect(profile.channels.graph.enabled).toBe(true)
    expect(profile.baselineFloor).toBe(0.5)
  })

  test('memgas relaxes the floor and raises enhancement weights', () => {
    const hybrid = retrievalProfile('hybrid')
    const memgas = retrievalProfile('memgas')
    expect(memgas.baselineFloor).toBeLessThan(hybrid.baselineFloor)
    expect(memgas.channels.graph.weight).toBeGreaterThan(hybrid.channels.graph.weight)
  })

  test('user overrides win over the mode defaults', () => {
    const profile = retrievalProfile('hybrid', { channels: { graph: { enabled: false } }, baselineFloor: 0.7 })
    expect(profile.channels.graph.enabled).toBe(false)
    expect(profile.channels.granularity.enabled).toBe(true)
    expect(profile.baselineFloor).toBe(0.7)
  })
})
