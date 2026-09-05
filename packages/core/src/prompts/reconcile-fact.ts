import type { BuiltPrompt } from './summarize-turn.ts'

export const RECONCILE_PROMPT_VERSION = 'reconcile-fact@1'

const RECONCILE_SYSTEM = `你在维护编码助手的长期记忆库。输入是一条新记忆和若干条已有的相近记忆，判断新记忆与其中哪一条是什么关系，严格 JSON。

关系取值：
- "duplicate"：新记忆和目标说的是同一件事，没有新增信息。
- "update"：同一个主题，新记忆是更新后的版本，目标已经过时（例如同一个配置项换了值、同一个决定改了做法）。
- "contradict"：两者对同一件事给出互斥的说法，但无法判断哪个更新。
- "unrelated"：与所有候选都不是同一件事。

判定要求：
1. 只有主题确实相同才判 duplicate / update / contradict；主题不同一律 unrelated。
2. 谈论同一个对象但陈述不同方面（例如一个讲端口、一个讲超时），属于 unrelated。
3. 拿不准时选 unrelated。多留一条冗余记忆，好过错误地把一条有效记忆标记为过时。
4. target 必须是候选里给出的 id 原文；unrelated 时 target 为 null。

只输出 {"relation": "...", "target": "id 或 null"}，不要围栏、不要解释。`

export function buildReconcilePrompt(input: {
  incoming: string
  candidates: { id: string; text: string }[]
}): BuiltPrompt {
  const listed = input.candidates.map(candidate => `- id: ${candidate.id}\n  内容: ${candidate.text}`).join('\n')
  return {
    system: RECONCILE_SYSTEM,
    prompt: `新记忆：${input.incoming}\n\n已有的相近记忆：\n${listed}`,
    version: RECONCILE_PROMPT_VERSION,
  }
}
