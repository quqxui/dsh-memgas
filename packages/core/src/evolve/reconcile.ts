import type { MemoryStore } from '../store/store.ts'
import type { LlmClient } from '../llm/client.ts'
import type { Embedder } from '../embedding/types.ts'
import type { MemoryUnit } from '../types.ts'
import { parseStructured } from '../llm/structured.ts'
import { buildReconcilePrompt } from '../prompts/reconcile-fact.ts'

export type FactRelation = 'duplicate' | 'update' | 'contradict' | 'unrelated'

export interface ReconcileOutcome {
  relation: FactRelation
  target: string | null
  /** True when the decision fell back to `unrelated` because the model could not be used. */
  degraded: boolean
  reason?: string
}

const RELATIONS: FactRelation[] = ['duplicate', 'update', 'contradict', 'unrelated']
const DEFAULT_CANDIDATES = 5
const MIN_SIMILARITY = 0.35
const DUPLICATE_BOOST = 0.05

function validateRelation(value: unknown): { relation: FactRelation; target: string | null } {
  if (typeof value !== 'object' || value === null) throw new Error('reconcile output must be an object')
  const record = value as Record<string, unknown>
  const relation = record['relation']
  if (typeof relation !== 'string' || !RELATIONS.includes(relation as FactRelation)) {
    throw new Error(`unknown relation: ${String(relation)}`)
  }
  const target = typeof record['target'] === 'string' ? record['target'] : null
  return { relation: relation as FactRelation, target }
}

/**
 * Decide what a newly extracted fact means for the ones already stored.
 *
 * `incoming` must already be in the store: the harvester writes first so a
 * failed reconciliation costs nothing.
 *
 * Everything here is reversible: an update supersedes the old unit and keeps
 * the version chain, a duplicate strengthens what is already there, a
 * contradiction keeps both sides and records the conflict for the model to
 * weigh. When the model cannot be reached or answers badly, the fact is simply
 * kept, because a redundant memory is cheap and a lost one is not.
 */
export async function reconcileFact(
  store: MemoryStore,
  llm: LlmClient,
  embedder: Embedder,
  incoming: MemoryUnit,
  opts: { signal?: AbortSignal; sessionId?: string; candidates?: number },
): Promise<ReconcileOutcome> {
  const [vector] = await embedder.embed([incoming.content])
  if (!vector) return { relation: 'unrelated', target: null, degraded: false }

  const neighbours = store
    .searchDense(vector, {
      embedderId: embedder.id,
      limit: (opts.candidates ?? DEFAULT_CANDIDATES) + 1,
      scopes: [incoming.scope],
      granularities: ['summary'],
    })
    .filter(candidate => candidate.id !== incoming.id && candidate.score >= MIN_SIMILARITY)

  if (neighbours.length === 0) return { relation: 'unrelated', target: null, degraded: false }

  const candidates = neighbours
    .map(candidate => {
      const unit = store.get(candidate.id)
      return unit ? { id: unit.id, text: unit.content } : null
    })
    .filter((candidate): candidate is { id: string; text: string } => candidate !== null)
  if (candidates.length === 0) return { relation: 'unrelated', target: null, degraded: false }

  const built = buildReconcilePrompt({ incoming: incoming.content, candidates })
  let raw: string
  try {
    raw = await llm.complete({
      system: built.system,
      prompt: built.prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    })
  } catch (error) {
    return {
      relation: 'unrelated',
      target: null,
      degraded: true,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const parsed = parseStructured(raw, validateRelation)
  if (!parsed.ok) return { relation: 'unrelated', target: null, degraded: true, reason: parsed.reason }

  const { relation, target } = parsed.value
  if (relation === 'unrelated' || !target) return { relation: 'unrelated', target: null, degraded: false }

  const existing = candidates.some(candidate => candidate.id === target) ? store.get(target) : null
  // A target the model invented is not a decision we can act on.
  if (!existing) return { relation: 'unrelated', target: null, degraded: true, reason: 'unknown target' }

  const now = Date.now()
  switch (relation) {
    case 'duplicate':
      store.patch(existing.id, {
        importance: Math.min(1, existing.importance + DUPLICATE_BOOST),
        updatedAt: now,
      })
      store.remove(incoming.id)
      return { relation, target, degraded: false }
    case 'update':
      store.patch(existing.id, { status: 'superseded', supersededBy: incoming.id, updatedAt: now })
      store.patch(incoming.id, { version: existing.version + 1, updatedAt: now })
      store.putEdge({ from: incoming.id, to: existing.id, weight: 1, kind: 'supersedes' })
      return { relation, target, degraded: false }
    case 'contradict':
      store.putEdge({ from: incoming.id, to: existing.id, weight: 1, kind: 'contradicts' })
      return { relation, target, degraded: false }
    default:
      return { relation: 'unrelated', target: null, degraded: false }
  }
}
