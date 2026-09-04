import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BackgroundQueue,
  Harvester,
  buildProfileSection,
  createMemoryService,
  planInjection,
  referencedMemoryIds,
  type MemoryService,
} from '@memgas/core'
import { handleSave, handleSearch, handleStatus } from './handlers.ts'
import { resolveScope, storePathFor } from './workspace.ts'
import { SessionEventMapper, type SessionEventLike } from './session-events.ts'
import { DshLlmClient, type LlmRuntimeLike } from './llm-client.ts'
import { composeRecall, type EnterDecision, type PluginUserMessage } from './recall.ts'

export const name = 'memgas'

/**
 * Cordis refuses access to an undeclared service, and the refusal aborts the
 * whole plugin tree, so this list is load-bearing.
 */
export const inject = ['tools', 'systemPrompt', 'llm']

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
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}
type PreStepDecision = { kind: 'reject' } | EnterDecision
interface PreStepPayload {
  agent: unknown
  messages: PluginUserMessage[]
  turn: number
  step: number
}
interface ContextLike {
  tools: ToolRegistryLike
  systemPrompt: SystemPromptLike
  llm: LlmRuntimeLike
  on(event: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void): () => void
  on(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>): () => void
}

export interface Config {
  /** Directory holding the SQLite stores; `:memory:` keeps everything in RAM. */
  dataDir?: string
  /** Working directory used to decide which project the memories belong to. */
  cwd?: string
  /** How many memories a search returns. */
  k?: number
  /** Harvest completed turns automatically through the session's own model. */
  harvest?: boolean
  /** Turns shorter than this many characters are not worth a model call. */
  minTurnChars?: number
  /** Inject matching memories before a step. */
  recall?: boolean
  denseThreshold?: number
  injectBudgetTokens?: number
  sectionBudgetTokens?: number
}

export interface PluginHandle {
  /** Resolves when background harvesting has drained; for tests and shutdown. */
  idle(): Promise<void>
}

const DEFAULTS = {
  k: 8,
  harvest: true,
  minTurnChars: 80,
  recall: true,
  denseThreshold: 0.6,
  injectBudgetTokens: 600,
  sectionBudgetTokens: 400,
  /** The pre-step path sits on the turn's critical path; keep it well under the default budget. */
  recallBudgetMs: 150,
  harvestJobTimeoutMs: 60_000,
  profileSectionOrder: 300,
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

function humanText(messages: PluginUserMessage[]): string {
  return messages
    .filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    .join('\n')
    .trim()
}

export function apply(ctx: ContextLike, config: Config = {}): PluginHandle {
  const settings = { ...DEFAULTS, ...config }
  const cwd = config.cwd ?? process.cwd()
  const scope = resolveScope(cwd)

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

  const mapper = new SessionEventMapper()
  const queue = new BackgroundQueue({ jobTimeoutMs: settings.harvestJobTimeoutMs })
  const harvester = new Harvester({
    store: memory.store,
    embedder: memory.embedder,
    llm: new DshLlmClient({ llm: ctx.llm, route: sessionId => (sessionId ? mapper.routeFor(sessionId) : null) }),
    queue,
    scope,
    minTurnChars: settings.minTurnChars,
    cwd,
  })
  /** Memories already shown to the model in this process; showing them again only burns context. */
  const injected = new Set<string>()

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
      return handleSearch(memory, { query, scope, k: settings.k })
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
        kind: {
          type: 'string',
          enum: ['preference', 'decision', 'convention', 'environment', 'pitfall', 'entity', 'todo', 'note'],
          description: 'What sort of fact this is; omit for a plain note.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { content, global: isGlobal, kind } = args as { content: string; global?: boolean; kind?: string }
      return handleSave(memory, { content, scope: isGlobal ? 'global' : scope, ...(kind ? { kind } : {}) })
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description: 'Report how many memories exist for this project and which retrieval backends are active.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute() {
      const harvest = harvester.stats()
      const jobs = queue.stats()
      return handleStatus(memory, storeWarning, [
        `自动收割：已收割 ${harvest.harvestedTurns} 轮，跳过过短 ${harvest.skippedShort} 轮，抽取失败 ${harvest.extractionFailures} 次` +
          (harvest.lastFailure ? `（最近：${harvest.lastFailure}）` : ''),
        `后台队列：待处理 ${jobs.pending}，已完成 ${jobs.done}，失败 ${jobs.failed}`,
      ])
    },
  })

  ctx.systemPrompt.section({
    name: 'memgas:profile',
    order: settings.profileSectionOrder,
    text: () => {
      try {
        return buildProfileSection(
          memory.store.listActive({ scopes: ['global'], limit: 40 }),
          { budgetTokens: settings.sectionBudgetTokens },
        )
      } catch {
        return ''
      }
    },
  })

  ctx.on('session/event', (session, event) => {
    try {
      const mapped = mapper.map(session.id, event)
      if (mapped && settings.harvest) harvester.observe(session.id, mapped)
      if (mapped?.type === 'assistant' && injected.size > 0) {
        const cited = referencedMemoryIds(mapped.text).filter(id => injected.has(id))
        if (cited.length > 0) memory.store.touch(cited, Date.now())
      }
    } catch {
      // Observation must never affect the session that produced the event.
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!settings.recall || decision.kind !== 'enter') return decision
    try {
      const query = humanText(decision.messages)
      if (!query) return decision
      const result = await memory.search({
        query,
        scopes: [scope, 'global'],
        k: settings.k,
        budgetMs: settings.recallBudgetMs,
      })
      const plan = planInjection(result, {
        denseThreshold: settings.denseThreshold,
        budgetTokens: settings.injectBudgetTokens,
        exclude: injected,
      })
      if (!plan) return decision
      for (const id of plan.ids) injected.add(id)
      memory.store.touch(plan.ids, Date.now())
      return composeRecall(decision, plan.text)
    } catch {
      // A failed recall costs one missed memory, never the step itself.
      return decision
    }
  })

  return { idle: () => queue.idle() }
}
