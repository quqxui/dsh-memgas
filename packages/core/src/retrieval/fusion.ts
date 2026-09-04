export interface Candidate {
  id: string
  score: number
}

export interface ChannelResult {
  channel: string
  candidates: Candidate[]
}

export interface Contribution {
  channel: string
  rank: number
  score: number
}

export interface FusedItem {
  id: string
  score: number
  contributions: Contribution[]
}

const DEFAULT_RRF_K = 60

/**
 * Reciprocal Rank Fusion across retrieval channels.
 *
 * Rank-based on purpose: channel scores are not comparable (BM25 against
 * cosine against PPR mass), so a channel whose scores are wildly miscalibrated
 * can still only contribute through its ordering.
 */
export function fuseRRF(
  results: ChannelResult[],
  opts: { k?: number; weights?: Record<string, number> } = {},
): FusedItem[] {
  const k = opts.k ?? DEFAULT_RRF_K
  const weights = opts.weights ?? {}
  const items = new Map<string, FusedItem>()

  for (const { channel, candidates } of results) {
    const weight = weights[channel] ?? 1
    candidates.forEach((candidate, index) => {
      const rank = index + 1
      const existing = items.get(candidate.id) ?? { id: candidate.id, score: 0, contributions: [] }
      existing.score += weight / (k + rank)
      existing.contributions.push({ channel, rank, score: candidate.score })
      items.set(candidate.id, existing)
    })
  }

  return [...items.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/**
 * Guarantee that baseline channels keep a share of the final slots.
 *
 * This is what bounds the worst case of every enhancement channel: however
 * confident the graph or granularity channels are, they cannot evict more than
 * `1 - floor` of the results that plain lexical and dense retrieval found.
 */
export function applyBaselineFloor(
  fused: FusedItem[],
  opts: { baselineChannels: string[]; k: number; floor: number },
): FusedItem[] {
  const { baselineChannels, k, floor } = opts
  const isBaseline = (item: FusedItem) =>
    item.contributions.some(contribution => baselineChannels.includes(contribution.channel))

  const chosen = fused.slice(0, k)
  const availableBaseline = fused.filter(isBaseline).length
  const reserved = Math.min(Math.ceil(k * floor), availableBaseline)
  let baselineCount = chosen.filter(isBaseline).length
  if (baselineCount >= reserved) return chosen

  const promotable = fused.filter(item => isBaseline(item) && !chosen.includes(item))
  for (const item of promotable) {
    if (baselineCount >= reserved) break
    const victim = chosen.findLastIndex(candidate => !isBaseline(candidate))
    if (victim < 0) break
    chosen.splice(victim, 1)
    chosen.push(item)
    baselineCount += 1
  }

  return chosen.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
