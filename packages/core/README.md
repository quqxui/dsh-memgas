# memgas-core

The storage and retrieval engine behind [`dsh-memgas`](https://www.npmjs.com/package/dsh-memgas), with no dependency on any harness. Node 22.19+ / 24+, no native modules.

Retrieval builds on the multi-granularity association and adaptive selection method from the ICLR 2026 paper *From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents* (MemGAS).

```sh
npm i memgas-core
```

```ts
import { createMemoryService } from 'memgas-core'

const memory = createMemoryService({ path: './memories.sqlite', mode: 'hybrid' })

await memory.save({ content: '接口层统一用 zod 做参数校验', scope: 'project:acme/api', kind: 'convention' })

const result = await memory.search({ query: 'how do we validate input?', scopes: ['project:acme/api'], k: 8 })
for (const item of result.items) {
  console.log(item.unit.content, item.contributions) // which channel found it, at what rank
}
```

## What is in it

- **Store** — SQLite through Node's built-in `node:sqlite`, with FTS5 full-text, a vector sidecar and an association graph. FTS5 is probed at open time and falls back to an in-process inverted index when the host's SQLite lacks it. CJK is indexed as bigrams, so Chinese partial matching works.
- **Four retrieval channels** — lexical, dense, multi-granularity with an entropy router, and Personalized PageRank over the association graph. Fused by Reciprocal Rank Fusion with a reserved floor for the baseline channels, so enhancements can never evict what plain retrieval found.
- **Evolution** — association (two-component Gaussian mixture over the similarity distribution, percentile fallback when it is not separable), reconciliation, reinforcement, decay, abstraction, re-association.
- **Extraction** — versioned prompts with strict JSON validation; malformed model output is dropped, never stored.
- **Embedders** — a dependency-free lexical embedder, an optional local ONNX model through transformers.js, and an adaptive wrapper that serves the fallback until the model is ready and re-embeds afterwards.

Everything that touches a model goes through one small interface:

```ts
interface LlmClient {
  complete(input: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal }): Promise<string>
}
```

## Related packages

- [`dsh-memgas`](https://www.npmjs.com/package/dsh-memgas) — the DeepSeek Harness plugin
- [`memgas-mcp`](https://www.npmjs.com/package/memgas-mcp) — the same store over MCP

## License

MIT
