import type { MemoryUnit } from '../types.ts'

function scopeLabel(scope: string): string {
  return scope === 'global' ? 'global' : 'project'
}

/** Local calendar date: the user reasons in their own timezone, not in UTC. */
export function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * The model-visible shape of one memory.
 *
 * The header carries provenance on purpose: the model has to be able to weigh a
 * three-month-old decision against what the user just said, and it can quote the
 * id back so the reinforce pass can tell which memories were actually used.
 */
export function formatCard(unit: MemoryUnit): string {
  const header = [
    `memory:${unit.id}`,
    scopeLabel(unit.scope),
    localDate(unit.provenance.occurredAt ?? unit.createdAt),
    unit.kind ?? unit.granularity,
  ].join(' | ')
  return `[${header}]\n${unit.content}`
}

/** Rough token count for a Chinese/English mix; errs high so budgets hold. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.6)
}
