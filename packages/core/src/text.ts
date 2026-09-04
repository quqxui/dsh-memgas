const TOKEN = /[a-z0-9_][a-z0-9_.\-/]*|[一-鿿]/g
const CJK = /[一-鿿]/

/** Words, identifiers and paths kept whole; CJK returned one character at a time. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? []
}

/**
 * Adjacent CJK characters as bigrams. Single CJK characters carry too little
 * signal to retrieve on, and SQLite's unicode61 tokenizer treats a whole CJK
 * run as one token, so both the index and the query are built from bigrams.
 */
export function cjkBigrams(tokens: string[]): string[] {
  const bigrams: string[] = []
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i]!
    const next = tokens[i + 1]!
    if (current.length === 1 && next.length === 1 && CJK.test(current) && CJK.test(next)) {
      bigrams.push(`${current}${next}`)
    }
  }
  return bigrams
}

/** Tokens that a latin-oriented full-text index can match on. */
export function latinTokens(tokens: string[]): string[] {
  return tokens.filter(token => !(token.length === 1 && CJK.test(token)))
}
