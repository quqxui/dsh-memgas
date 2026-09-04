import type { RetrievalResult, RetrievedMemory } from '../retrieval/retriever.ts'
import { estimateTokens, formatCard } from '../format/card.ts'

export interface InjectionPlan {
  text: string
  ids: string[]
}

export interface InjectionOptions {
  /** Cosine a lone dense hit must reach to count as evidence. */
  denseThreshold: number
  budgetTokens: number
  /** Memories already shown in this session; showing them again only burns context. */
  exclude: Set<string>
}

const HEADER = '以下是长期记忆里与当前请求相关的内容，来自以往会话。它们可能已经过时；与当前对话冲突时以当前对话为准。'

/**
 * Two channels agreeing is evidence regardless of their scales; a single dense
 * hit only counts when its cosine is high. RRF scores themselves are never
 * thresholded because they only encode rank.
 */
function qualifies(item: RetrievedMemory, denseThreshold: number): boolean {
  if (item.contributions.length >= 2) return true
  return item.contributions.some(c => c.channel === 'dense' && c.score >= denseThreshold)
}

export function planInjection(result: RetrievalResult, opts: InjectionOptions): InjectionPlan | null {
  const cards: string[] = []
  const ids: string[] = []
  let spent = estimateTokens(HEADER)

  for (const item of result.items) {
    if (opts.exclude.has(item.unit.id)) continue
    if (!qualifies(item, opts.denseThreshold)) continue
    const card = formatCard(item.unit)
    const cost = estimateTokens(card)
    if (spent + cost > opts.budgetTokens) break
    spent += cost
    cards.push(card)
    ids.push(item.unit.id)
  }

  if (cards.length === 0) return null
  return { text: `${HEADER}\n\n${cards.join('\n\n')}`, ids }
}
