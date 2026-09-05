import { normalize } from './vector.ts'
import type { Embedder } from './types.ts'

/** Short names accepted in configuration, mapped to their ONNX repositories. */
const KNOWN_MODELS: Record<string, string> = {
  'multilingual-e5-small': 'Xenova/multilingual-e5-small',
  'bge-small-zh': 'Xenova/bge-small-zh-v1.5',
  'bge-small-en': 'Xenova/bge-small-en-v1.5',
}

export function resolveModelId(name: string): string {
  return KNOWN_MODELS[name] ?? name
}

/**
 * Mean-pool token embeddings under the attention mask, then normalize.
 * Sentence embeddings for these models are defined this way; using the raw
 * first token instead would silently degrade every similarity we compute.
 */
export function meanPool(data: Float32Array, mask: number[], tokens: number, dims: number): Float32Array {
  const pooled = new Float32Array(dims)
  let counted = 0
  for (let token = 0; token < tokens; token += 1) {
    if (!mask[token]) continue
    counted += 1
    for (let dim = 0; dim < dims; dim += 1) {
      pooled[dim] = (pooled[dim] ?? 0) + (data[token * dims + dim] ?? 0)
    }
  }
  if (counted === 0) return pooled
  for (let dim = 0; dim < dims; dim += 1) pooled[dim] = (pooled[dim] ?? 0) / counted
  return normalize(pooled)
}

interface PipelineOutput {
  data: Float32Array
  dims: number[]
}

type FeaturePipeline = (texts: string[], options?: Record<string, unknown>) => Promise<PipelineOutput>

interface TransformersRuntime {
  pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<FeaturePipeline>
  env?: { cacheDir?: string; remoteHost?: string }
}

const BATCH = 16
/** Resolved at run time so the optional dependency is not required to build. */
const RUNTIME_PACKAGE = '@huggingface/transformers'

/**
 * Load a local sentence-embedding model through transformers.js.
 *
 * The runtime is deliberately not a dependency of this package, not even an
 * optional one: pnpm installs optional peers by default, which would drag
 * onnxruntime-node and sharp into every plugin install and trip the build-script
 * approval gate. Users who want local model embeddings install
 * `@huggingface/transformers` themselves; until then the import fails and the
 * lexical fallback keeps serving.
 */
export async function loadOnnxEmbedder(opts: {
  model: string
  cacheDir?: string
  /** Mirror host for environments where the default endpoint is unreachable. */
  mirror?: string
  importRuntime?: () => Promise<unknown>
}): Promise<Embedder> {
  const modelId = resolveModelId(opts.model)
  let runtime: TransformersRuntime
  try {
    const imported = opts.importRuntime
      ? await opts.importRuntime()
      : await import(/* @vite-ignore */ RUNTIME_PACKAGE)
    runtime = imported as TransformersRuntime
  } catch (error) {
    throw new Error(
      `@huggingface/transformers is not available (${error instanceof Error ? error.message : String(error)}); ` +
      'install it to enable local model embeddings',
    )
  }

  if (runtime.env) {
    if (opts.cacheDir) runtime.env.cacheDir = opts.cacheDir
    const mirror = opts.mirror ?? process.env['HF_ENDPOINT']
    if (mirror) runtime.env.remoteHost = mirror
  }

  const extract = await runtime.pipeline('feature-extraction', modelId)
  let dimensions = 0

  return {
    id: `onnx:${opts.model}`,
    get dimensions() {
      return dimensions
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vectors: Float32Array[] = []
      for (let start = 0; start < texts.length; start += BATCH) {
        const batch = texts.slice(start, start + BATCH)
        const output = await extract(batch, { pooling: 'mean', normalize: true })
        const [count = batch.length, tokens = 1, dims = 0] = output.dims
        // Some builds pool internally and return [batch, dims] instead.
        const perItem = output.dims.length === 2 ? (output.dims[1] ?? 0) : dims
        dimensions = perItem
        for (let index = 0; index < count; index += 1) {
          if (output.dims.length === 2) {
            const slice = output.data.slice(index * perItem, (index + 1) * perItem)
            vectors.push(normalize(Float32Array.from(slice)))
          } else {
            const slice = output.data.slice(index * tokens * dims, (index + 1) * tokens * dims)
            vectors.push(meanPool(Float32Array.from(slice), new Array(tokens).fill(1), tokens, dims))
          }
        }
      }
      return vectors
    },
  }
}
