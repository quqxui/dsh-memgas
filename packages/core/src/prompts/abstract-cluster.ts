import type { BuiltPrompt } from './summarize-turn.ts'

export const ABSTRACT_PROMPT_VERSION = 'abstract-cluster@1'

const ABSTRACT_SYSTEM = `你在整理编码助手的长期记忆库。输入是一组彼此相关的记忆，把它们概括成一条更高层的记忆，严格 JSON。

要求：
1. summary 写一到两句话，说清这组记忆共同体现的规律、约定或结论；要能独立成立，不依赖原文。
2. 只概括输入里确实存在的内容，不要补充推测。
3. 如果这组记忆之间没有共同主题，输出 {"summary":"","facts":[],"keywords":[]}。
4. 保留原语言，不翻译。
5. keywords 放这组记忆共同涉及的精确标识符，最多 15 个。

只输出 {"summary": string, "facts": [], "keywords": [string]}，不要围栏、不要解释。`

export function buildAbstractPrompt(input: { memories: string[] }): BuiltPrompt {
  const listed = input.memories.map((text, index) => `${index + 1}. ${text}`).join('\n')
  return {
    system: ABSTRACT_SYSTEM,
    prompt: `这组记忆：\n${listed}`,
    version: ABSTRACT_PROMPT_VERSION,
  }
}
