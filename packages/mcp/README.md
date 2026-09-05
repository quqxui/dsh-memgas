# memgas-mcp

An MCP server exposing a [`memgas`](https://www.npmjs.com/package/memgas-core) memory store to any agent that speaks MCP — Claude Code, Codex and others. Shares the same store as the [`dsh-memgas`](https://www.npmjs.com/package/dsh-memgas) plugin, so memories written in one host are readable in the next.

```json
{
  "mcpServers": {
    "memgas": { "command": "npx", "args": ["-y", "memgas-mcp"] }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Retrieve memories relevant to a query |
| `memory_save` | Record one durable fact |
| `memory_ingest` | Store a raw conversation transcript |
| `memory_forget` | Archive a memory by id (reversible) |
| `memory_status` | Store size, embedder, retrieval channels, graph health |

## Configuration

Environment variables, all optional:

| Variable | Default |
|---|---|
| `MEMGAS_HOME` | `$DSH_HOME`, else `~/.dsh` |
| `MEMGAS_PROJECT_DIR` | the working directory |
| `MEMGAS_SCOPE` | derived from the git remote of that directory |
| `MEMGAS_MODE` | `hybrid` (`lite` \| `hybrid` \| `memgas`) |

## Limitations

This server has no model of its own. `memory_ingest` stores the transcript verbatim instead of summarizing it, so memories are coarser than the ones the dsh plugin produces, and there is no automatic harvesting from a conversation and no proactive recall. For the full loop, use the plugin inside DeepSeek Harness.

## License

MIT
