import { describe, expect, test } from 'vitest'
import { loadOnnxEmbedder, meanPool, resolveModelId } from '../src/embedding/onnx.ts'

describe('resolveModelId', () => {
  test('maps the short names in the config to full model ids', () => {
    expect(resolveModelId('multilingual-e5-small')).toBe('Xenova/multilingual-e5-small')
    expect(resolveModelId('bge-small-zh')).toContain('bge-small-zh')
  })

  test('passes an explicit repo id through untouched', () => {
    expect(resolveModelId('Someone/custom-model')).toBe('Someone/custom-model')
  })
})

describe('meanPool', () => {
  test('averages token vectors over the attention mask and normalizes', () => {
    // Two tokens, two dims; the second token is masked out.
    const pooled = meanPool(Float32Array.from([3, 0, 99, 99]), [1, 0], 2, 2)
    expect(pooled[0]).toBeCloseTo(1)
    expect(pooled[1]).toBeCloseTo(0)
  })

  test('does not divide by zero when nothing is unmasked', () => {
    const pooled = meanPool(Float32Array.from([1, 1]), [0], 1, 2)
    expect(Array.from(pooled).some(Number.isNaN)).toBe(false)
  })
})

describe('loadOnnxEmbedder', () => {
  test('rejects with a clear reason when the optional runtime is absent', async () => {
    await expect(
      loadOnnxEmbedder({ model: 'multilingual-e5-small', importRuntime: async () => { throw new Error('Cannot find package') } }),
    ).rejects.toThrow(/transformers/)
  })

  test('produces unit-length vectors through the injected runtime', async () => {
    const embedder = await loadOnnxEmbedder({
      model: 'multilingual-e5-small',
      importRuntime: async () => ({
        // Minimal stand-in for the feature-extraction pipeline.
        pipeline: async () => async (texts: string[]) => ({
          data: Float32Array.from(texts.flatMap(() => [3, 4])),
          dims: [texts.length, 1, 2],
        }),
      }),
    })
    const [vector] = await embedder.embed(['zod'])
    expect(vector!.length).toBe(2)
    expect(Math.hypot(...Array.from(vector!))).toBeCloseTo(1)
    expect(embedder.id).toContain('multilingual-e5-small')
  })
})
