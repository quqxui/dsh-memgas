import { createMemoryService, formatCard, type MemoryService, type RetrievalMode } from '@memgas/core'

export interface McpServer {
  handle(message: unknown): Promise<unknown>
  close(): void
}

export interface McpServerOptions {
  path: string
  scope: string
  mode?: RetrievalMode
  k?: number
}

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'memgas', version: '0.0.1' }
const INGEST_MAX_CHARS = 8000

interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<string>
}

const stringArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing required argument: ${key}`)
  return value
}

/**
 * A minimal JSON-RPC surface over the same store the dsh plugin uses, for
 * agents that have no session events to harvest from.
 *
 * It has no model of its own, so `memory_ingest` keeps the transcript verbatim
 * instead of summarizing it: worse memories than the plugin produces, but
 * usable ones, and no configuration to get wrong.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const memory: MemoryService = createMemoryService({
    path: options.path,
    mode: options.mode ?? 'hybrid',
    coldStartUnits: 0,
    associateOnSave: true,
  })
  const scope = options.scope
  const k = options.k ?? 8

  const tools: ToolSpec[] = [
    {
      name: 'memory_search',
      description: 'Search long-term memory for facts recorded in earlier sessions.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for.' } },
        required: ['query'],
      },
      async run(args) {
        const result = await memory.search({ query: stringArg(args, 'query'), scopes: [scope, 'global'], k })
        if (result.items.length === 0) return '没有找到相关记忆。'
        return result.items.map(item => formatCard(item.unit)).join('\n\n')
      },
    },
    {
      name: 'memory_save',
      description: 'Record one durable fact worth recalling in a later session.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          global: { type: 'boolean' },
          kind: { type: 'string' },
        },
        required: ['content'],
      },
      async run(args) {
        const saved = await memory.save({
          content: stringArg(args, 'content'),
          scope: args['global'] === true ? 'global' : scope,
          kind: typeof args['kind'] === 'string' ? args['kind'] : 'note',
          granularity: 'summary',
        })
        return saved ? `已记住（${saved.id}）：${saved.content}` : '未写入：内容为空，或全部被密钥过滤规则拦下。'
      },
    },
    {
      name: 'memory_ingest',
      description:
        'Store a raw conversation transcript as memory. Use it when the host has no session events to harvest.',
      inputSchema: {
        type: 'object',
        properties: { transcript: { type: 'string' } },
        required: ['transcript'],
      },
      async run(args) {
        const saved = await memory.save({
          content: stringArg(args, 'transcript').slice(0, INGEST_MAX_CHARS),
          scope,
          granularity: 'turn',
        })
        return saved ? `已收录（${saved.id}）。` : '未写入：内容为空，或全部被密钥过滤规则拦下。'
      },
    },
    {
      name: 'memory_forget',
      description: 'Archive one memory by id. It stays in the store and can be restored.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(args) {
        const id = stringArg(args, 'id')
        if (!memory.store.get(id)) throw new Error(`no such memory: ${id}`)
        memory.store.patch(id, { status: 'archived', updatedAt: Date.now() })
        return `已归档 ${id}。`
      },
    },
    {
      name: 'memory_status',
      description: 'Report how many memories exist and which retrieval backends are active.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const status = memory.status()
        return [
          `作用域：${scope}`,
          `记忆条数：${status.units}`,
          `向量模型：${status.embedder}`,
          `词法索引：${status.lexicalIndex}`,
          `检索模式：${status.mode}（通道：${status.channels.join('、')}）`,
          `关联图：${status.graph.edges} 条边，${status.graph.status}`,
        ].join('\n')
      },
    },
  ]

  const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

  return {
    async handle(message: unknown): Promise<unknown> {
      if (typeof message !== 'object' || message === null) return error(null, -32600, 'invalid request')
      const request = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> }
      // A notification has no id and, per JSON-RPC, gets no response.
      if (request.id === undefined) return null

      switch (request.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
          }

        case 'ping':
          return { jsonrpc: '2.0', id: request.id, result: {} }

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          }

        case 'tools/call': {
          const params = request.params ?? {}
          const tool = tools.find(candidate => candidate.name === params['name'])
          if (!tool) return error(request.id, -32602, `unknown tool: ${String(params['name'])}`)
          const args = (params['arguments'] ?? {}) as Record<string, unknown>
          try {
            const text = await tool.run(args)
            return { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }], isError: false } }
          } catch (failure) {
            // Tool failures are results, not transport errors: the caller
            // should see what went wrong without the connection dropping.
            return {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                content: [{ type: 'text', text: failure instanceof Error ? failure.message : String(failure) }],
                isError: true,
              },
            }
          }
        }

        default:
          return error(request.id, -32601, `unknown method: ${String(request.method)}`)
      }
    },
    close() {
      memory.close()
    },
  }
}
