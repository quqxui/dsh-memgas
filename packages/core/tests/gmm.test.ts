import { describe, expect, test } from 'vitest'
import { fitTwoComponentGmm } from '../src/graph/gmm.ts'

const around = (center: number, n: number, spread = 0.03) =>
  Array.from({ length: n }, (_, i) => center + spread * Math.sin(i * 1.7) )

describe('fitTwoComponentGmm', () => {
  test('separates a clearly bimodal similarity sample into accept and reject', () => {
    const fit = fitTwoComponentGmm([...around(0.2, 40), ...around(0.8, 10)])
    expect(fit.separable).toBe(true)
    expect(fit.assign(0.85)).toBe('accept')
    expect(fit.assign(0.15)).toBe('reject')
    expect(fit.means[0]).toBeLessThan(fit.means[1])
  })

  test('reports a unimodal sample as not separable', () => {
    const fit = fitTwoComponentGmm(around(0.5, 50, 0.02))
    expect(fit.separable).toBe(false)
  })

  test('does not throw on tiny or constant inputs', () => {
    expect(fitTwoComponentGmm([0.4, 0.4, 0.4]).separable).toBe(false)
    expect(fitTwoComponentGmm([]).separable).toBe(false)
    expect(fitTwoComponentGmm([0.9]).separable).toBe(false)
  })

  test('accept share is the fraction of values assigned to the upper component', () => {
    const fit = fitTwoComponentGmm([...around(0.2, 45), ...around(0.8, 5)])
    expect(fit.acceptShare).toBeGreaterThan(0.05)
    expect(fit.acceptShare).toBeLessThan(0.2)
  })
})
