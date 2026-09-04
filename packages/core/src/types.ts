export type Granularity = 'session' | 'turn' | 'summary' | 'keyword'
export type UnitStatus = 'active' | 'superseded' | 'archived'

export interface Provenance {
  occurredAt: number
  sessionId?: string
  seqStart?: number
  seqEnd?: number
  cwd?: string
  gitBranch?: string
}

export interface MemoryUnit {
  id: string
  scope: string
  granularity: Granularity
  content: string
  createdAt: number
  updatedAt: number
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  status: UnitStatus
  supersededBy: string | null
  version: number
  promptVersion: string | null
  embedderId: string | null
  provenance: Provenance
  derivedFrom: string[]
}
