import type { MemoryService, MemoryUnit, RetrievalResult } from '@memgas/core'

function scopeLabel(scope: string): string {
  return scope === 'global' ? 'global' : 'project'
}

/** Local calendar date: the user reasons in their own timezone, not in UTC. */
function localDate(timestamp: number): string {
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
    unit.granularity,
  ].join(' | ')
  return `[${header}]\n${unit.content}`
}

function degradedNote(result: RetrievalResult): string {
  const broken = result.channels.filter(report => report.status === 'failed' || report.status === 'timeout')
  if (broken.length === 0) return ''
  const names = broken.map(report => `${report.channel}(${report.status})`).join('、')
  return `\n\n注意：检索通道 ${names} 本次未参与，结果可能不完整。`
}

export async function handleSearch(
  memory: MemoryService,
  args: { query: string; scope: string; k?: number },
): Promise<string> {
  const result = await memory.search({
    query: args.query,
    scopes: [args.scope, 'global'],
    k: args.k ?? 8,
  })
  if (result.items.length === 0) {
    return `没有找到与「${args.query}」相关的记忆。${degradedNote(result)}`.trim()
  }
  return result.items.map(item => formatCard(item.unit)).join('\n\n') + degradedNote(result)
}

export async function handleSave(
  memory: MemoryService,
  args: { content: string; scope: string },
): Promise<string> {
  const saved = await memory.save({ content: args.content, scope: args.scope, granularity: 'summary' })
  if (!saved) return '未写入：内容为空，或全部被密钥过滤规则拦下。'
  return `已记住（${saved.id}）：${saved.content}`
}

export function handleStatus(memory: MemoryService): string {
  const status = memory.status()
  return [
    `记忆条数：${status.units}`,
    `向量模型：${status.embedder}`,
    `词法索引：${status.lexicalIndex}`,
    `本次会话拦截的密钥片段：${status.redactions}`,
  ].join('\n')
}
