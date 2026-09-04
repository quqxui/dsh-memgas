import { formatCard, type MemoryService, type RetrievalResult } from '@memgas/core'

export { formatCard }

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
  args: { content: string; scope: string; kind?: string },
): Promise<string> {
  const saved = await memory.save({
    content: args.content,
    scope: args.scope,
    granularity: 'summary',
    kind: args.kind ?? 'note',
  })
  if (!saved) return '未写入：内容为空，或全部被密钥过滤规则拦下。'
  return `已记住（${saved.id}）：${saved.content}`
}

export function handleStatus(memory: MemoryService, warning?: string | null, extra: string[] = []): string {
  const status = memory.status()
  return [
    ...(warning ? [warning] : []),
    ...extra,
    `记忆条数：${status.units}`,
    `向量模型：${status.embedder}`,
    `词法索引：${status.lexicalIndex}`,
    `本次会话拦截的密钥片段：${status.redactions}`,
  ].join('\n')
}
