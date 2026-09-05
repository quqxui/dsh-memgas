import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BackgroundQueue,
  EvolutionRunner,
  Harvester,
  buildProfileSection,
  createMemoryService,
  planInjection,
  referencedMemoryIds,
  type EvolutionStats,
  type MemoryService,
  type RetrievalMode,
} from 'memgas-core'
import { handleSave, handleSearch, handleStatus } from './handlers.ts'
import { resolveScope, storePathFor } from './workspace.ts'
import { SessionEventMapper, type SessionEventLike } from './session-events.ts'
import { DshLlmClient, type LlmRuntimeLike } from './llm-client.ts'
import { composeRecall, type EnterDecision, type PluginUserMessage } from './recall.ts'
import { runMemoryCommand } from './command.ts'

export const name = 'memgas'

/**
 * Cordis refuses access to an undeclared service, and the refusal aborts the
 * whole plugin tree, so this list is load-bearing.
 */
export const inject = ['tools', 'systemPrompt', 'llm', 'commands']

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
interface CommandRegistryLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler(invocation: { rawInput: string; agent: unknown }): Promise<{ kind: 'success' | 'error'; text?: string }>
  }): () => void
}
interface SessionLike {
  id: string
  cwd?: string
}
interface AgentLike {
  session?: SessionLike
}
type PreStepDecision = { kind: 'reject' } | EnterDecision
interface PreStepPayload {
  agent: AgentLike
  messages: PluginUserMessage[]
  turn: number
  step: number
}
interface ContextLike {
  /** Registers a teardown hook; Cordis awaits async disposers. */
  effect(execute: () => () => Promise<void>): unknown
  tools: ToolRegistryLike
  systemPrompt: SystemPromptLike
  commands: CommandRegistryLike
  llm: LlmRuntimeLike
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  on(event: 'agent/session-start', listener: (payload: { agent: AgentLike; source: string }) => void): () => void
  on(
    event: 'agent/pre-step',
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
  ): () => void
}

export interface Config {
  /** Directory holding the SQLite stores; `:memory:` keeps everything in RAM. */
  dataDir?: string
  /** Working directory used when a session does not declare its own. */
  cwd?: string
  /** How many memories a search returns. */
  k?: number
  mode?: RetrievalMode
  /** Harvest completed turns automatically through the session's own model. */
  harvest?: boolean
  minTurnChars?: number
  /** Inject matching memories before a step. */
  recall?: boolean
  denseThreshold?: number
  injectBudgetTokens?: number
  sectionBudgetTokens?: number
  /** Local sentence-embedding model; null keeps the lexical fallback. */
  localModel?: { model: string; cacheDir?: string; mirror?: string } | null
  /** Park harvested facts until the user accepts them with `/memory review`. */
  confirmWrites?: boolean
  /** Run the background maintenance processes. */
  evolve?: boolean
  halfLifeDays?: number
  archiveBelow?: number
  maxActive?: number
  abstractClusterSize?: number
  reassociateEvery?: number
}

export interface PluginHandle {
  /** Resolves when all background work has drained; for tests and shutdown. */
  idle(): Promise<void>
  /** The scope used when a session does not declare a working directory. */
  readonly defaultScope: string
  scopeForSession(sessionId: string): string
  /** The store of the default scope. */
  readonly memory: MemoryService
  evolutionStats(): EvolutionStats
}

const DEFAULTS = {
  k: 8,
  mode: 'hybrid' as RetrievalMode,
  harvest: true,
  minTurnChars: 80,
  recall: true,
  denseThreshold: 0.6,
  injectBudgetTokens: 600,
  sectionBudgetTokens: 400,
  localModel: null as Config['localModel'],
  confirmWrites: false,
  evolve: true,
  halfLifeDays: 30,
  archiveBelow: 0.15,
  maxActive: 5000,
  abstractClusterSize: 12,
  reassociateEvery: 200,
  /** The pre-step path sits on the turn's critical path; keep it well under the default budget. */
  recallBudgetMs: 150,
  backgroundJobTimeoutMs: 60_000,
  profileSectionOrder: 300,
  /** Upper bound on how long shutdown waits for background work. */
  drainTimeoutMs: 15_000,
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

function humanText(messages: PluginUserMessage[]): string {
  return messages
    .filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    .join('\n')
    .trim()
}

/** Everything owned by one project scope: its store and its background workers. */
interface Workspace {
  scope: string
  memory: MemoryService
  harvester: Harvester
  evolution: EvolutionRunner
  queue: BackgroundQueue
  warning: string | null
}

export function apply(ctx: ContextLike, config: Config = {}): PluginHandle {
  const settings = { ...DEFAULTS, ...config }
  const defaultCwd = config.cwd ?? process.cwd()
  const defaultScope = resolveScope(defaultCwd)
  const ROUTE_META_KEY = 'route:last'
  const mapper = new SessionEventMapper(route => {
    // Persisted so a fresh process can distil leftovers before its own first
    // model request tells it which route to use.
    for (const workspace of workspaces.values()) {
      try {
        workspace.memory.store.setMeta(ROUTE_META_KEY, JSON.stringify(route))
      } catch {
        // A store that cannot record the route still works for everything else.
      }
    }
  })

  function storedRoute(): { provider: string; model: string } | null {
    for (const workspace of workspaces.values()) {
      try {
        const raw = workspace.memory.store.getMeta(ROUTE_META_KEY)
        if (!raw) continue
        const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown }
        if (typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
          return { provider: parsed.provider, model: parsed.model }
        }
      } catch {
        // Ignore an unreadable record and try the next store.
      }
    }
    return null
  }

  const llm = new DshLlmClient({
    llm: ctx.llm,
    route: sessionId =>
      (sessionId ? mapper.routeFor(sessionId) : null) ?? mapper.latestRoute() ?? storedRoute(),
  })

  const workspaces = new Map<string, Workspace>()
  const sessionScopes = new Map<string, string>()
  /** Memories already shown to the model, per session. */
  const injected = new Map<string, Set<string>>()

  function openService(scope: string): { memory: MemoryService; warning: string | null } {
    const dataDir = config.dataDir ?? process.env['DSH_HOME'] ?? `${homedir()}/.dsh`
    const options = {
      mode: settings.mode,
      coldStartUnits: 0,
      associateOnSave: true,
      localModel: settings.localModel,
    }
    if (dataDir === ':memory:') return { memory: createMemoryService({ path: ':memory:', ...options }), warning: null }
    try {
      const path = storePathFor(dataDir, scope)
      mkdirSync(dirname(path), { recursive: true })
      return { memory: createMemoryService({ path, ...options }), warning: null }
    } catch (error) {
      // A memory plugin that cannot open its database must still let the
      // harness run: it degrades to a session-local store and says so.
      return {
        memory: createMemoryService({ path: ':memory:', ...options }),
        warning: `未能打开磁盘记忆库（${error instanceof Error ? error.message : String(error)}），` +
          '本次会话的记忆只保存在内存中，退出即丢失。',
      }
    }
  }

  function workspaceFor(scope: string): Workspace {
    const existing = workspaces.get(scope)
    if (existing) return existing

    const { memory, warning } = openService(scope)
    const queue = new BackgroundQueue({ jobTimeoutMs: settings.backgroundJobTimeoutMs })
    const evolution = new EvolutionRunner({
      store: memory.store,
      llm,
      embedder: memory.embedder,
      queue,
      scope,
      enabled: settings.evolve,
      halfLifeDays: settings.halfLifeDays,
      archiveBelow: settings.archiveBelow,
      maxActive: settings.maxActive,
      abstractClusterSize: settings.abstractClusterSize,
      reassociateEvery: settings.reassociateEvery,
    })
    const harvester = new Harvester({
      store: memory.store,
      embedder: memory.embedder,
      llm,
      queue,
      scope,
      minTurnChars: settings.minTurnChars,
      confirmWrites: settings.confirmWrites,
      cwd: defaultCwd,
      onUnitStored: id => evolution.onFactStored(id),
    })

    const workspace: Workspace = { scope, memory, harvester, evolution, queue, warning }
    workspaces.set(scope, workspace)
    return workspace
  }

  const primary = workspaceFor(defaultScope)

  /** A session works in its own directory; its memories belong to that project. */
  function scopeForSession(sessionId: string | undefined): string {
    if (!sessionId) return defaultScope
    return sessionScopes.get(sessionId) ?? defaultScope
  }

  function noteSession(session: SessionLike | undefined): string {
    if (!session?.id) return defaultScope
    const known = sessionScopes.get(session.id)
    if (known) return known
    const scope = session.cwd ? resolveScope(session.cwd) : defaultScope
    sessionScopes.set(session.id, scope)
    workspaceFor(scope)
    return scope
  }

  function statusText(workspace: Workspace): string {
    const harvest = workspace.harvester.stats()
    const jobs = workspace.queue.stats()
    const evolve = workspace.evolution.stats()
    const pending = workspace.memory.store.listUnits({ scopes: [workspace.scope], statuses: ['pending'], limit: 200 })
    return handleStatus(workspace.memory, workspace.warning, [
      `作用域：${workspace.scope}`,
      ...(pending.length > 0 ? [`待确认：${pending.length} 条（用 /memory review 处理）`] : []),
      `自动收割：已收割 ${harvest.harvestedTurns} 轮，跳过过短 ${harvest.skippedShort} 轮，抽取失败 ${harvest.extractionFailures} 次` +
        (harvest.lastFailure ? `（最近：${harvest.lastFailure}）` : ''),
      `演化：调和 ${evolve.reconciled}，归档 ${evolve.archived}，抽象 ${evolve.abstracted}，重关联 ${evolve.reassociations}` +
        (evolve.lastFailure ? `（最近失败：${evolve.lastFailure}）` : ''),
      `后台队列：待处理 ${jobs.pending}，已完成 ${jobs.done}，失败 ${jobs.failed}`,
    ])
  }

  function workspaceForExec(exec: unknown): Workspace {
    const agent = (exec as { agent?: AgentLike } | undefined)?.agent
    return workspaceFor(scopeForSession(agent?.session?.id))
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
    async execute(args, exec) {
      const { query } = args as { query: string }
      const workspace = workspaceForExec(exec)
      return handleSearch(workspace.memory, { query, scope: workspace.scope, k: settings.k })
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
    async execute(args, exec) {
      const { content, global: isGlobal, kind } = args as { content: string; global?: boolean; kind?: string }
      const workspace = workspaceForExec(exec)
      return handleSave(workspace.memory, {
        content,
        scope: isGlobal ? 'global' : workspace.scope,
        ...(kind ? { kind } : {}),
      })
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description: 'Report how many memories exist for this project and which retrieval backends are active.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      return statusText(workspaceForExec(exec))
    },
  })

  ctx.commands.register({
    name: 'memory',
    description: '查看、检索、导出和清理长期记忆',
    input: { hint: 'status | search <词> | diag <词> | list | forget <id> | pin <id> | export | purge --yes' },
    async handler(invocation) {
      const agent = invocation.agent as AgentLike | undefined
      const workspace = workspaceFor(scopeForSession(agent?.session?.id))
      try {
        return await runMemoryCommand(invocation.rawInput, {
          memory: workspace.memory,
          scope: workspace.scope,
          status: () => statusText(workspace),
        })
      } catch (error) {
        return { kind: 'error', text: `/memory 执行失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.systemPrompt.section({
    name: 'memgas:profile',
    order: settings.profileSectionOrder,
    text: () => {
      try {
        return buildProfileSection(
          primary.memory.store.listActive({ scopes: ['global'], limit: 40 }),
          { budgetTokens: settings.sectionBudgetTokens },
        )
      } catch {
        return ''
      }
    },
  })

  ctx.on('agent/session-start', payload => {
    try {
      const scope = noteSession(payload.agent?.session)
      const workspace = workspaceFor(scope)
      workspace.evolution.onSessionStart()
      // A one-shot host can exit before an extraction lands. Finish those now,
      // while there is a live process and a working model route.
      workspace.queue.enqueue('catch-up', async signal => {
        await workspace.harvester.catchUp({ signal })
      })
    } catch {
      // Maintenance is best-effort; a session must start regardless.
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      const scope = noteSession(session)
      const workspace = workspaceFor(scope)
      const mapped = mapper.map(session.id, event)
      if (mapped && settings.harvest) workspace.harvester.observe(session.id, mapped)
      if (mapped?.type === 'assistant') {
        const shown = injected.get(session.id)
        if (shown?.size) {
          const cited = referencedMemoryIds(mapped.text).filter(id => shown.has(id))
          if (cited.length > 0) workspace.evolution.onRecallUsed(cited)
        }
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
      const sessionId = payload.agent?.session?.id
      const workspace = workspaceFor(scopeForSession(sessionId))
      const shown = injected.get(sessionId ?? defaultScope) ?? new Set<string>()

      const result = await workspace.memory.search({
        query,
        scopes: [workspace.scope, 'global'],
        k: settings.k,
        budgetMs: settings.recallBudgetMs,
      })
      const plan = planInjection(result, {
        denseThreshold: settings.denseThreshold,
        budgetTokens: settings.injectBudgetTokens,
        exclude: shown,
      })
      if (!plan) return decision
      for (const id of plan.ids) shown.add(id)
      injected.set(sessionId ?? defaultScope, shown)
      workspace.evolution.onRecallUsed(plan.ids)
      return composeRecall(decision, plan.text)
    } catch {
      // A failed recall costs one missed memory, never the step itself.
      return decision
    }
  })

  const drain = () => Promise.all([...workspaces.values()].map(workspace => workspace.queue.idle()))

  // One-shot hosts exit as soon as the turn finishes. Without this the
  // harvest and evolution jobs queued during that turn are dropped and the
  // session leaves no memory behind. The deadline keeps a stuck job from
  // holding the process open.
  ctx.effect(() => async () => {
    await Promise.race([
      drain().then(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, settings.drainTimeoutMs).unref?.()),
    ])
  })

  return {
    idle: async () => {
      await drain()
    },
    defaultScope,
    scopeForSession: (sessionId: string) => scopeForSession(sessionId),
    memory: primary.memory,
    evolutionStats: () => primary.evolution.stats(),
  }
}
