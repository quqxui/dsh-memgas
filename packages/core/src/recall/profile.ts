import type { MemoryUnit } from '../types.ts'
import { estimateTokens } from '../format/card.ts'

const HEADING = '关于这位用户的长期记忆（来自以往会话，可能过时；与当前对话冲突时以当前对话为准）：'

/**
 * The always-on system prompt section: structured facts only. Raw turns and
 * keyword lists are retrieval material, not something to keep in every request.
 */
export function buildProfileSection(units: MemoryUnit[], opts: { budgetTokens: number }): string {
  const lines: string[] = []
  let spent = estimateTokens(HEADING)
  for (const unit of units) {
    if (unit.granularity !== 'summary' || !unit.kind) continue
    const line = `- [${unit.kind}] ${unit.content}`
    const cost = estimateTokens(line)
    if (spent + cost > opts.budgetTokens) break
    spent += cost
    lines.push(line)
  }
  if (lines.length === 0) return ''
  return `${HEADING}\n${lines.join('\n')}`
}
