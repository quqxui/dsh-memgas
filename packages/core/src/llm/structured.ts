export type Structured<T> = { ok: true; value: T } | { ok: false; reason: string }

const FENCE = /^\s*```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/

/** The first balanced `{...}` or `[...]` in the text, ignoring braces inside strings. */
function extractJson(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const open = text[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open || (char === '{' || char === '[')) depth += 1
    else if (char === close || char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Turn model output into a validated value or a reason it was rejected.
 *
 * Models wrap JSON in fences and prose no matter how firmly the prompt forbids
 * it, so the parser digs the object out first. The validator throws to reject;
 * nothing here throws to the caller, because a bad extraction must cost one
 * skipped memory, not a failed turn.
 */
export function parseStructured<T>(raw: string, validate: (value: unknown) => T): Structured<T> {
  const unfenced = FENCE.exec(raw)?.[1] ?? raw
  const json = extractJson(unfenced)
  if (!json) return { ok: false, reason: 'no JSON object in model output' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  try {
    return { ok: true, value: validate(parsed) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
