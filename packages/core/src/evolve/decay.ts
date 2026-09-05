import type { MemoryStore } from '../store/store.ts'

export interface DecayOutcome {
  archived: number
  scanned: number
}

const DAY = 24 * 60 * 60 * 1000
/** Memories the user asked to keep are exempt from every automatic sweep. */
const PROTECTED_KINDS = new Set(['pinned'])
const SCAN_LIMIT = 5000

/**
 * Age out memories nobody comes back to.
 *
 * Importance halves every `halfLifeDays` since the memory was last touched;
 * anything below the floor, and anything past the per-scope cap, is archived.
 * Archiving is reversible and nothing is deleted: a forgotten memory is still
 * there when the user asks for it explicitly.
 */
export function decay(
  store: MemoryStore,
  opts: { scopes: string[]; now: number; halfLifeDays: number; archiveBelow: number; maxActive: number },
): DecayOutcome {
  const units = store.listUnits({ scopes: opts.scopes, statuses: ['active'], limit: SCAN_LIMIT })
  let archived = 0

  const survivors: { id: string; effective: number; protected: boolean }[] = []
  for (const unit of units) {
    const isProtected = PROTECTED_KINDS.has(unit.kind ?? '')
    const last = unit.lastAccessedAt ?? unit.updatedAt
    const ageDays = Math.max(0, (opts.now - last) / DAY)
    const effective = unit.importance * Math.pow(0.5, ageDays / opts.halfLifeDays)
    if (!isProtected && effective < opts.archiveBelow) {
      store.patch(unit.id, { status: 'archived', updatedAt: opts.now })
      archived += 1
      continue
    }
    survivors.push({ id: unit.id, effective, protected: isProtected })
  }

  const overflow = survivors.length - opts.maxActive
  if (overflow > 0) {
    const weakest = survivors
      .filter(survivor => !survivor.protected)
      .sort((a, b) => a.effective - b.effective)
      .slice(0, overflow)
    for (const unit of weakest) {
      store.patch(unit.id, { status: 'archived', updatedAt: opts.now })
      archived += 1
    }
  }

  return { archived, scanned: units.length }
}
