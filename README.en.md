# dsh-memgas

[![npm](https://img.shields.io/npm/v/dsh-memgas?label=dsh-memgas)](https://www.npmjs.com/package/dsh-memgas)
[![npm](https://img.shields.io/npm/v/memgas-core?label=memgas-core)](https://www.npmjs.com/package/memgas-core)
[![CI](https://github.com/quqxui/dsh-memgas/actions/workflows/ci.yml/badge.svg)](https://github.com/quqxui/dsh-memgas/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-memgas)](./LICENSE)

[中文](./README.md) | English

**Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** Your agent remembers this project's conventions, decisions and pitfalls across sessions, and keeps that memory organized as you work.

Retrieval builds on the multi-granularity association and adaptive selection method from the ICLR 2026 paper *[From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents](https://github.com/Applied-Machine-Learning-Lab/ICLR2026_MemGAS)* (MemGAS).

## Install

```sh
dsh plugin --profile web add dsh-memgas
```

Restart dsh and it is active. The package ships its own bundle patch, so there is nothing to wire up by hand. Zero configuration by default: no API key, no model download, no extra process.

## What it does

Open a fresh session and the agent already knows. Verbatim output from two separate dsh processes (0.1.2-rc.1), translated from the Chinese original:

```text
$ dsh --profile headless "Use memory_save to remember: this project deploys on port 8080,
                          and dependencies are managed with pnpm."

Saved to memory:
1. **Environment**: the project's deployment port is 8080.
2. **Convention**: dependencies are managed with pnpm (not npm/yarn).

# ——— process exits; a brand new session, no shared context ———

$ dsh --profile headless "What port does this project deploy on? What manages dependencies?
                          Answer directly."

From long-term memory:
- **Deployment port**: 8080
- **Dependency management**: pnpm
```

The second session called no tools and was never told to consult memory. The relevant entries were in its context before the model request went out.

This example asks for the save explicitly. In practice you do not have to: after each turn the plugin distils what is worth keeping into facts, summaries and keywords in the background.

## Retrieval

Most memory plugins retrieve through one channel: vector similarity, or full-text match. dsh-memgas runs four in parallel and fuses them by rank:

| Channel | What it is | Good at | Can be disabled |
|---|---|---|---|
| Lexical | SQLite FTS5, identifiers kept intact | Paths, package names, error codes, exact wording | No |
| Dense | Vector similarity | The same question asked differently | No |
| Granularity | Session / turn / summary / keyword retrieved separately, weighted by an entropy router | Deciding whether a whole session or one turn is the right unit | Yes |
| Graph | Personalized PageRank over the association graph, seeded by the baseline hits | Multi-hop links across sessions | Yes |

Fusion is Reciprocal Rank Fusion: rank-based, never score-based. Channel scores are not comparable (BM25 against cosine against PageRank mass), so a channel whose scores are miscalibrated can still only contribute through its ordering.

**Baseline floor.** At least half the final slots are reserved for the lexical and dense channels. The enhancement channels can add and reorder, never evict. The worst case equals plain retrieval.

**Automatic degradation.** Too few memories and only the baseline runs. An entropy router with no signal falls back to uniform weights. A graph too sparse to mean anything is skipped; a hub node gets its edges trimmed rather than the whole channel switched off. A channel that throws or overruns its budget is dropped and the rest still fuse. The whole path has a latency budget. A failed retrieval never affects the turn in progress.

`/memory diag <query>` prints every channel's raw results and the fusion that produced the final ranking, so each memory can be traced to the channel, rank and score that surfaced it.

## Memory evolves

Memory is not a write-only log. Six background processes keep it in order, all on a queue, none on the critical path of a turn:

- **Associate** — a new memory is clustered against the similarity distribution of existing ones and linked to those that genuinely relate
- **Reconcile** — duplicates merge, superseded facts get a version chain, contradictions are kept as both sides with the conflict recorded
- **Reinforce** — memories that were retrieved and actually used gain weight; memories repeatedly retrieved together become linked
- **Decay** — untouched memories are archived (archived, never deleted, always restorable)
- **Abstract** — once a cluster grows large enough it is summarized into a higher-level convention, sources left intact
- **Re-associate** — the graph is refreshed as the store grows so it reflects the current distribution

A failure in any one process affects neither the others nor the conversation.

## Tools and commands

Three tools for the model: `memory_search`, `memory_save`, `memory_status`.

`/memory` for you:

```text
/memory status              store size, embedder, index and channel state
/memory search <query>      retrieve and list memory cards
/memory diag <query>        show each channel's results and the fusion
/memory list [n]            list this project's memories by importance
/memory forget <id>         archive one memory (reversible)
/memory restore <id>        bring an archived memory back
/memory pin <id>            exempt a memory from automatic decay
/memory review              handle memories waiting for confirmation
/memory export              export this project's memories as JSON
/memory purge --yes         permanently delete this project's memories
```

## Configuration

Override by id in your profile's `cordis.patch.yml`. Every field is optional:

```yaml
- id: memgas
  config:
    mode: hybrid             # lite (baseline only) | hybrid | memgas (heavier enhancements)
    k: 8                     # memories returned per search
    harvest: true            # distil memories from the conversation automatically
    recall: true             # inject relevant memories before a step
    evolve: true             # run the background maintenance
    confirmWrites: false     # true queues harvested memories for /memory review
    localModel: null         # see "Embeddings" below
```

The full field list is in the [design document](./docs/design.md#配置草案) (Chinese).

## Privacy and storage

The store is a local SQLite file per project scope under `$DSH_HOME/memgas/`, so a single project's memories can be exported or deleted on their own. Scope is derived from the normalized git remote, so a repository cloned on another machine maps to the same memories.

**Nothing leaves your machine.** Summarization and maintenance reuse the model you already configured in dsh: no extra API key, no third-party service. Credential-shaped content is stripped before anything is written.

## Embeddings

The default embedder needs no download and works immediately. For semantic generalization, enable a local model:

```sh
pnpm add @huggingface/transformers
```

```yaml
- id: memgas
  config:
    localModel:
      model: multilingual-e5-small
      mirror: https://hf-mirror.com   # optional
```

It loads in the background; the lexical embedder serves until it is ready and keeps serving if the load fails. Existing memories are re-embedded once it is available. It is deliberately not a dependency of this package — native modules like `onnxruntime` would make `dsh plugin add` hit pnpm's build-script approval gate, so it stays opt-in.

## Other agents

[`memgas-mcp`](https://www.npmjs.com/package/memgas-mcp) exposes the same store over MCP, so Claude Code, Codex and others can share it:

```json
{ "command": "npx", "args": ["-y", "memgas-mcp"] }
```

It defaults to the same `$DSH_HOME/memgas/` location. It has no model of its own: `memory_ingest` stores the transcript verbatim rather than summarizing, and there is no automatic harvesting or proactive recall.

## Known limitations

- **The local embedding model has not been verified against real weights.** The ONNX path was tested with an injected fake runtime; mean pooling and dimension handling have not run against an actual model. It is off by default.
- **`memgas-mcp` has not been connected to a real MCP client**, only its JSON-RPC layer is verified.
- **In one-shot mode, distillation lags by one session.** `dsh --profile headless` exits before the extraction model answers. The raw transcript is always stored synchronously and stays searchable; distillation is finished at the start of the next session. Long-running `dsh web` is unaffected.
- **Multiple workspaces.** Scope is resolved per session from its working directory, but this path has not been exercised in a multi-workspace `dsh web` setup.
- Default retrieval weights and thresholds are engineering judgements; they have not been tuned against any particular dataset.

## Development

```sh
pnpm install
pnpm test        # vitest, 263 tests
pnpm run build   # tsc -b, also the typecheck
```

Three packages: [`dsh-memgas`](./packages/dsh-plugin) (the dsh plugin), [`memgas-core`](./packages/core) (storage, retrieval channels, evolution; no dsh dependency), [`memgas-mcp`](./packages/mcp) (MCP server).

Design trade-offs, decision records and open questions are in the [design document](./docs/design.md) (Chinese).

## Citation

```bibtex
@inproceedings{xu2026memgas,
  title     = {From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents},
  author    = {Xu, Derong and Wen, Yi and Jia, Pengyue and Zhang, Yingyi and Zhang, Wenlin and Wang, Yichao and Guo, Huifeng and Tang, Ruiming and Zhao, Xiangyu and Chen, Enhong and Xu, Tong},
  booktitle = {International Conference on Learning Representations (ICLR)},
  year      = {2026}
}
```

## License

[MIT](./LICENSE)
