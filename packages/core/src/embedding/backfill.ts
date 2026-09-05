import type { MemoryStore } from '../store/store.ts'
import type { Embedder } from './types.ts'

export interface BackfillOutcome {
  processed: number
}

const SCAN_LIMIT = 5000

/**
 * Re-embed memories written under a different embedder.
 *
 * Vectors are never compared across models, so after a switch the old ones are
 * dead weight until this runs. It rewrites in batches and leaves the old
 * vectors in place, which keeps retrieval working on the previous model's id
 * for as long as the backfill takes.
 */
export async function backfillVectors(
  store: MemoryStore,
  embedder: Embedder,
  opts: { scopes: string[]; batch: number },
): Promise<BackfillOutcome> {
  const stale = store
    .listUnits({ scopes: opts.scopes, limit: SCAN_LIMIT })
    .filter(unit => unit.embedderId !== embedder.id)
    .slice(0, opts.batch)
  if (stale.length === 0) return { processed: 0 }

  const vectors = await embedder.embed(stale.map(unit => unit.content))
  stale.forEach((unit, index) => {
    const vector = vectors[index]
    if (!vector) return
    store.putVector(unit.id, embedder.id, vector)
    store.patch(unit.id, { embedderId: embedder.id })
  })
  return { processed: stale.length }
}
