import { randomBytes } from 'node:crypto'
import type { MemoryStore } from '../store/store.ts'
import type { LlmClient } from '../llm/client.ts'
import type { MemoryUnit } from '../types.ts'
import { parseStructured } from '../llm/structured.ts'
import { validateExtraction } from '../prompts/extraction.ts'
import { buildAbstractPrompt } from '../prompts/abstract-cluster.ts'

const SCAN_LIMIT = 2000
/** An abstraction is inference over memories, so it starts less trusted than they are. */
const ABSTRACTION_CONFIDENCE = 0.5

/**
 * The largest group of memories reachable from one node through association
 * edges. Good enough to spot that a dozen notes are all about one thing,
 * without maintaining a community-detection index.
 */
export function findCluster(store: MemoryStore, opts: { scopes: string[]; minSize: number }): string[] | null {
  const units = store.listUnits({ scopes: opts.scopes, statuses: ['active'], limit: SCAN_LIMIT })
  const ids = units.map(unit => unit.id)
  if (ids.length < opts.minSize) return null

  const edges = store.edges(ids, { kinds: ['association'] })
  if (edges.length === 0) return null
  const known = new Set(ids)
  const neighbours = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (!known.has(from) || !known.has(to)) return
    const set = neighbours.get(from) ?? new Set<string>()
    set.add(to)
    neighbours.set(from, set)
  }
  for (const edge of edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }

  let best: string[] | null = null
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    const component: string[] = []
    const queue = [id]
    seen.add(id)
    while (queue.length > 0) {
      const current = queue.shift()!
      component.push(current)
      for (const next of neighbours.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    if (component.length >= opts.minSize && (!best || component.length > best.length)) best = component
  }
  return best
}

export interface AbstractOutcome {
  created: string | null
  reason?: string
}

/**
 * Summarize a cluster into one higher-level memory.
 *
 * The result is additive: sources stay active, the new unit records what it
 * came from, and it carries lower confidence until it proves useful, so a bad
 * abstraction can never quietly replace the facts it was built from.
 */
export async function abstractCluster(
  store: MemoryStore,
  llm: LlmClient,
  ids: string[],
  opts: { scope: string; embedderId: string; now: number; signal?: AbortSignal; sessionId?: string },
): Promise<AbstractOutcome> {
  const units = ids.map(id => store.get(id)).filter((unit): unit is MemoryUnit => unit !== null)
  if (units.length === 0) return { created: null, reason: 'no sources' }

  const built = buildAbstractPrompt({ memories: units.map(unit => unit.content) })
  let raw: string
  try {
    raw = await llm.complete({
      system: built.system,
      prompt: built.prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    })
  } catch (error) {
    return { created: null, reason: error instanceof Error ? error.message : String(error) }
  }

  const parsed = parseStructured(raw, validateExtraction)
  if (!parsed.ok) return { created: null, reason: parsed.reason }
  if (!parsed.value.summary) return { created: null, reason: 'no common theme' }

  const id = `m_${randomBytes(5).toString('hex')}`
  store.put({
    id,
    scope: opts.scope,
    granularity: 'summary',
    content: parsed.value.summary,
    createdAt: opts.now,
    updatedAt: opts.now,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    version: 1,
    promptVersion: built.version,
    embedderId: opts.embedderId,
    provenance: { occurredAt: opts.now },
    derivedFrom: units.map(unit => unit.id),
    kind: 'abstraction',
    confidence: ABSTRACTION_CONFIDENCE,
  })
  for (const unit of units) {
    store.putEdge({ from: id, to: unit.id, weight: 1, kind: 'derivedFrom' })
  }
  return { created: id }
}
