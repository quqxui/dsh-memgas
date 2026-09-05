import type { LlmClient } from '../llm/client.ts'
import { parseStructured } from '../llm/structured.ts'
import { buildFilterPrompt } from '../prompts/filter-results.ts'
import type { RetrievedMemory } from './retriever.ts'

export interface FilterOutcome {
  items: RetrievedMemory[]
  /** False when the original list was kept because the filter could not be trusted. */
  applied: boolean
  reason?: string
}

function validateKeep(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) throw new Error('filter output must be an object')
  const keep = (value as Record<string, unknown>)['keep']
  if (!Array.isArray(keep)) throw new Error('filter output must have a keep array')
  return keep.filter((id): id is string => typeof id === 'string')
}

/**
 * Optional last pass that drops candidates the model judges irrelevant or
 * redundant. It can only remove, never add or reorder, and any doubt — bad
 * output, invented ids, too few survivors — returns the original list.
 */
export async function filterResults(
  llm: LlmClient,
  query: string,
  items: RetrievedMemory[],
  opts: { minKeep: number; signal?: AbortSignal; sessionId?: string },
): Promise<FilterOutcome> {
  if (items.length === 0) return { items, applied: false, reason: 'nothing to filter' }

  const built = buildFilterPrompt({
    query,
    cards: items.map(item => ({ id: item.unit.id, text: item.unit.content })),
  })

  let raw: string
  try {
    raw = await llm.complete({
      system: built.system,
      prompt: built.prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    })
  } catch (error) {
    return { items, applied: false, reason: error instanceof Error ? error.message : String(error) }
  }

  const parsed = parseStructured(raw, validateKeep)
  if (!parsed.ok) return { items, applied: false, reason: parsed.reason }

  const keep = new Set(parsed.value)
  const kept = items.filter(item => keep.has(item.unit.id))
  if (kept.length < opts.minKeep) return { items, applied: false, reason: 'filter kept too few' }
  return { items: kept, applied: true }
}
