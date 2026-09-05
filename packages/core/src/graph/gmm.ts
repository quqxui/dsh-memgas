export interface GmmFit {
  /** Lower and upper component means. */
  means: [number, number]
  /** False when the two components overlap too much to trust the split. */
  separable: boolean
  /** Fraction of the fitted sample assigned to the upper component. */
  acceptShare: number
  assign(value: number): 'accept' | 'reject'
}

const MIN_SAMPLE = 4
const MIN_SIGMA = 1e-3
const MAX_ITERATIONS = 100
const MIN_WEIGHT = 0.02

function gaussian(x: number, mean: number, sigma: number): number {
  const z = (x - mean) / sigma
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI))
}

function notSeparable(values: number[]): GmmFit {
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  return { means: [min, max], separable: false, acceptShare: 0, assign: () => 'reject' }
}

/**
 * Two-component 1-D Gaussian mixture, fitted by EM, over the similarities
 * between a new memory and the existing ones. The upper component is the
 * accept set. Callers fall back to a percentile cut when `separable` is false.
 */
export function fitTwoComponentGmm(values: number[]): GmmFit {
  if (values.length < MIN_SAMPLE) return notSeparable(values)
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length
  const std = Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sorted.length)
  if (std < MIN_SIGMA) return notSeparable(values)

  let mu = [at(0.25), at(0.75)]
  let sigma = [Math.max(std / 2, MIN_SIGMA), Math.max(std / 2, MIN_SIGMA)]
  let pi = [0.5, 0.5]
  const responsibilities = new Float64Array(sorted.length)

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    // E step: responsibility of the upper component.
    for (let i = 0; i < sorted.length; i += 1) {
      const lo = pi[0]! * gaussian(sorted[i]!, mu[0]!, sigma[0]!)
      const hi = pi[1]! * gaussian(sorted[i]!, mu[1]!, sigma[1]!)
      responsibilities[i] = lo + hi > 0 ? hi / (lo + hi) : 0.5
    }
    // M step.
    let nHi = 0
    let sumHi = 0
    let sumLo = 0
    for (let i = 0; i < sorted.length; i += 1) {
      nHi += responsibilities[i]!
      sumHi += responsibilities[i]! * sorted[i]!
      sumLo += (1 - responsibilities[i]!) * sorted[i]!
    }
    const nLo = sorted.length - nHi
    if (nHi < 1e-9 || nLo < 1e-9) break
    const nextMu = [sumLo / nLo, sumHi / nHi]
    let varHi = 0
    let varLo = 0
    for (let i = 0; i < sorted.length; i += 1) {
      varHi += responsibilities[i]! * (sorted[i]! - nextMu[1]!) ** 2
      varLo += (1 - responsibilities[i]!) * (sorted[i]! - nextMu[0]!) ** 2
    }
    const nextSigma = [Math.max(Math.sqrt(varLo / nLo), MIN_SIGMA), Math.max(Math.sqrt(varHi / nHi), MIN_SIGMA)]
    const nextPi = [nLo / sorted.length, nHi / sorted.length]
    const delta = Math.abs(nextMu[0]! - mu[0]!) + Math.abs(nextMu[1]! - mu[1]!)
    mu = nextMu
    sigma = nextSigma
    pi = nextPi
    if (delta < 1e-6) break
  }

  if (mu[0]! > mu[1]!) {
    mu = [mu[1]!, mu[0]!]
    sigma = [sigma[1]!, sigma[0]!]
    pi = [pi[1]!, pi[0]!]
  }

  const assign = (value: number): 'accept' | 'reject' => {
    const lo = pi[0]! * gaussian(value, mu[0]!, sigma[0]!)
    const hi = pi[1]! * gaussian(value, mu[1]!, sigma[1]!)
    return hi > lo ? 'accept' : 'reject'
  }
  const accepted = sorted.filter(value => assign(value) === 'accept').length
  const gap = mu[1]! - mu[0]!
  const separable = gap > 2 * (sigma[0]! + sigma[1]!) && pi[0]! >= MIN_WEIGHT && pi[1]! >= MIN_WEIGHT

  return { means: [mu[0]!, mu[1]!], separable, acceptShare: accepted / sorted.length, assign }
}
