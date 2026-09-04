import { normalize } from './vector.ts'
import type { Embedder } from './types.ts'
import { cjkBigrams, tokenize } from '../text.ts'

function hash(feature: string, dimensions: number): number {
  let value = 0x811c9dc5
  for (let i = 0; i < feature.length; i += 1) {
    value ^= feature.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value % dimensions
}

/**
 * Dependency-free embedder used before the ONNX model finishes downloading and
 * whenever it is unavailable. Hashed lexical features, so a paraphrase sharing
 * vocabulary scores above an unrelated sentence, but no semantic generalization.
 */
export class LexicalEmbedder implements Embedder {
  readonly id = 'lexical-v1'
  readonly dimensions = 512

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text => {
      const tokens = tokenize(text)
      const features = [...tokens, ...cjkBigrams(tokens)]
      const vector = new Float32Array(this.dimensions)
      const counts = new Map<string, number>()
      for (const feature of features) counts.set(feature, (counts.get(feature) ?? 0) + 1)
      for (const [feature, count] of counts) {
        const slot = hash(feature, this.dimensions)
        vector[slot] = (vector[slot] ?? 0) + 1 + Math.log(count)
      }
      return normalize(vector)
    })
  }
}
