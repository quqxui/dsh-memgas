import type { MemoryStore } from '../store/store.ts'

const DEFAULT_STEP = 0.05
const DEFAULT_CO_INCREMENT = 0.1
const DEFAULT_CO_MAX = 1

/** Mark memories as used: read counts and importance both go up. */
export function reinforce(store: MemoryStore, ids: string[], opts: { at: number; step?: number }): void {
  if (ids.length === 0) return
  store.touch(ids, opts.at)
  const step = opts.step ?? DEFAULT_STEP
  for (const id of ids) {
    const unit = store.get(id)
    if (!unit) continue
    store.patch(id, { importance: Math.min(1, unit.importance + step) })
  }
}

/**
 * Strengthen the link between memories that keep being retrieved together.
 * These edges feed the graph channel, so repeated joint use makes the pair
 * easier to reach from either side next time.
 */
export function coRetrievalEdges(
  store: MemoryStore,
  ids: string[],
  opts: { increment?: number; max?: number } = {},
): void {
  if (ids.length < 2) return
  const increment = opts.increment ?? DEFAULT_CO_INCREMENT
  const max = opts.max ?? DEFAULT_CO_MAX
  const existing = new Map(
    store.edges(ids, { kinds: ['coRetrieval'] }).map(edge => [`${edge.from} ${edge.to}`, edge.weight]),
  )
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const pair = [ids[i]!, ids[j]!].sort()
      const from = pair[0]!
      const to = pair[1]!
      const weight = Math.min(max, (existing.get(`${from} ${to}`) ?? 0) + increment)
      store.putEdge({ from, to, weight, kind: 'coRetrieval' })
    }
  }
}
