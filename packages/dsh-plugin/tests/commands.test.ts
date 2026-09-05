import { describe, expect, test } from 'vitest'
import { createMemoryService } from '@memgas/core'
import { runMemoryCommand } from '../src/command.ts'

async function seeded() {
  const memory = createMemoryService({ path: ':memory:', coldStartUnits: 0 })
  await memory.save({ content: '接口层统一用 zod 做参数校验', scope: 'project:p', kind: 'decision' })
  return memory
}

const ctx = (over: Partial<Parameters<typeof runMemoryCommand>[1]> = {}) => ({
  memory: undefined as never,
  scope: 'project:p',
  status: () => '状态占位',
  ...over,
})

describe('runMemoryCommand', () => {
  test('lists the subcommands when called with no arguments', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('', { ...ctx(), memory })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('search')
    expect(result.text).toContain('diag')
    expect(result.text).toContain('forget')
  })

  test('status delegates to the shared status text', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('status', { ...ctx({ status: () => '记忆条数：1' }), memory })
    expect(result.text).toContain('记忆条数：1')
  })

  test('search prints matching cards', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('search zod', { ...ctx(), memory })
    expect(result.text).toContain('zod')
    expect(result.text).toContain('[memory:')
  })

  test('diag explains which channels ran and what they contributed', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('diag zod', { ...ctx(), memory })
    expect(result.text).toMatch(/lexical/)
    expect(result.text).toMatch(/通道/)
  })

  test('forget archives a memory by id and says so', async () => {
    const memory = await seeded()
    const [item] = (await memory.search({ query: 'zod', scopes: ['project:p'], k: 1 })).items
    const result = await runMemoryCommand(`forget ${item!.unit.id}`, { ...ctx(), memory })
    expect(result.kind).toBe('success')
    expect(memory.store.get(item!.unit.id)!.status).toBe('archived')
  })

  test('forget reports an unknown id as an error instead of failing silently', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('forget m_0000000000', { ...ctx(), memory })
    expect(result.kind).toBe('error')
  })

  test('pin protects a memory from the decay sweep', async () => {
    const memory = await seeded()
    const [item] = (await memory.search({ query: 'zod', scopes: ['project:p'], k: 1 })).items
    await runMemoryCommand(`pin ${item!.unit.id}`, { ...ctx(), memory })
    expect(memory.store.get(item!.unit.id)!.kind).toBe('pinned')
  })

  test('export returns the memories of this scope as JSON', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('export', { ...ctx(), memory })
    const parsed = JSON.parse(result.text!)
    expect(parsed.scope).toBe('project:p')
    expect(parsed.units).toHaveLength(1)
  })

  test('purge refuses without the confirmation word', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('purge', { ...ctx(), memory })
    expect(result.kind).toBe('error')
    expect(memory.status().units).toBe(1)
  })

  test('purge deletes the scope when confirmed', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('purge --yes', { ...ctx(), memory })
    expect(result.kind).toBe('success')
    expect(memory.status().units).toBe(0)
  })

  test('rejects an unknown subcommand', async () => {
    const memory = await seeded()
    const result = await runMemoryCommand('frobnicate', { ...ctx(), memory })
    expect(result.kind).toBe('error')
  })
})
