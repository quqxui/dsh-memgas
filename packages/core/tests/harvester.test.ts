import { beforeEach, describe, expect, test } from 'vitest'
import { Harvester } from '../src/ingest/harvester.ts'
import type { LlmClient } from '../src/llm/client.ts'
import { openStore, type MemoryStore } from '../src/store/store.ts'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import { BackgroundQueue } from '../src/queue.ts'

const extraction = JSON.stringify({
  summary: '把 store.ts 的超时从 300ms 改成 500ms',
  facts: [{ kind: 'decision', content: 'store.ts 的检索超时定为 500ms', confidence: 0.9, stated_by: 'user' }],
  keywords: ['packages/core/src/store.ts', '500ms'],
})

class FakeLlm implements LlmClient {
  calls: { system: string; prompt: string }[] = []
  constructor(private readonly reply: string | (() => string)) {}
  async complete(input: { system: string; prompt: string }): Promise<string> {
    this.calls.push(input)
    return typeof this.reply === 'function' ? this.reply() : this.reply
  }
}

function harvesterWith(store: MemoryStore, llm: LlmClient, overrides: Partial<ConstructorParameters<typeof Harvester>[0]> = {}) {
  return new Harvester({
    store,
    llm,
    embedder: new LexicalEmbedder(),
    queue: new BackgroundQueue({ jobTimeoutMs: 5000 }),
    scope: 'project:p',
    minTurnChars: 20,
    sessionSummaryEvery: 2,
    ...overrides,
  })
}

const longUser = '把 packages/core/src/store.ts 的检索超时从 300ms 改成 500ms，现在偶尔会超时'

describe('Harvester', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = openStore({ path: ':memory:' })
  })

  test('turns a completed turn into turn, summary, fact and keyword units', async () => {
    const harvester = harvesterWith(store, new FakeLlm(extraction))
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'assistant', turn: 1, text: '已改成 500ms 并补了测试' })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()

    const granularities = store.listActive({ scopes: ['project:p'], limit: 10 }).map(u => u.granularity).sort()
    expect(granularities).toEqual(['keyword', 'summary', 'summary', 'turn'])
    const fact = store.listActive({ scopes: ['project:p'], limit: 10, kinds: ['decision'] })[0]!
    expect(fact).toMatchObject({ content: 'store.ts 的检索超时定为 500ms', confidence: 0.9, promptVersion: 'summarize-turn@1' })
    expect(fact.provenance).toMatchObject({ sessionId: 's1', turn: 1 })
    expect(store.searchLexical('store.ts 超时', { limit: 5 }).length).toBeGreaterThan(0)
  })

  test('parks extracted facts for confirmation when asked to', async () => {
    const harvester = harvesterWith(store, new FakeLlm(extraction), { confirmWrites: true })
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    // The raw turn is still stored and searchable; only the model-derived
    // facts wait for confirmation.
    expect(store.listUnits({ scopes: ['project:p'], statuses: ['pending'], limit: 10 }).length).toBeGreaterThan(0)
    expect(store.listActive({ scopes: ['project:p'], limit: 10 }).map(u => u.granularity)).toEqual(['turn'])
  })

  test('skips a turn shorter than the minimum without calling the model', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm)
    harvester.observe('s1', { type: 'user', turn: 1, text: '好的' })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    expect(llm.calls).toHaveLength(0)
    expect(store.countUnits()).toBe(0)
    expect(harvester.stats().skippedShort).toBe(1)
  })

  test('keeps the raw turn and records the reason when the model output is unusable', async () => {
    const harvester = harvesterWith(store, new FakeLlm('抱歉，我无法总结。'))
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    expect(store.listActive({ scopes: ['project:p'], limit: 10 }).map(u => u.granularity)).toEqual(['turn'])
    expect(harvester.stats().extractionFailures).toBe(1)
    expect(harvester.stats().lastFailure).toContain('JSON')
  })

  test('still keeps the raw turn when the model call itself throws', async () => {
    const harvester = harvesterWith(store, new FakeLlm(() => { throw new Error('provider down') }))
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    expect(store.listActive({ scopes: ['project:p'], limit: 10 }).map(u => u.granularity)).toEqual(['turn'])
    expect(harvester.stats().lastFailure).toContain('provider down')
  })

  test('redacts credentials before the transcript reaches the model or the store', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm)
    harvester.observe('s1', { type: 'user', turn: 1, text: `${longUser}，顺便 api_key = "sk-abcd1234abcd1234abcd1234" 先别提交` })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    expect(llm.calls[0]!.prompt).not.toContain('sk-abcd1234abcd1234abcd1234')
    const turn = store.listActive({ scopes: ['project:p'], limit: 10 }).find(u => u.granularity === 'turn')!
    expect(turn.content).not.toContain('sk-abcd1234abcd1234abcd1234')
  })

  test('does not harvest the same turn twice, even across a restart', async () => {
    const llm = new FakeLlm(extraction)
    const first = harvesterWith(store, llm)
    first.observe('s1', { type: 'user', turn: 1, text: longUser })
    first.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await first.idle()

    const restarted = harvesterWith(store, llm)
    restarted.observe('s1', { type: 'user', turn: 1, text: longUser })
    restarted.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await restarted.idle()
    expect(llm.calls).toHaveLength(1)
  })

  test('ignores turns that ended without completing', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm)
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: false })
    await harvester.idle()
    expect(llm.calls).toHaveLength(0)
  })

  test('names tool calls in the transcript without including their output', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm)
    harvester.observe('s1', { type: 'user', turn: 1, text: longUser })
    harvester.observe('s1', { type: 'tool-call', turn: 1, name: 'bash' })
    harvester.observe('s1', { type: 'assistant', turn: 1, text: '改好了' })
    harvester.observe('s1', { type: 'turn-end', turn: 1, completed: true })
    await harvester.idle()
    expect(llm.calls[0]!.prompt).toContain('[tool: bash]')
  })

  test('writes a session unit from the turn summaries every N completed turns', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm, { sessionSummaryEvery: 2 })
    for (const turn of [1, 2]) {
      harvester.observe('s1', { type: 'user', turn, text: `${longUser} 第${turn}轮` })
      harvester.observe('s1', { type: 'turn-end', turn, completed: true })
    }
    await harvester.idle()
    const sessions = store.listActive({ scopes: ['project:p'], limit: 20 }).filter(u => u.granularity === 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.promptVersion).toBe('summarize-session@1')
    expect(llm.calls).toHaveLength(3)
  })

  test('stores a compaction summary as a session unit without calling the model', async () => {
    const llm = new FakeLlm(extraction)
    const harvester = harvesterWith(store, llm)
    harvester.observe('s1', { type: 'compaction-summary', text: '本次会话把检索超时改到 500ms 并补了测试', seqStart: 1, seqEnd: 40 })
    await harvester.idle()
    const sessions = store.listActive({ scopes: ['project:p'], limit: 20 }).filter(u => u.granularity === 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!).toMatchObject({ kind: 'compaction', provenance: { sessionId: 's1', seqStart: 1, seqEnd: 40 } })
    expect(llm.calls).toHaveLength(0)
  })
})
