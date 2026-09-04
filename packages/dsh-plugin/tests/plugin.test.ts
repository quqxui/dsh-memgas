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

function fakeContext() {
  const tools: RegisteredTool[] = []
  return {
    tools: { register: (definition: RegisteredTool) => { tools.push(definition); return () => {} } },
    registered: tools,
  }
}

describe('plugin manifest', () => {
  test('declares the services it reaches for, or Cordis refuses the context access', () => {
    expect(inject).toContain('tools')
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
