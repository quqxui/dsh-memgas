import type { LlmClient } from '@memgas/core'
import type { ModelRoute } from './session-events.ts'

/** The part of `ctx.llm` this plugin calls. */
export interface LlmRuntimeLike {
  stream(options: {
    provider: string
    model: string
    messages: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: 'plugin'; plugin: string } }[]
    system?: string
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

let counter = 0

/**
 * Adapts the harness model runtime to the core's text-in/text-out contract.
 * The route comes from whatever the session itself is using, so memory
 * extraction never needs its own credentials or model configuration.
 */
export class DshLlmClient implements LlmClient {
  constructor(private readonly opts: { llm: LlmRuntimeLike; route: (sessionId?: string) => ModelRoute | null }) {}

  async complete(input: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal; sessionId?: string }): Promise<string> {
    const route = this.opts.route(input.sessionId)
    if (!route) throw new Error('no model route known for this session yet')

    counter += 1
    const stream = this.opts.llm.stream({
      provider: route.provider,
      model: route.model,
      system: input.system,
      temperature: 0,
      messages: [{
        id: `memgas-${Date.now()}-${counter}`,
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
        source: { kind: 'plugin', plugin: 'memgas' },
      }],
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })

    let text = ''
    for await (const chunk of stream) {
      if (typeof chunk === 'object' && chunk !== null) {
        const record = chunk as { type?: string; text?: string }
        if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
      }
    }
    return text
  }
}
