import type { BuiltPrompt } from './summarize-turn.ts'

export const FILTER_PROMPT_VERSION = 'filter-results@1'

const FILTER_SYSTEM = `你在为编码助手筛选检索到的长期记忆。输入是一个查询和若干候选记忆，输出保留哪些，严格 JSON。

保留标准：这条记忆能帮助回答或执行当前查询。
丢弃标准：与查询无关；与另一条保留的记忆表达同一件事（保留信息更完整的那条）；内容已被同批中更新的记忆取代。

宁可多留一条，也不要把可能有用的记忆丢掉。只输出 {"keep": ["id", ...]}，不要围栏、不要解释。`

export function buildFilterPrompt(input: { query: string; cards: { id: string; text: string }[] }): BuiltPrompt {
  const listed = input.cards.map(card => `- id: ${card.id}\n  内容: ${card.text}`).join('\n')
  return {
    system: FILTER_SYSTEM,
    prompt: `查询：${input.query}\n\n候选记忆：\n${listed}`,
    version: FILTER_PROMPT_VERSION,
  }
}
