import { randomUUID } from 'node:crypto'

export interface PluginUserMessage {
  id: string
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: string; plugin?: string; form?: string }
}

export interface EnterDecision {
  kind: 'enter'
  messages: PluginUserMessage[]
  startsRequestSeries?: true
}

/**
 * Prepend the recall so the model reads the memories before the request they
 * bear on. Spreading the decision keeps any flags a downstream listener set.
 */
export function composeRecall(decision: EnterDecision, text: string): EnterDecision {
  const recall: PluginUserMessage = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'memgas', form: 'recall' },
  }
  return { ...decision, messages: [recall, ...decision.messages] }
}
