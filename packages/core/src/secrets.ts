export interface RedactionResult {
  text: string
  redactions: number
}

const PLACEHOLDER = '[redacted]'

/** Whole PEM-style blocks: the body is worthless to a memory and dangerous to keep. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** `api_key = "..."`, `token: ...` and friends. Only the value is dropped. */
const ASSIGNED_SECRET =
  /\b(api[-_]?keys?|apikey|secret[-_]?keys?|secret|access[-_]?keys?|auth[-_]?token|authorization|token|password|passwd|pwd)\b(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi

/** Vendor-shaped credentials that carry no key name next to them. */
const VENDOR_TOKENS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
]

/**
 * Strip credential-shaped content before anything reaches the memory store.
 *
 * Deliberately conservative about prose: an ordinary sentence mentioning a
 * password, or code assigning a timeout, must survive untouched, because
 * over-redaction silently destroys memories the user asked us to keep.
 */
export function redactSecrets(text: string): RedactionResult {
  let redactions = 0
  let out = text.replace(PRIVATE_KEY_BLOCK, () => {
    redactions += 1
    return '[redacted:private-key]'
  })

  out = out.replace(ASSIGNED_SECRET, (_match, key: string, sep: string, quote: string) => {
    redactions += 1
    return `${key}${sep}${quote}${PLACEHOLDER}${quote}`
  })

  for (const pattern of VENDOR_TOKENS) {
    out = out.replace(pattern, () => {
      redactions += 1
      return PLACEHOLDER
    })
  }

  return { text: out, redactions }
}
