import { describe, expect, test } from 'vitest'
import { createMcpServer } from '../src/server.ts'

const server = () => createMcpServer({ path: ':memory:', scope: 'project:p' })

async function call(name: string, args: Record<string, unknown>) {
  const result = await server().handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  })
  return result
}

describe('createMcpServer', () => {
  test('reports its protocol version and name on initialize', async () => {
    const result = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect((result as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('memgas')
  })

  test('lists the memory tools it exposes', async () => {
    const result = await server().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) as {
      result: { tools: { name: string }[] }
    }
    expect(result.result.tools.map(tool => tool.name).sort())
      .toEqual(['memory_forget', 'memory_ingest', 'memory_save', 'memory_search', 'memory_status'])
  })

  test('saves and then finds a memory through tool calls', async () => {
    const instance = server()
    await instance.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory_save', arguments: { content: '接口层统一用 zod 做参数校验' } },
    })
    const found = await instance.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'zod 校验' } },
    }) as { result: { content: { text: string }[] } }
    expect(found.result.content[0]!.text).toContain('zod')
  })

  test('ingest stores a transcript without needing a model', async () => {
    const instance = server()
    await instance.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory_ingest', arguments: { transcript: 'user: 部署端口是 8080\nassistant: 记下了' } },
    })
    const found = await instance.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: '部署端口' } },
    }) as { result: { content: { text: string }[] } }
    expect(found.result.content[0]!.text).toContain('8080')
  })

  test('strips credentials on the ingest path too', async () => {
    const instance = server()
    await instance.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory_ingest', arguments: { transcript: 'user: api_key = "sk-abcd1234abcd1234abcd"' } },
    })
    const found = await instance.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'api_key' } },
    }) as { result: { content: { text: string }[] } }
    expect(JSON.stringify(found)).not.toContain('sk-abcd1234abcd1234abcd')
  })

  test('returns a JSON-RPC error for an unknown method', async () => {
    const result = await server().handle({ jsonrpc: '2.0', id: 9, method: 'nope', params: {} }) as {
      error: { code: number }
    }
    expect(result.error.code).toBe(-32601)
  })

  test('returns a JSON-RPC error for an unknown tool', async () => {
    const result = await call('memory_frobnicate', {}) as { error: { code: number } }
    expect(result.error.code).toBe(-32602)
  })

  test('reports a failing tool as an error result rather than crashing', async () => {
    const result = await call('memory_search', {}) as { result: { isError: boolean } }
    expect(result.result.isError).toBe(true)
  })

  test('answers notifications with nothing at all', async () => {
    expect(await server().handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })).toBeNull()
  })

  test('status reports the store it is serving', async () => {
    const result = await call('memory_status', {}) as { result: { content: { text: string }[] } }
    expect(result.result.content[0]!.text).toContain('project:p')
  })
})
