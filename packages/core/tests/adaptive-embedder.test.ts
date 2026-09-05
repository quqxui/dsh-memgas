import { describe, expect, test } from 'vitest'
import { AdaptiveEmbedder } from '../src/embedding/adaptive.ts'
import { LexicalEmbedder } from '../src/embedding/lexical.ts'
import { backfillVectors } from '../src/embedding/backfill.ts'
import { openStore } from '../src/store/store.ts'
import type { Embedder } from '../src/embedding/types.ts'
import type { MemoryUnit } from '../src/types.ts'

class FakeModel implements Embedder {
  readonly id = 'fake-model'
  readonly dimensions = 4
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text => Float32Array.from([text.length, 0, 0, 1]))
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

const unit = (id: string, content: string): MemoryUnit => ({
  id, content, scope: 'project:p', granularity: 'summary',
  createdAt: 1, updatedAt: 1, importance: 0.5, accessCount: 0, lastAccessedAt: null,
  status: 'active', supersededBy: null, version: 1, promptVersion: null, embedderId: 'lexical-v1',
  provenance: { occurredAt: 1 }, derivedFrom: [],
})

describe('AdaptiveEmbedder', () => {
  test('serves the fallback while the model is still loading', async () => {
    const embedder = new AdaptiveEmbedder({ fallback: new LexicalEmbedder(), load: async () => new FakeModel() })
    expect(embedder.id).toBe('lexical-v1')
    const [vector] = await embedder.embed(['zod'])
    expect(vector!.length).toBe(512)
  })

  test('switches to the model once it has loaded', async () => {
    let resolveModel!: (model: Embedder) => void
    const embedder = new AdaptiveEmbedder({
      fallback: new LexicalEmbedder(),
      load: () => new Promise<Embedder>(resolve => { resolveModel = resolve }),
    })
    embedder.start()
    resolveModel(new FakeModel())
    await tick()
    expect(embedder.id).toBe('fake-model')
    const [vector] = await embedder.embed(['zod'])
    expect(vector!.length).toBe(4)
  })

  test('keeps serving the fallback when loading fails', async () => {
    const embedder = new AdaptiveEmbedder({
      fallback: new LexicalEmbedder(),
      load: async () => { throw new Error('network unreachable') },
    })
    embedder.start()
    await tick()
    expect(embedder.id).toBe('lexical-v1')
    expect(embedder.status().state).toBe('failed')
    expect(embedder.status().reason).toContain('network unreachable')
    expect((await embedder.embed(['zod']))[0]!.length).toBe(512)
  })

  test('only starts loading once no matter how often it is asked', async () => {
    let calls = 0
    const embedder = new AdaptiveEmbedder({
      fallback: new LexicalEmbedder(),
      load: async () => { calls += 1; return new FakeModel() },
    })
    embedder.start()
    embedder.start()
    await tick()
    embedder.start()
    expect(calls).toBe(1)
  })

  test('announces the switch so callers can re-index', async () => {
    const seen: string[] = []
    const embedder = new AdaptiveEmbedder({
      fallback: new LexicalEmbedder(),
      load: async () => new FakeModel(),
      onReady: id => seen.push(id),
    })
    embedder.start()
    await tick()
    expect(seen).toEqual(['fake-model'])
  })

  test('reports which embedder is in use for the status panel', async () => {
    const embedder = new AdaptiveEmbedder({ fallback: new LexicalEmbedder(), load: async () => new FakeModel() })
    expect(embedder.status()).toMatchObject({ state: 'idle', active: 'lexical-v1' })
    embedder.start()
    await tick()
    expect(embedder.status()).toMatchObject({ state: 'ready', active: 'fake-model' })
  })
})

describe('backfillVectors', () => {
  test('re-embeds units that predate the current embedder', async () => {
    const store = openStore({ path: ':memory:' })
    const lexical = new LexicalEmbedder()
    for (const id of ['a', 'b']) {
      store.put(unit(id, `记忆 ${id}`))
      const [vector] = await lexical.embed([`记忆 ${id}`])
      store.putVector(id, lexical.id, vector!)
    }

    const model = new FakeModel()
    const outcome = await backfillVectors(store, model, { scopes: ['project:p'], batch: 10 })
    expect(outcome.processed).toBe(2)
    expect(store.searchDense(Float32Array.from([5, 0, 0, 1]), { embedderId: 'fake-model', limit: 5 })).toHaveLength(2)
    expect(store.get('a')!.embedderId).toBe('fake-model')
  })

  test('does nothing when everything is already current', async () => {
    const store = openStore({ path: ':memory:' })
    const model = new FakeModel()
    const u = { ...unit('a', 'x'), embedderId: model.id }
    store.put(u)
    store.putVector('a', model.id, (await model.embed(['x']))[0]!)
    expect((await backfillVectors(store, model, { scopes: ['project:p'], batch: 10 })).processed).toBe(0)
  })
})
