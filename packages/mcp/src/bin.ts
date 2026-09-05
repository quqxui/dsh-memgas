#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { projectKeyFor, type RetrievalMode } from 'memgas-core'
import { createMcpServer } from './server.ts'

function gitRemote(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Same layout the dsh plugin uses, so both can serve one store. */
function storePathFor(home: string, scope: string): string {
  const slug = scope.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 8)
  return join(home, 'memgas', `${slug}-${digest}.sqlite`)
}

const cwd = process.env['MEMGAS_PROJECT_DIR'] ?? process.cwd()
const scope = process.env['MEMGAS_SCOPE'] ?? projectKeyFor({ gitRemote: gitRemote(cwd), cwd })
const home = process.env['MEMGAS_HOME'] ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const path = storePathFor(home, scope)
mkdirSync(dirname(path), { recursive: true })

const server = createMcpServer({
  path,
  scope,
  mode: (process.env['MEMGAS_MODE'] as RetrievalMode | undefined) ?? 'hybrid',
})

const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  void (async () => {
    let response: unknown
    try {
      response = await server.handle(JSON.parse(trimmed))
    } catch (error) {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
      }
    }
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`)
  })()
})

reader.on('close', () => {
  server.close()
})
