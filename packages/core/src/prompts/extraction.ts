export type FactKind = 'preference' | 'decision' | 'convention' | 'environment' | 'pitfall' | 'entity' | 'todo'

export const FACT_KINDS: readonly FactKind[] = [
  'preference', 'decision', 'convention', 'environment', 'pitfall', 'entity', 'todo',
]

export interface ExtractedFact {
  kind: FactKind
  content: string
  confidence: number
  statedBy: 'user' | 'assistant'
}

/** Shared output contract of the turn and session summarizers. */
export interface MemoryExtraction {
  summary: string
  facts: ExtractedFact[]
  keywords: string[]
}

export const MAX_KEYWORDS = 15
export const MAX_FACT_CHARS = 500
/** An assistant's inference is never as trustworthy as what the user said. */
export const ASSISTANT_CONFIDENCE_CAP = 0.7

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1, Math.max(0, number))
}

/**
 * Coerce model output into a MemoryExtraction, dropping individual bad facts
 * rather than rejecting the batch: one hallucinated kind should not throw away
 * four good decisions from the same turn.
 */
export function validateExtraction(value: unknown): MemoryExtraction {
  if (!isRecord(value)) throw new Error('extraction must be a JSON object')
  if (!Array.isArray(value['facts'])) throw new Error('extraction.facts must be an array')

  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : ''

  const facts: ExtractedFact[] = []
  for (const raw of value['facts']) {
    if (!isRecord(raw)) continue
    const kind = raw['kind']
    if (typeof kind !== 'string' || !(FACT_KINDS as readonly string[]).includes(kind)) continue
    const content = typeof raw['content'] === 'string' ? raw['content'].trim().slice(0, MAX_FACT_CHARS) : ''
    if (!content) continue
    const statedBy = raw['stated_by'] === 'assistant' ? 'assistant' : 'user'
    let confidence = clamp(raw['confidence'], 0.5)
    if (statedBy === 'assistant') confidence = Math.min(confidence, ASSISTANT_CONFIDENCE_CAP)
    facts.push({ kind: kind as FactKind, content, confidence, statedBy })
  }

  const keywords: string[] = []
  const rawKeywords = Array.isArray(value['keywords']) ? value['keywords'] : []
  for (const raw of rawKeywords) {
    if (typeof raw !== 'string') continue
    const keyword = raw.trim()
    if (!keyword || keywords.includes(keyword)) continue
    keywords.push(keyword)
    if (keywords.length >= MAX_KEYWORDS) break
  }

  return { summary, facts, keywords }
}
