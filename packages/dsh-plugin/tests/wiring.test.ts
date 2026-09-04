import { describe, expect, test } from 'vitest'
import { SessionEventMapper } from '../src/session-events.ts'
import { DshLlmClient } from '../src/llm-client.ts'
import { composeRecall } from '../src/recall.ts'

const userMessage = (text: string, source: { kind: string; plugin?: string } = { kind: 'user' }) => ({
  id: 'u1', role: 'user' as const, content: [{ type: 'text' as const, text }], source,
})

describe('SessionEventMapper', () => {
  test('attaches the current turn to user, assistant and tool events', () => {
    const mapper = new SessionEventMapper()
    mapper.map('s1', { type: 'turn/start', data: { turn: 3 } })
    expect(mapper.map('s1', { type: 'user/message', data: userMessage('改超时') }))
      .toEqual({ type: 'user', turn: 3, text: '改超时' })
    expect(mapper.map('s1', { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '好' }, { type: 'reasoning', text: '思考' }] } } }))
      .toEqual({ type: 'assistant', turn: 3, text: '好' })
    expect(mapper.map('s1', { type: 'tool/call', data: { turn: 3, step: 1, name: 'bash', arguments: '{}' } }))
      .toEqual({ type: 'tool-call', turn: 3, name: 'bash' })
  })

  test('ignores messages this plugin injected so recalls never feed themselves back', () => {
    const mapper = new SessionEventMapper()
    mapper.map('s1', { type: 'turn/start', data: { turn: 1 } })
    expect(mapper.map('s1', { type: 'user/message', data: userMessage('[memory:...]', { kind: 'plugin', plugin: 'memgas' }) })).toBeNull()
  })

  test('marks a turn completed only when it ended normally', () => {
    const mapper = new SessionEventMapper()
    expect(mapper.map('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
      .toEqual({ type: 'turn-end', turn: 1, completed: true })
    expect(mapper.map('s1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } }))
      .toEqual({ type: 'turn-end', turn: 2, completed: false })
  })

  test('turns a compaction summary into a compaction event with its range', () => {
    const mapper = new SessionEventMapper()
    const mapped = mapper.map('s1', {
      type: 'compaction/summary',
      data: { summary: [{ type: 'text', text: '会话摘要' }], shadowedRange: { start: 2, end: 30 } },
    })
    expect(mapped).toEqual({ type: 'compaction-summary', text: '会话摘要', seqStart: 2, seqEnd: 30 })
  })

  test('remembers the model route each session last used', () => {
    const mapper = new SessionEventMapper()
    expect(mapper.routeFor('s1')).toBeNull()
    expect(mapper.map('s1', { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } }, reason: 'initial' } })).toBeNull()
    expect(mapper.routeFor('s1')).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })
})

describe('DshLlmClient', () => {
  const streamOf = (chunks: object[]) => ({
    calls: [] as unknown[],
    async *stream(this: { calls: unknown[] }, options: unknown) {
      this.calls.push(options)
      for (const chunk of chunks) yield chunk
    },
  })

  test('concatenates text deltas and ignores reasoning', async () => {
    const llm = streamOf([{ type: 'reasoning-delta', text: '想' }, { type: 'text-delta', text: '{"a":' }, { type: 'text-delta', text: '1}' }, { type: 'finish' }])
    const client = new DshLlmClient({ llm, route: () => ({ provider: 'p', model: 'm' }) })
    expect(await client.complete({ system: 's', prompt: 'q' })).toBe('{"a":1}')
  })

  test('sends the resolved route, system prompt and a deterministic temperature', async () => {
    const llm = streamOf([{ type: 'text-delta', text: 'x' }])
    const client = new DshLlmClient({ llm, route: () => ({ provider: 'p', model: 'm' }) })
    await client.complete({ system: 's', prompt: 'q', maxTokens: 50 })
    expect(llm.calls[0]).toMatchObject({ provider: 'p', model: 'm', system: 's', temperature: 0, maxTokens: 50 })
  })

  test('fails with a clear reason when no model route is known yet', async () => {
    const llm = streamOf([])
    const client = new DshLlmClient({ llm, route: () => null })
    await expect(client.complete({ system: 's', prompt: 'q' })).rejects.toThrow(/route/)
  })

  test('resolves the route for the session the request belongs to', async () => {
    const llm = streamOf([{ type: 'text-delta', text: 'x' }])
    const routes: Record<string, { provider: string; model: string }> = { s1: { provider: 'p1', model: 'm1' } }
    const client = new DshLlmClient({ llm, route: sessionId => (sessionId ? routes[sessionId] ?? null : null) })
    await client.complete({ system: 's', prompt: 'q', sessionId: 's1' })
    expect(llm.calls[0]).toMatchObject({ provider: 'p1', model: 'm1' })
  })
})

describe('composeRecall', () => {
  test('puts the recall before the claimed messages as a plugin-sourced user message', () => {
    const decision = { kind: 'enter' as const, messages: [userMessage('问题')] }
    const composed = composeRecall(decision, '相关记忆')
    expect(composed.messages).toHaveLength(2)
    expect(composed.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '相关记忆' }],
      source: { kind: 'plugin', plugin: 'memgas', form: 'recall' },
    })
    expect(composed.messages[1]).toBe(decision.messages[0])
  })
})
