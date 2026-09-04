/** A source of vectors. Implementations must be deterministic for a given id. */
export interface Embedder {
  /** Recorded on every unit so vectors are never compared across models. */
  readonly id: string
  readonly dimensions: number
  embed(texts: string[]): Promise<Float32Array[]>
}
