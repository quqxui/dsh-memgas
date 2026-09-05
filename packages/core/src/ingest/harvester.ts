import { randomBytes } from 'node:crypto'
import type { Granularity, MemoryUnit, Provenance } from '../types.ts'
import type { MemoryStore } from '../store/store.ts'
import type { Embedder } from '../embedding/types.ts'
import type { LlmClient } from '../llm/client.ts'
import type { BackgroundQueue } from '../queue.ts'
import { redactSecrets } from '../secrets.ts'
import { parseStructured } from '../llm/structured.ts'
import { validateExtraction, type MemoryExtraction } from '../prompts/extraction.ts'
import { buildTurnPrompt } from '../prompts/summarize-turn.ts'
import { buildSessionPrompt } from '../prompts/summarize-session.ts'

/** Harness-neutral view of what happened in a session; the plugin maps dsh events onto it. */
export type HarvestEvent =
  | { type: 'user'; turn: number; text: string }
  | { type: 'assistant'; turn: number; text: string }
  | { type: 'tool-call'; turn: number; name: string }
  | { type: 'turn-end'; turn: number; completed: boolean }
  | { type: 'compaction-summary'; text: string; seqStart: number; seqEnd: number }

export interface HarvestStats {
  harvestedTurns: number
  skippedShort: number
  extractionFailures: number
  lastFailure: string | null
}

export interface HarvesterOptions {
  store: MemoryStore
  llm: LlmClient
  embedder: Embedder
  queue: BackgroundQueue
  scope: string
  minTurnChars?: number
  maxTranscriptChars?: number
  sessionSummaryEvery?: number
  /** Park model-derived facts as `pending` until the user accepts them. */
  confirmWrites?: boolean
  cwd?: string
  gitBranch?: string
  now?: () => number
  /** Called for every stored unit so the evolution processes can pick it up. */
  onUnitStored?: (id: string) => void
}

interface SessionState {
  turn: number
  lines: string[]
  turnSummaries: string[]
  completedTurns: number
}

const DEFAULTS = { minTurnChars: 80, maxTranscriptChars: 6000, sessionSummaryEvery: 8, confirmWrites: false }
const EXTRACTION_MAX_TOKENS = 1200

function newId(): string {
  return `m_${randomBytes(5).toString('hex')}`
}

/**
 * Watches session events and turns completed turns into memory units.
 *
 * Observation is synchronous and cheap; every model call and every store write
 * happens on the background queue, so a slow or failing extractor costs a
 * missed memory, never a slower turn. The raw turn is written before the model
 * is asked anything, which is why a failed extraction still leaves something
 * searchable behind.
 */
export class Harvester {
  private readonly sessions = new Map<string, SessionState>()
  private readonly stats_: HarvestStats = { harvestedTurns: 0, skippedShort: 0, extractionFailures: 0, lastFailure: null }
  private readonly opts: HarvesterOptions & typeof DEFAULTS & { now: () => number }

  constructor(options: HarvesterOptions) {
    this.opts = { ...DEFAULTS, now: () => Date.now(), ...options }
  }

  observe(sessionId: string, event: HarvestEvent): void {
    if (event.type === 'compaction-summary') {
      this.opts.queue.enqueue(`compaction:${sessionId}`, () => this.storeCompaction(sessionId, event))
      return
    }

    const state = this.stateFor(sessionId, event.turn)
    switch (event.type) {
      case 'user':
        state.lines.push(`user: ${event.text}`)
        return
      case 'assistant':
        state.lines.push(`assistant: ${event.text}`)
        return
      case 'tool-call':
        // The name tells the summarizer what happened; the output is noise at memory scale.
        state.lines.push(`[tool: ${event.name}]`)
        return
      case 'turn-end':
        this.finishTurn(sessionId, state, event)
        return
    }
  }

  idle(): Promise<void> {
    return this.opts.queue.idle()
  }

  stats(): HarvestStats {
    return { ...this.stats_ }
  }

  private stateFor(sessionId: string, turn: number): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { turn, lines: [], turnSummaries: [], completedTurns: 0 }
      this.sessions.set(sessionId, state)
    }
    if (state.turn !== turn) {
      state.turn = turn
      state.lines = []
    }
    return state
  }

  private finishTurn(sessionId: string, state: SessionState, event: { turn: number; completed: boolean }): void {
    const transcript = state.lines.join('\n')
    state.lines = []
    if (!event.completed) return
    if (transcript.length < this.opts.minTurnChars) {
      this.stats_.skippedShort += 1
      return
    }
    if (this.alreadyHarvested(sessionId, event.turn)) return

    const turn = event.turn
    this.opts.queue.enqueue(`harvest:${sessionId}:${turn}`, async signal => {
      const summary = await this.harvestTurn(sessionId, turn, transcript, signal)
      this.markHarvested(sessionId, turn)
      state.completedTurns += 1
      if (summary) state.turnSummaries.push(summary)
      if (state.completedTurns % this.opts.sessionSummaryEvery === 0 && state.turnSummaries.length > 0) {
        const summaries = state.turnSummaries.slice()
        this.opts.queue.enqueue(`session:${sessionId}:${turn}`, s => this.summarizeSession(sessionId, turn, summaries, s))
      }
    })
  }

  private cursorKey(sessionId: string): string {
    return `harvest:${sessionId}:turn`
  }

  private alreadyHarvested(sessionId: string, turn: number): boolean {
    const cursor = this.opts.store.getMeta(this.cursorKey(sessionId))
    return cursor !== null && Number(cursor) >= turn
  }

  private markHarvested(sessionId: string, turn: number): void {
    this.opts.store.setMeta(this.cursorKey(sessionId), String(turn))
  }

  private provenance(sessionId: string, extra: Partial<Provenance>): Provenance {
    return {
      occurredAt: this.opts.now(),
      sessionId,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.gitBranch ? { gitBranch: this.opts.gitBranch } : {}),
      ...extra,
    }
  }

  private unit(input: {
    granularity: Granularity
    content: string
    provenance: Provenance
    kind?: string | null
    confidence?: number | null
    importance?: number
    promptVersion?: string | null
    status?: MemoryUnit['status']
  }): MemoryUnit {
    const now = this.opts.now()
    return {
      id: newId(),
      scope: this.opts.scope,
      granularity: input.granularity,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      importance: input.importance ?? 0.5,
      accessCount: 0,
      lastAccessedAt: null,
      status: input.status ?? 'active',
      supersededBy: null,
      version: 1,
      promptVersion: input.promptVersion ?? null,
      embedderId: this.opts.embedder.id,
      provenance: input.provenance,
      derivedFrom: [],
      kind: input.kind ?? null,
      confidence: input.confidence ?? null,
    }
  }

  private async persist(units: MemoryUnit[]): Promise<void> {
    if (units.length === 0) return
    for (const unit of units) this.opts.store.put(unit)
    for (const unit of units) {
      // Only structured facts are worth reconciling; raw turns and keyword
      // lists have no counterpart to compare against.
      if (unit.granularity === 'summary' && unit.kind && unit.status === 'active') this.opts.onUnitStored?.(unit.id)
    }
    const vectors = await this.opts.embedder.embed(units.map(unit => unit.content))
    units.forEach((unit, index) => {
      const vector = vectors[index]
      if (vector) this.opts.store.putVector(unit.id, this.opts.embedder.id, vector)
    })
  }

  private async extract(
    built: { system: string; prompt: string },
    sessionId: string,
    signal: AbortSignal,
  ): Promise<MemoryExtraction | null> {
    let raw: string
    try {
      raw = await this.opts.llm.complete({ ...built, maxTokens: EXTRACTION_MAX_TOKENS, signal, sessionId })
    } catch (error) {
      this.recordFailure(`model call failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    const parsed = parseStructured(raw, validateExtraction)
    if (!parsed.ok) {
      this.recordFailure(parsed.reason)
      return null
    }
    return parsed.value
  }

  private recordFailure(reason: string): void {
    this.stats_.extractionFailures += 1
    this.stats_.lastFailure = reason
  }

  /** Returns the turn summary so the session summarizer can build on it. */
  private async harvestTurn(sessionId: string, turn: number, rawTranscript: string, signal: AbortSignal): Promise<string | null> {
    const transcript = redactSecrets(rawTranscript).text.slice(0, this.opts.maxTranscriptChars)
    const provenance = this.provenance(sessionId, { turn })
    await this.persist([this.unit({ granularity: 'turn', content: transcript, provenance, importance: 0.3 })])
    this.stats_.harvestedTurns += 1

    const built = buildTurnPrompt({
      transcript,
      occurredAt: provenance.occurredAt,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.gitBranch ? { gitBranch: this.opts.gitBranch } : {}),
    })
    const extraction = await this.extract(built, sessionId, signal)
    if (!extraction) return null

    // Under confirmWrites the model's conclusions wait for the user; the raw
    // turn above is already stored either way.
    const status = this.opts.confirmWrites ? ('pending' as const) : ('active' as const)
    const units: MemoryUnit[] = []
    if (extraction.summary) {
      units.push(this.unit({
        granularity: 'summary',
        content: extraction.summary,
        provenance,
        promptVersion: built.version,
        status,
      }))
    }
    for (const fact of extraction.facts) {
      units.push(this.unit({
        granularity: 'summary',
        content: fact.content,
        provenance,
        kind: fact.kind,
        confidence: fact.confidence,
        importance: fact.confidence,
        promptVersion: built.version,
        status,
      }))
    }
    if (extraction.keywords.length > 0) {
      units.push(this.unit({
        granularity: 'keyword',
        content: extraction.keywords.join(', '),
        provenance,
        promptVersion: built.version,
        status,
      }))
    }
    await this.persist(units)
    return extraction.summary || null
  }

  private async summarizeSession(sessionId: string, turn: number, turnSummaries: string[], signal: AbortSignal): Promise<void> {
    const provenance = this.provenance(sessionId, { turn })
    const built = buildSessionPrompt({ turnSummaries, occurredAt: provenance.occurredAt })
    const extraction = await this.extract(built, sessionId, signal)
    if (!extraction?.summary) return
    const units = [this.unit({ granularity: 'session', content: extraction.summary, provenance, importance: 0.6, promptVersion: built.version })]
    if (extraction.keywords.length > 0) {
      units.push(this.unit({ granularity: 'keyword', content: extraction.keywords.join(', '), provenance, promptVersion: built.version }))
    }
    await this.persist(units)
  }

  /** dsh already paid a model call for this summary; keep it as the session-level memory. */
  private async storeCompaction(sessionId: string, event: { text: string; seqStart: number; seqEnd: number }): Promise<void> {
    const content = redactSecrets(event.text).text.trim()
    if (!content) return
    await this.persist([this.unit({
      granularity: 'session',
      content,
      provenance: this.provenance(sessionId, { seqStart: event.seqStart, seqEnd: event.seqEnd }),
      kind: 'compaction',
      importance: 0.6,
    })])
  }
}
