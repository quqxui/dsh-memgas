import type { RetrievalResult } from './retriever.ts'

/** Human-readable answer to "why did this come back?" for `/memory diag`. */
export function formatDiagnostics(query: string, result: RetrievalResult): string {
  const channels = result.channels
    .map(report => {
      const detail = report.reason ? `，${report.reason}` : ''
      return `  ${report.channel}: ${report.status}，${report.count} 条，${report.ms}ms${detail}`
    })
    .join('\n')

  const items = result.items
    .map((item, index) => {
      const from = item.contributions.map(c => `${c.channel}#${c.rank}(${c.score.toFixed(3)})`).join(' + ')
      const head = item.unit.content.replace(/\s+/g, ' ').slice(0, 60)
      return `  ${index + 1}. ${item.unit.id} 融合分 ${item.score.toFixed(4)} ← ${from || '无归因'}\n     ${head}`
    })
    .join('\n')

  return [
    `查询：${query}`,
    `通道：\n${channels || '  （无）'}`,
    `结果：\n${items || '  （无）'}`,
    result.degraded ? '本次检索有通道未参与，结果可能不完整。' : '',
  ].filter(Boolean).join('\n')
}
