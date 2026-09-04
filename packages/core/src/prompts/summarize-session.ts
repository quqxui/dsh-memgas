import { EXTRACTION_RULES, type BuiltPrompt } from './summarize-turn.ts'

export const SESSION_PROMPT_VERSION = 'summarize-session@1'

const SESSION_SYSTEM = `你是编码助手的长期记忆整理器。输入是一个编码会话里各轮的摘要（不是原文），输出是站在整个会话高度的记忆，严格 JSON。

summary 用两到四句话说清这次会话的目标、做到了哪一步、最终结论；只写会话级别的信息，不复述每一轮。
facts 只保留对整个会话成立、以后还会用到的事实；同一件事在多轮里反复出现时合并成一条；后面推翻前面的，只留最终版本。

${EXTRACTION_RULES}`

export interface SessionPromptInput {
  turnSummaries: string[]
  occurredAt: number
}

export function buildSessionPrompt(input: SessionPromptInput): BuiltPrompt {
  const listed = input.turnSummaries.map((summary, index) => `${index + 1}. ${summary}`).join('\n')
  return {
    system: SESSION_SYSTEM,
    prompt: `时间：${new Date(input.occurredAt).toISOString()}\n\n各轮摘要：\n${listed}`,
    version: SESSION_PROMPT_VERSION,
  }
}
