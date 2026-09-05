import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { resolveScope, storePathFor } from '../src/workspace.ts'

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render(args: unknown, value: unknown): { type: string; text?: string }[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

const extraction = JSON.stringify({
  summary: '把 store.ts 的超时改成 500ms',
  facts: [{ kind: 'decision', content: 'store.ts 的检索超时定为 500ms', confidence: 0.9, stated_by: 'user' }],
  keywords: ['store.ts'],
})

interface RegisteredCommand {
  name: string
  description: string
  handler: (invocation: { rawInput: string; agent: unknown }) => Promise<{ kind: string; text?: string }>
}

function fakeContext() {
  const tools: RegisteredTool[] = []
  const commands: RegisteredCommand[] = []
  const sections: { name: string; order: number; text: string | (() => string) }[] = []
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  return {
    tools: { register: (definition: RegisteredTool) => { tools.push(definition); return () => {} } },
    commands: { register: (definition: RegisteredCommand) => { commands.push(definition); return () => {} } },
    systemPrompt: { section: (section: { name: string; order: number; text: string | (() => string) }) => { sections.push(section); return () => {} } },
    llm: { async *stream() { yield { type: 'text-delta', text: extraction } } },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    registered: tools,
    registeredCommands: commands,
    sections,
    fire: (event: string, ...args: unknown[]) => Promise.all((listeners.get(event) ?? []).map(listener => listener(...args))),
  }
}

const userMessage = (text: string) => ({ id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function runTurn(ctx: ReturnType<typeof fakeContext>, sessionId: string, turn: number, userText: string, assistantText: string) {
  const session = { id: sessionId }
  await ctx.fire('session/event', session, { type: 'turn/start', data: { turn } })
  await ctx.fire('session/event', session, { type: 'user/message', data: userMessage(userText) })
  await ctx.fire('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } })
  await ctx.fire('session/event', session, { type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: assistantText }] } } })
  await ctx.fire('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

describe('plugin manifest', () => {
  test('declares the services it reaches for, or Cordis refuses the context access', () => {
    expect(inject).toEqual(expect.arrayContaining(['tools', 'systemPrompt', 'llm', 'commands']))
  })
})

describe('apply', () => {
  test('registers the memory tools on the tool registry', () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    expect(ctx.registered.map(tool => tool.name).sort())
      .toEqual(['memory_save', 'memory_search', 'memory_status'])
  })

  test('every tool declares a description and an object parameter schema', () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    for (const tool of ctx.registered) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toMatchObject({ type: 'object' })
    }
  })

  test('a memory saved through the tool is found by the search tool', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const save = ctx.registered.find(tool => tool.name === 'memory_save')!
    const search = ctx.registered.find(tool => tool.name === 'memory_search')!

    await save.execute({ content: '部署端口是 8080' }, {})
    const value = await search.execute({ query: '部署端口' }, {})

    expect(String(value)).toContain('8080')
  })

  test('never takes the harness down when its own store cannot be opened', async () => {
    const ctx = fakeContext()
    // A path under a regular file can never become a directory.
    expect(() => apply(ctx as never, { dataDir: '/dev/null/memgas' })).not.toThrow()
    const status = ctx.registered.find(tool => tool.name === 'memory_status')!
    expect(String(await status.execute({}, {}))).toContain('未能打开磁盘记忆库')
  })

  test('renders tool output as a text block for the model', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const status = ctx.registered.find(tool => tool.name === 'memory_status')!
    const value = await status.execute({}, {})
    expect(status.output.render({}, value)).toEqual([{ type: 'text', text: String(value) }])
  })
})

describe('automatic harvesting', () => {
  test('turns a completed session turn into searchable memories through the host model', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:', minTurnChars: 10 })
    await runTurn(ctx, 's1', 1, '把 packages/core/src/store.ts 的检索超时改成 500ms', '改好了')
    await handle.idle()

    const search = ctx.registered.find(tool => tool.name === 'memory_search')!
    const value = String(await search.execute({ query: 'store.ts 超时' }, {}))
    expect(value).toContain('检索超时定为 500ms')
  })

  test('reports harvest progress in memory_status', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:', minTurnChars: 10 })
    await runTurn(ctx, 's1', 1, '把 packages/core/src/store.ts 的检索超时改成 500ms', '改好了')
    await handle.idle()
    const status = ctx.registered.find(tool => tool.name === 'memory_status')!
    expect(String(await status.execute({}, {}))).toMatch(/收割.*1/)
  })
})

describe('proactive recall', () => {
  const decisionFor = (text: string) => ({ kind: 'enter' as const, messages: [userMessage(text)] })

  test('prepends matching memories to the step the model is about to take', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    await ctx.registered.find(tool => tool.name === 'memory_save')!.execute({ content: '接口层统一用 zod 做参数校验' }, {})

    const [decision] = await ctx.fire('agent/pre-step', { agent: {}, messages: decisionFor('用 zod 做参数校验').messages, turn: 1, step: 1 }, async () => decisionFor('用 zod 做参数校验')) as { messages: { source: { kind: string; form?: string }; content: { text: string }[] }[] }[]
    expect(decision!.messages).toHaveLength(2)
    expect(decision!.messages[0]!.source).toMatchObject({ kind: 'plugin', form: 'recall' })
    expect(decision!.messages[0]!.content[0]!.text).toContain('zod')
  })

  test('does not show the same memory twice in one session', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    await ctx.registered.find(tool => tool.name === 'memory_save')!.execute({ content: '接口层统一用 zod 做参数校验' }, {})
    const payload = { agent: {}, messages: decisionFor('用 zod 做参数校验').messages, turn: 1, step: 1 }
    await ctx.fire('agent/pre-step', payload, async () => decisionFor('用 zod 做参数校验'))
    const [second] = await ctx.fire('agent/pre-step', payload, async () => decisionFor('用 zod 做参数校验')) as { messages: unknown[] }[]
    expect(second!.messages).toHaveLength(1)
  })

  test('leaves a step without human text alone', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const decision = { kind: 'enter' as const, messages: [{ ...userMessage('x'), source: { kind: 'plugin', plugin: 'other' } }] }
    const [result] = await ctx.fire('agent/pre-step', { agent: {}, messages: decision.messages, turn: 1, step: 1 }, async () => decision)
    expect(result).toBe(decision)
  })
})

describe('profile section', () => {
  test('registers a system prompt section that reflects global memories', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const section = ctx.sections.find(s => s.name === 'memgas:profile')!
    const render = () => (typeof section.text === 'function' ? section.text() : section.text)
    expect(render()).toBe('')
    await ctx.registered.find(tool => tool.name === 'memory_save')!.execute({ content: '回复一律用中文', global: true }, {})
    expect(render()).toContain('回复一律用中文')
  })
})

describe('the /memory command', () => {
  test('is registered and answers help', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const command = ctx.registeredCommands.find(c => c.name === 'memory')!
    const result = await command.handler({ rawInput: '', agent: {} })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('search')
  })

  test('reports the same status text the tool reports', async () => {
    const ctx = fakeContext()
    apply(ctx as never, { dataDir: ':memory:' })
    const command = ctx.registeredCommands.find(c => c.name === 'memory')!
    const viaCommand = await command.handler({ rawInput: 'status', agent: {} })
    const viaTool = String(await ctx.registered.find(t => t.name === 'memory_status')!.execute({}, {}))
    expect(viaCommand.text).toBe(viaTool)
  })
})

describe('per-session scope', () => {
  test('uses the working directory of the session that raised the event', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:', minTurnChars: 10 })
    const session = { id: 's1', cwd: '/tmp/other-project' }
    await ctx.fire('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    expect(handle.scopeForSession('s1')).toMatch(/^project:/)
    expect(handle.scopeForSession('s1')).not.toBe(handle.scopeForSession('unknown-session'))
  })

  test('falls back to the process directory for a session without one', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:' })
    expect(handle.scopeForSession('never-seen')).toBe(handle.defaultScope)
  })
})

describe('evolution wiring', () => {
  test('reinforces a memory that the assistant cited back', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:', recall: true, harvest: false })
    await ctx.registered.find(t => t.name === 'memory_save')!.execute({ content: '接口层统一用 zod 做参数校验' }, {})
    const saved = handle.memory.store.listActive({ scopes: [handle.defaultScope], limit: 1 })[0]!
    const before = saved.importance

    const decision = { kind: 'enter' as const, messages: [userMessage('用 zod 做参数校验')] }
    await ctx.fire('agent/pre-step', { agent: {}, messages: decision.messages, turn: 1, step: 1 }, async () => decision)
    await ctx.fire('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: `照 memory:${saved.id} 的约定来` }] } },
    })
    await handle.idle()
    expect(handle.memory.store.get(saved.id)!.importance).toBeGreaterThan(before)
  })

  test('sweeps once per session start', async () => {
    const ctx = fakeContext()
    const handle = apply(ctx as never, { dataDir: ':memory:', evolve: true })
    await ctx.fire('agent/session-start', { agent: { session: { id: 's1' } }, source: 'startup' })
    await handle.idle()
    expect(handle.evolutionStats().archived).toBe(0)
  })
})

describe('resolveScope', () => {
  test('derives a project key from the git remote when there is one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memgas-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: dir })
    expect(resolveScope(dir)).toBe('project:github.com/acme/widget')
  })

  test('falls back to a directory key outside a git checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memgas-plain-'))
    expect(resolveScope(dir)).toMatch(/^project:cwd\//)
  })
})

describe('storePathFor', () => {
  test('turns a scope key into one filesystem-safe file per scope', () => {
    const path = storePathFor('/home/u/.dsh', 'project:github.com/acme/widget')
    expect(path.startsWith('/home/u/.dsh/memgas/')).toBe(true)
    expect(path.endsWith('.sqlite')).toBe(true)
    expect(path.slice('/home/u/.dsh/memgas/'.length)).not.toContain('/')
  })

  test('keeps different scopes in different files', () => {
    expect(storePathFor('/h', 'project:a/b')).not.toBe(storePathFor('/h', 'project:a/c'))
  })
})
