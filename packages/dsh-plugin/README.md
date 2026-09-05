# dsh-memgas

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Your agent remembers this project's conventions, decisions and pitfalls across sessions, and keeps that memory organized as you work.

Retrieval builds on the multi-granularity association and adaptive selection method from the ICLR 2026 paper *From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents* (MemGAS).

## Install

```sh
dsh plugin --profile web add dsh-memgas
```

Restart dsh and it is active. The package ships its own bundle patch. Zero configuration by default: no API key, no model download, no extra process — summarization reuses the model already configured in dsh.

## What you get

- **Three tools for the model**: `memory_search`, `memory_save`, `memory_status`.
- **Automatic capture**: completed turns are distilled into summaries, facts and keywords in the background.
- **Proactive recall**: relevant memories are placed into context before the model request, so a fresh session already knows.
- **`/memory` command**: `status`, `search`, `diag`, `list`, `forget`, `restore`, `pin`, `review`, `export`, `purge --yes`.

## Retrieval

Four channels run in parallel and are fused by rank (Reciprocal Rank Fusion): lexical full-text, dense vectors, multi-granularity with an entropy router, and Personalized PageRank over an association graph seeded by the baseline hits.

At least half the final slots are reserved for the two baseline channels, so the enhancement channels can add and reorder but never evict — the worst case equals plain retrieval. Every channel degrades on its own: too few memories, a flat entropy distribution, a sparse graph, a timeout or an exception all reduce the result rather than failing it. A retrieval never affects the turn in progress.

`/memory diag <query>` shows which channel surfaced each memory, at what rank and score.

## Memory evolves

Six background processes keep the store in order: association, reconciliation (duplicates merged, superseded facts version-chained, contradictions kept as both sides), reinforcement, decay (archive, never delete), abstraction, and re-association. All run on a queue off the critical path; a failure in one affects neither the others nor the conversation.

## Configuration

Override by id in your profile's `cordis.patch.yml`:

```yaml
- id: memgas
  config:
    mode: hybrid             # lite | hybrid | memgas
    k: 8
    harvest: true
    recall: true
    evolve: true
    confirmWrites: false
    localModel: null         # { model: multilingual-e5-small } to enable local embeddings
```

## Storage

A local SQLite file per project scope under `$DSH_HOME/memgas/`, keyed by normalized git remote. Nothing is sent to any third-party service, and credential-shaped content is stripped before it is written.

## Related packages

- [`memgas-core`](https://www.npmjs.com/package/memgas-core) — storage, retrieval channels and evolution, with no dsh dependency
- [`memgas-mcp`](https://www.npmjs.com/package/memgas-mcp) — the same store over MCP, for Claude Code, Codex and other hosts

## License

MIT
