import type { MemoryStore } from '../store/store.ts'
import type { Embedder } from '../embedding/types.ts'
import { associate, type AssociateOptions } from '../graph/association.ts'

export interface ReassociateOutcome {
  processed: number
  linked: number
}

/**
 * Rebuild association edges for the most recent memories.
 *
 * Early memories were linked against a nearly empty store, so their edges
 * reflect a distribution that no longer exists. Re-running the clustering as
 * the store grows keeps the graph consistent with what is actually in it.
 */
export async function reassociate(
  store: MemoryStore,
  embedder: Embedder,
  opts: { scope: string; window: number; associate?: AssociateOptions },
): Promise<ReassociateOutcome> {
  const units = store.listUnits({ scopes: [opts.scope], statuses: ['active'], limit: opts.window })
  let linked = 0
  for (const unit of units) {
    const [vector] = await embedder.embed([unit.content])
    if (!vector) continue
    for (const edge of store.edges([unit.id], { kinds: ['association'] })) {
      if (edge.from === unit.id) store.deleteEdge(edge)
    }
    const outcome = associate(
      store,
      { unitId: unit.id, scope: opts.scope, embedderId: embedder.id, vector },
      opts.associate ?? {},
    )
    linked += outcome.linked
  }
  return { processed: units.length, linked }
}
