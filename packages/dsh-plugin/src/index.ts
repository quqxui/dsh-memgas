import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createMemoryService, type MemoryService } from '@memgas/core'
import { handleSave, handleSearch, handleStatus } from './handlers.ts'
import { resolveScope, storePathFor } from './workspace.ts'

export const name = 'memgas'

/**
 * Cordis refuses `ctx.tools` access unless the plugin declares it, and the
 * refusal aborts the whole plugin tree, so this list is load-bearing.
 */
export const inject = ['tools']

/** Structural view of the parts of the Cordis context this plugin uses. */
interface ToolRegistryLike {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
    execute(args: unknown, exec: unknown): Promise<unknown>
  }): () => void
}
interface ContextLike {
  tools: ToolRegistryLike
}

export interface Config {
  /** Directory holding the SQLite stores; `:memory:` keeps everything in RAM. */
  dataDir?: string
  /** Working directory used to decide which project the memories belong to. */
  cwd?: string
  /** How many memories a search returns. */
  k?: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

function openService(config: Config, scope: string): MemoryService {
  const dataDir = config.dataDir ?? process.env['DSH_HOME'] ?? `${homedir()}/.dsh`
  if (dataDir === ':memory:') return createMemoryService({ path: ':memory:' })
  const path = storePathFor(dataDir, scope)
  mkdirSync(dirname(path), { recursive: true })
  return createMemoryService({ path })
}

export function apply(ctx: ContextLike, config: Config = {}): void {
  const cwd = config.cwd ?? process.cwd()
  const scope = resolveScope(cwd)
  const k = config.k ?? 8

  // A memory plugin that cannot open its database must still let the harness
  // start: it degrades to a session-local store and says so in its status.
  let memory: MemoryService
  let storeWarning: string | null = null
  try {
    memory = openService(config, scope)
  } catch (error) {
    storeWarning = `未能打开磁盘记忆库（${error instanceof Error ? error.message : String(error)}），` +
      '本次会话的记忆只保存在内存中，退出即丢失。'
    memory = createMemoryService({ path: ':memory:' })
  }

  ctx.tools.register({
    name: 'memory_search',
    description:
      'Search long-term memory for facts, decisions and conventions recorded in earlier sessions of this project. ' +
      'Call it before asking the user something they may have already told you.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in the user\'s own words.' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { query } = args as { query: string }
      return handleSearch(memory, { query, scope, k })
    },
  })

  ctx.tools.register({
    name: 'memory_save',
    description:
      'Record one durable fact, decision, convention or pitfall worth recalling in a later session. ' +
      'Do not record transient state, secrets, or anything already obvious from the code.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember, stated so it stands alone.' },
        global: { type: 'boolean', description: 'True when it is about the user rather than this project.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { content, global: isGlobal } = args as { content: string; global?: boolean }
      return handleSave(memory, { content, scope: isGlobal ? 'global' : scope })
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description: 'Report how many memories exist for this project and which retrieval backends are active.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute() {
      return handleStatus(memory, storeWarning)
    },
  })
}
