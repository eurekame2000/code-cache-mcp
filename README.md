# code-cache-mcp

A lightweight, tree-sitter-backed code knowledge cache for AI agents — delivered as an MCP server.

轻量级代码知识缓存 MCP 服务，基于 tree-sitter 语法分析，专为 AI 编码助手设计。

---

## Overview / 概述

AI agents repeatedly read source files to answer code questions — burning tokens every time. `code-cache-mcp` changes this: the agent queries the cache first, gets symbol positions + inheritance + call graph, and only reads the specific line range on a true miss.

Code structure is parsed once using [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and stored in SQLite. **Only structure is persisted** — symbol names, kinds, line ranges, inheritance edges, call graph. No raw source code is ever stored.

AI 助手反复读源文件查符号，每次都烧 token。`code-cache-mcp` 先查缓存：返回符号位置 + 继承关系 + 调用图，仅在 miss 时才按行范围精确读取。代码结构用 tree-sitter 一次解析存入 SQLite，**仅存结构不存源码**。

---

## Features / 功能特性

- **Symbol cache** — classes, interfaces, enums, methods, functions, fields with line ranges
- **Inheritance graph** — `extends` / `implements` relationships, resolved lazily
- **Call graph** — method invocation edges (caller → callee)
- **AI location memory** — auto-persisted when query hits, instant retrieval in future sessions
- **Auto-invalidation** — FileWatcher detects file changes, re-parses automatically
- **Cold-start auto-index** — indexes cwd in background when cache is empty
- **Multi-language** — Java, TypeScript/JavaScript, Python, Go, Rust
- **Zero infrastructure** — single SQLite file, no server process
- **Lightweight** — 66MB node_modules (vs 389MB in v0.1), lazy WASM loading

---

## MCP Tools / MCP 工具

v0.2 provides **3 tools** (v0.1 had 8):

| Tool                 | Description                                               | Parameters                                     |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `query_code_cache`   | FAST symbol lookup: file:line + hierarchy + call graph    | `symbol`, `file_path`, `kinds`, `include_relationships` |
| `store_code_context` | Parse and cache a source file's structure                 | `file_path`, `language`                        |
| `index_directory`    | Batch-index all source files in a directory               | `directory`, `force`                           |

`query_code_cache` auto-indexes on miss and retries — no manual setup needed. Cache hits automatically persist as AI locations for future sessions.

`query_code_cache` 在 miss 时自动索引并重试——无需手动 setup。命中自动存储为 AI location，供后续会话直接命中。

---

## Supported Languages / 支持语言

| Language         | Extension           |
| ---------------- | ------------------- |
| Java             | `.java`             |
| TypeScript / TSX | `.ts` `.tsx`        |
| JavaScript / JSX | `.js` `.mjs` `.jsx` |
| Python           | `.py`               |
| Go               | `.go`               |
| Rust             | `.rs`               |

---

## Setup / 安装配置

### Prerequisites / 前提条件

- Node.js ≥ 18

### Install / 安装

```bash
cd /path/to/code-cache-mcp
npm install
```

### Register with Claude Code / 注册到 Claude Code

```bash
claude mcp add code-cache-mcp npx tsx "$(pwd)/packages/server/src/index.ts"
```

Or add manually to `~/.claude.json` under `mcpServers`:

```json
"code-cache-mcp": {
  "type": "stdio",
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/code-cache-mcp/packages/server/src/index.ts"]
}
```

### Environment Variables / 环境变量

| Variable         | Default       | Description                          |
| ---------------- | ------------- | ------------------------------------ |
| `CODE_CACHE_DIR` | `.code-cache` | Directory for the SQLite database    |

---

## Architecture / 架构

```
code-cache-mcp/
├── packages/
│   ├── sdk/                  # Core library (no MCP dependency)
│   │   └── src/
│   │       ├── types.ts      # Shared interfaces
│   │       ├── db.ts         # SQLite schema + queries
│   │       ├── code-cache.ts # CodeCacheStore — orchestrator
│   │       ├── parser-*.ts   # Language-specific parsers
│   │       ├── parser-registry.ts  # Lazy language dispatcher
│   │       └── watcher.ts    # FileWatcher (debounced fs.watch)
│   ├── server/               # MCP server entry point
│   │   └── src/
│   │       ├── index.ts      # CLI entry
│   │       └── mcp.ts        # 3 tool registrations
│   └── wasm/                 # tree-sitter WASM grammar binaries
```

### Database schema / 数据库结构

| Table                 | Contents                                            |
| --------------------- | --------------------------------------------------- |
| `file_versions`       | File path, hash, language, line count               |
| `symbols`             | Every class / method / field with line range        |
| `class_relationships` | Inheritance / implementation edges                  |
| `call_edges`          | Method invocation graph                             |
| `ai_locations`        | Auto-persisted AI query hits with reason            |
| `stats`               | Global cache hit/miss counters, tokens saved        |

---

## v0.2.1: project scoping & noise fixes / v0.2.1: 项目作用域与去噪

- **Project-scoped queries** — `query_code_cache` defaults to the server's project root (`CODE_CACHE_ROOT` overrides); a shared DB no longer leaks symbols from other projects. Explicit `file_path` filters still work across roots.
- **Cold-start guard** — auto-index and file watching only start when the directory looks like a real project (package.json / .git / pyproject.toml / go.mod / …). No more indexing `~/Library` or saved-webpage archives.
- **Minified-file detection** — bundles and machine-generated JS are skipped at parse time.
- **Call-graph denoising** — unresolved `obj.method()` edges for common built-in names (`get`, `join`, `append`, `update`, …) are filtered; edges resolving to real symbols are always kept.
- **`force` re-index actually works** — `index_directory(force=true)` now bypasses the hash short-circuit; cached hits report the real stored symbol count instead of 0.
- **Dedup** — query results dedupe by (name, file, line); per-project `hotness` / counters instead of global ones.
- **Schema versioning** — DBs from older schema versions are wiped once on startup (structure-only data is cheap to rebuild).

## v0.2 Changes from v0.1 / v0.2 相比 v0.1 的变化

| Metric              | v0.1    | v0.2    | Change  |
| ------------------- | ------- | ------- | ------- |
| MCP tools           | 8       | 3       | -62%    |
| query parameters    | 11      | 4       | -64%    |
| node_modules        | 389MB   | 66MB    | -83%    |
| mcp.ts lines        | 783     | ~290    | -64%    |
| DB tables           | 10      | 6       | -40%    |
| Dependencies        | ~200+   | ~102    | -50%    |

### Removed in v0.2

- **Semantic search** (`@xenova/transformers`, 45MB + 23MB model cache)
- **TokenTracker** (`@anthropic-ai/sdk`)
- **PostgreSQL metrics** (`pg` dual-write)
- **Cross-session query history** (SHA-256 hashing, diff computation)
- **Code snippet similarity** (Jaccard token matching, unified diff)
- **Session dedup cache** and **session stats** table
- **AST nodes** table and `include_ast` parameter
- 5 MCP tools: `cache_hotness`, `invalidate_cache`, `store_ai_location`, `get_ai_locations`, `cache_clear`
- `report.ts` and `claude-log-reader.ts`

---

## Tech Stack / 技术栈

| Component    | Technology                                          |
| ------------ | --------------------------------------------------- |
| Language     | TypeScript (ESM)                                    |
| Runtime      | Node.js + npx tsx                                   |
| Database     | SQLite via `@tursodatabase/database` (libSQL)       |
| Code parsing | `web-tree-sitter` + language WASM grammars (lazy)   |
| MCP SDK      | `@modelcontextprotocol/sdk`                         |
| Validation   | `zod`                                               |

---

## Guiding AI to Use the Cache / 引导 AI 使用缓存

AI agents default to `Read` / `grep` / `LSP` because they're familiar. To increase adoption:

1. **SessionStart hook** — Add to `~/.claude/settings.json`:
```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "cat ~/.claude/code-cache-hint.txt" }] }]
```
Create `~/.claude/code-cache-hint.txt`:
```
When navigating code, prefer query_code_cache over Read/grep for symbol lookups. It returns file:line positions, inheritance, and call graph — faster than reading whole files. After reading a source file, call store_code_context to cache it.
```

2. **Cold-start auto-index** — Built-in. When cache is empty, indexes cwd in background automatically.

3. **Teaching tip** — Built-in. Cache hits include: `"tip": "3 symbols found via cache. Use Read with offset/limit for the specific line ranges above."`

4. **CLAUDE.md** — Add to project root:
```markdown
## Code Navigation
- Use `query_code_cache` BEFORE `Read` to find symbols. Returns file:line + hierarchy + call graph.
- After `Read` on a source file, call `store_code_context` to build cache.
```

---

## License / 许可证

MIT
