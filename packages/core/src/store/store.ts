import { DatabaseSync } from 'node:sqlite'
import type { Granularity, MemoryUnit, UnitStatus } from '../types.ts'
import type { Candidate } from '../retrieval/fusion.ts'
import { cjkBigrams, latinTokens, tokenize } from '../text.ts'
import { cosine } from '../embedding/vector.ts'

export interface StoreCapabilities {
  /** `memory` means SQLite was built without FTS5 and a JS index took over. */
  lexicalIndex: 'fts5' | 'memory'
}

export interface SearchOptions {
  limit: number
  scopes?: string[]
  granularities?: Granularity[]
}

export interface Edge {
  from: string
  to: string
  weight: number
  kind: string
}

export interface EdgeStats {
  count: number
  avgDegree: number
  maxDegree: number
}

export interface UnitQuery {
  scopes: string[]
  limit: number
  statuses?: UnitStatus[]
  granularities?: Granularity[]
  kinds?: string[]
}

export type UnitPatch = Partial<Pick<MemoryUnit, 'status' | 'supersededBy' | 'importance' | 'version' | 'updatedAt' | 'content' | 'confidence' | 'embedderId'>>

export interface ListOptions {
  scopes: string[]
  limit: number
  kinds?: string[]
}

export interface MemoryStore {
  readonly capabilities: StoreCapabilities
  put(unit: MemoryUnit): void
  get(id: string): MemoryUnit | null
  countUnits(): number
  /** Active units of the given scopes, most important first. */
  listActive(opts: ListOptions): MemoryUnit[]
  /** Units matching the query, most important first. */
  listUnits(query: UnitQuery): MemoryUnit[]
  /** Change mutable bookkeeping fields without rewriting the unit. */
  patch(id: string, fields: UnitPatch): void
  /** Physically remove one unit with its vectors and edges. */
  remove(id: string): void
  /** Mark a unit as user-pinned so automatic sweeps leave it alone. */
  pin(id: string): void
  /** Physically delete every unit, vector and edge of one scope. */
  purgeScope(scope: string): void
  putEdge(edge: Edge): void
  deleteEdge(edge: Pick<Edge, 'from' | 'to' | 'kind'>): void
  /** Every edge touching any of the ids, from either side. */
  edges(ids: string[], opts?: { kinds?: string[] }): Edge[]
  edgeStats(kind: string): EdgeStats
  /** Record that these units were read; ids that no longer exist are ignored. */
  touch(ids: string[], at: number): void
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  /** Every scope that has at least one unit. */
  scopes(): string[]
  putVector(id: string, embedderId: string, vector: Float32Array): void
  searchLexical(query: string, opts: SearchOptions): Candidate[]
  searchDense(vector: Float32Array, opts: SearchOptions & { embedderId: string }): Candidate[]
  close(): void
}

interface UnitRow {
  id: string
  scope: string
  granularity: string
  content: string
  created_at: number
  updated_at: number
  importance: number
  access_count: number
  last_accessed_at: number | null
  status: string
  superseded_by: string | null
  version: number
  prompt_version: string | null
  embedder_id: string | null
  provenance: string
  derived_from: string
  kind: string | null
  confidence: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  granularity TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  importance REAL NOT NULL,
  access_count INTEGER NOT NULL,
  last_accessed_at INTEGER,
  status TEXT NOT NULL,
  superseded_by TEXT,
  version INTEGER NOT NULL,
  prompt_version TEXT,
  embedder_id TEXT,
  provenance TEXT NOT NULL,
  derived_from TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS units_scope_status ON units (scope, status);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id);
CREATE TABLE IF NOT EXISTS vectors (
  id TEXT NOT NULL,
  embedder_id TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (id, embedder_id)
);
`

function rowToUnit(row: UnitRow): MemoryUnit {
  return {
    id: row.id,
    scope: row.scope,
    granularity: row.granularity as MemoryUnit['granularity'],
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    status: row.status as MemoryUnit['status'],
    supersededBy: row.superseded_by,
    version: row.version,
    promptVersion: row.prompt_version,
    embedderId: row.embedder_id,
    provenance: JSON.parse(row.provenance),
    derivedFrom: JSON.parse(row.derived_from),
    kind: row.kind,
    confidence: row.confidence,
  }
}

/** Columns added after the first schema; applied to stores created before them. */
const MIGRATIONS: { column: string; ddl: string }[] = [
  { column: 'kind', ddl: 'ALTER TABLE units ADD COLUMN kind TEXT' },
  { column: 'confidence', ddl: 'ALTER TABLE units ADD COLUMN confidence REAL' },
]

/** FTS5 treats bare punctuation and operators as syntax, so every token is quoted. */
function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

class SqliteMemoryStore implements MemoryStore {
  readonly capabilities: StoreCapabilities
  private readonly db: DatabaseSync
  /** Used only when FTS5 is missing: token -> unit ids. */
  private readonly fallbackIndex = new Map<string, Set<string>>()

  constructor(opts: { path: string; forceLexicalFallback?: boolean }) {
    this.db = new DatabaseSync(opts.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
    this.capabilities = { lexicalIndex: opts.forceLexicalFallback ? 'memory' : this.tryCreateFts() }
    if (this.capabilities.lexicalIndex === 'memory') this.rebuildFallbackIndex()
  }

  private migrate(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(units)').all() as { name: string }[]).map(column => column.name),
    )
    for (const migration of MIGRATIONS) {
      if (!existing.has(migration.column)) this.db.exec(migration.ddl)
    }
  }

  private tryCreateFts(): 'fts5' | 'memory' {
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
          id UNINDEXED, content, cjk, tokenize = 'unicode61'
        )`,
      )
      return 'fts5'
    } catch {
      return 'memory'
    }
  }

  private rebuildFallbackIndex(): void {
    this.fallbackIndex.clear()
    const rows = this.db.prepare('SELECT id, content FROM units').all() as { id: string; content: string }[]
    for (const row of rows) this.indexInMemory(row.id, row.content)
  }

  private indexInMemory(id: string, content: string): void {
    for (const token of this.indexTerms(content)) {
      const bucket = this.fallbackIndex.get(token) ?? new Set<string>()
      bucket.add(id)
      this.fallbackIndex.set(token, bucket)
    }
  }

  private indexTerms(text: string): string[] {
    const tokens = tokenize(text)
    return [...latinTokens(tokens), ...cjkBigrams(tokens)]
  }

  put(unit: MemoryUnit): void {
    this.db
      .prepare(
        `INSERT INTO units (id, scope, granularity, content, created_at, updated_at, importance,
           access_count, last_accessed_at, status, superseded_by, version, prompt_version,
           embedder_id, provenance, derived_from, kind, confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           scope=excluded.scope, granularity=excluded.granularity, content=excluded.content,
           updated_at=excluded.updated_at, importance=excluded.importance,
           access_count=excluded.access_count, last_accessed_at=excluded.last_accessed_at,
           status=excluded.status, superseded_by=excluded.superseded_by, version=excluded.version,
           prompt_version=excluded.prompt_version, embedder_id=excluded.embedder_id,
           provenance=excluded.provenance, derived_from=excluded.derived_from,
           kind=excluded.kind, confidence=excluded.confidence`,
      )
      .run(
        unit.id, unit.scope, unit.granularity, unit.content, unit.createdAt, unit.updatedAt,
        unit.importance, unit.accessCount, unit.lastAccessedAt, unit.status, unit.supersededBy,
        unit.version, unit.promptVersion, unit.embedderId, JSON.stringify(unit.provenance),
        JSON.stringify(unit.derivedFrom), unit.kind ?? null, unit.confidence ?? null,
      )

    this.index(unit)
  }

  private index(unit: MemoryUnit): void {
    if (this.capabilities.lexicalIndex === 'fts5') {
      this.db.prepare('DELETE FROM units_fts WHERE id = ?').run(unit.id)
      const tokens = tokenize(unit.content)
      this.db
        .prepare('INSERT INTO units_fts (id, content, cjk) VALUES (?,?,?)')
        .run(unit.id, unit.content, cjkBigrams(tokens).join(' '))
    } else {
      for (const bucket of this.fallbackIndex.values()) bucket.delete(unit.id)
      this.indexInMemory(unit.id, unit.content)
    }
  }

  get(id: string): MemoryUnit | null {
    const row = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id) as UnitRow | undefined
    return row ? rowToUnit(row) : null
  }

  countUnits(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM units').get() as { n: number }
    return row.n
  }

  listActive(opts: ListOptions): MemoryUnit[] {
    return this.listUnits({ ...opts, statuses: ['active'] })
  }

  listUnits(query: UnitQuery): MemoryUnit[] {
    if (query.scopes.length === 0) return []
    const clauses: string[] = [`scope IN (${query.scopes.map(() => '?').join(',')})`]
    const params: unknown[] = [...query.scopes]
    const addIn = (column: string, values: string[] | undefined) => {
      if (!values?.length) return
      clauses.push(`${column} IN (${values.map(() => '?').join(',')})`)
      params.push(...values)
    }
    addIn('status', query.statuses)
    addIn('granularity', query.granularities)
    addIn('kind', query.kinds)
    const rows = this.db
      .prepare(`SELECT * FROM units WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...(params as never[]), query.limit) as unknown as UnitRow[]
    return rows.map(rowToUnit)
  }

  patch(id: string, fields: UnitPatch): void {
    const columns: Record<keyof UnitPatch, string> = {
      status: 'status',
      supersededBy: 'superseded_by',
      importance: 'importance',
      version: 'version',
      updatedAt: 'updated_at',
      content: 'content',
      confidence: 'confidence',
      embedderId: 'embedder_id',
    }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, value] of Object.entries(fields) as [keyof UnitPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${columns[key]} = ?`)
      params.push(value)
    }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE units SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]), id)
    if (fields.content !== undefined) {
      const unit = this.get(id)
      if (unit) this.index(unit)
    }
  }

  pin(id: string): void {
    this.db.prepare("UPDATE units SET kind = 'pinned' WHERE id = ?").run(id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id)
    this.db.prepare('DELETE FROM vectors WHERE id = ?').run(id)
    if (this.capabilities.lexicalIndex === 'fts5') {
      this.db.prepare('DELETE FROM units_fts WHERE id = ?').run(id)
    } else {
      for (const bucket of this.fallbackIndex.values()) bucket.delete(id)
    }
    this.db.prepare('DELETE FROM units WHERE id = ?').run(id)
  }

  purgeScope(scope: string): void {
    const ids = (this.db.prepare('SELECT id FROM units WHERE scope = ?').all(scope) as { id: string }[]).map(row => row.id)
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM edges WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`).run(...ids, ...ids)
    this.db.prepare(`DELETE FROM vectors WHERE id IN (${placeholders})`).run(...ids)
    if (this.capabilities.lexicalIndex === 'fts5') {
      this.db.prepare(`DELETE FROM units_fts WHERE id IN (${placeholders})`).run(...ids)
    } else {
      for (const bucket of this.fallbackIndex.values()) for (const id of ids) bucket.delete(id)
    }
    this.db.prepare(`DELETE FROM units WHERE id IN (${placeholders})`).run(...ids)
  }

  putEdge(edge: Edge): void {
    this.db
      .prepare(
        `INSERT INTO edges (from_id, to_id, kind, weight) VALUES (?,?,?,?)
         ON CONFLICT(from_id, to_id, kind) DO UPDATE SET weight = excluded.weight`,
      )
      .run(edge.from, edge.to, edge.kind, edge.weight)
  }

  deleteEdge(edge: Pick<Edge, 'from' | 'to' | 'kind'>): void {
    this.db.prepare('DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?').run(edge.from, edge.to, edge.kind)
  }

  edges(ids: string[], opts: { kinds?: string[] } = {}): Edge[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const kindClause = opts.kinds?.length ? ` AND kind IN (${opts.kinds.map(() => '?').join(',')})` : ''
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, kind, weight FROM edges
         WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))${kindClause}`,
      )
      .all(...ids, ...ids, ...(opts.kinds ?? [])) as { from_id: string; to_id: string; kind: string; weight: number }[]
    return rows.map(row => ({ from: row.from_id, to: row.to_id, kind: row.kind, weight: row.weight }))
  }

  edgeStats(kind: string): EdgeStats {
    const rows = this.db
      .prepare(
        `SELECT node, COUNT(*) AS degree FROM (
           SELECT from_id AS node FROM edges WHERE kind = ?
           UNION ALL
           SELECT to_id AS node FROM edges WHERE kind = ?
         ) GROUP BY node`,
      )
      .all(kind, kind) as { node: string; degree: number }[]
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM edges WHERE kind = ?').get(kind) as { n: number }).n
    const maxDegree = rows.reduce((max, row) => Math.max(max, row.degree), 0)
    const avgDegree = rows.length ? rows.reduce((sum, row) => sum + row.degree, 0) / rows.length : 0
    return { count, avgDegree, maxDegree }
  }

  touch(ids: string[], at: number): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE units SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`)
      .run(at, ...ids)
  }

  scopes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT scope FROM units').all() as { scope: string }[]
    return rows.map(row => row.scope)
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  putVector(id: string, embedderId: string, vector: Float32Array): void {
    const blob = new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
    this.db
      .prepare(
        `INSERT INTO vectors (id, embedder_id, data) VALUES (?,?,?)
         ON CONFLICT(id, embedder_id) DO UPDATE SET data = excluded.data`,
      )
      .run(id, embedderId, blob)
  }

  private searchable(ids: string[], scopes?: string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const placeholders = ids.map(() => '?').join(',')
    const scopeClause = scopes?.length ? ` AND scope IN (${scopes.map(() => '?').join(',')})` : ''
    const rows = this.db
      .prepare(`SELECT id FROM units WHERE id IN (${placeholders}) AND status = 'active'${scopeClause}`)
      .all(...ids, ...(scopes ?? [])) as { id: string }[]
    return new Set(rows.map(row => row.id))
  }

  searchLexical(query: string, opts: SearchOptions): Candidate[] {
    const tokens = tokenize(query)
    const terms = [...latinTokens(tokens), ...cjkBigrams(tokens)]
    if (terms.length === 0) return []
    return this.capabilities.lexicalIndex === 'fts5'
      ? this.searchFts(terms, opts)
      : this.searchFallback(terms, opts)
  }

  private searchFts(terms: string[], opts: SearchOptions): Candidate[] {
    const match = terms.map(quote).join(' OR ')
    let rows: { id: string; score: number }[]
    try {
      rows = this.db
        .prepare(
          `SELECT id, -bm25(units_fts, 1.0, 1.0) AS score FROM units_fts
           WHERE units_fts MATCH ? ORDER BY score DESC LIMIT ?`,
        )
        .all(match, opts.limit * 4) as { id: string; score: number }[]
    } catch {
      return this.searchFallback(terms, opts)
    }
    const allowed = this.searchable(rows.map(row => row.id), opts.scopes)
    return rows.filter(row => allowed.has(row.id)).slice(0, opts.limit)
  }

  private searchFallback(terms: string[], opts: SearchOptions): Candidate[] {
    const total = Math.max(this.countUnits(), 1)
    const scores = new Map<string, number>()
    for (const term of terms) {
      const bucket = this.fallbackIndex.get(term)
      if (!bucket || bucket.size === 0) continue
      const idf = Math.log(1 + total / bucket.size)
      for (const id of bucket) scores.set(id, (scores.get(id) ?? 0) + idf)
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
    const allowed = this.searchable(ranked.map(([id]) => id), opts.scopes)
    return ranked
      .filter(([id]) => allowed.has(id))
      .slice(0, opts.limit)
      .map(([id, score]) => ({ id, score }))
  }

  searchDense(vector: Float32Array, opts: SearchOptions & { embedderId: string }): Candidate[] {
    const scopeClause = opts.scopes?.length ? ` AND u.scope IN (${opts.scopes.map(() => '?').join(',')})` : ''
    const granClause = opts.granularities?.length
      ? ` AND u.granularity IN (${opts.granularities.map(() => '?').join(',')})`
      : ''
    const rows = this.db
      .prepare(
        `SELECT v.id AS id, v.data AS data FROM vectors v
         JOIN units u ON u.id = v.id
         WHERE v.embedder_id = ? AND u.status = 'active'${scopeClause}${granClause}`,
      )
      .all(opts.embedderId, ...(opts.scopes ?? []), ...(opts.granularities ?? [])) as { id: string; data: Uint8Array }[]

    return rows
      .map(row => ({
        id: row.id,
        score: cosine(vector, new Float32Array(new Uint8Array(row.data).buffer)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
  }

  close(): void {
    this.db.close()
  }
}

export function openStore(opts: { path: string; forceLexicalFallback?: boolean }): MemoryStore {
  return new SqliteMemoryStore(opts)
}
