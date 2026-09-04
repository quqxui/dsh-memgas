/** Cosine similarity that returns 0 instead of NaN for zero vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Scale a vector to unit length in place; all-zero vectors are left alone. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  if (sum === 0) return vector
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm
  return vector
}
