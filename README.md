# code-cache-mcp

A persistent, tree-sitter-backed code knowledge cache for AI agents — delivered as an MCP server.

持久化的代码知识缓存 MCP 服务，基于 tree-sitter 语法分析，专为 AI 编码助手设计。

---

## Overview / 概述

**English**

When an AI agent answers code-related questions, it normally has to read source files repeatedly — burning tokens every time. `code-cache-mcp` intercepts this pattern: the agent calls the cache first, gets back pre-parsed symbols, inheritance trees, call graphs, and previously AI-located positions, and only falls back to reading raw files on a true cache miss.

Code structure is analyzed once using [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and stored in a local SQLite database. **Only parsed structure is persisted** — symbol names, kinds, line ranges, inheritance edges, and call graph. Raw source code is never written to the cache. Subsequent queries return structured results instantly — no re-parsing, no full file reads.

**中文**

AI 助手回答代码相关问题时，通常需要反复读取源文件，每次都消耗大量 token。`code-cache-mcp` 改变这一模式：助手优先查询缓存，获取预解析好的符号信息、继承关系、调用图谱以及历史 AI 定位记录，仅在真正的缓存未命中时才回退到读取原始文件。

代码结构通过 [tree-sitter](https://tree-sitter.github.io/tree-sitter/) 一次性分析后存入本地 SQLite 数据库。**缓存仅保存解析后的结构**——符号名称、类型、行号范围、继承边、调用图，不存储任何原始源码。后续查询直接返回结构化结果，无需重新解析或读取完整文件。

---

## Features / 功能特性

- **Symbol cache** — classes, interfaces, enums, methods, functions, fields with line ranges (no raw code stored — structure only)
- **Inheritance graph** — `extends` / `implements` relationships stored as a graph; forward references resolved lazily as more files are cached
- **Call graph** — method invocation edges (caller → callee) extracted from method bodies
- **AI location memory** — persist code positions identified by AI sessions so future sessions find the same code instantly
- **Auto-invalidation** — `FileWatcher` detects file changes (100 ms debounce), invalidates stale cache entries, and re-parses automatically
- **Multi-language** — Java, TypeScript / JavaScript, Python (extensible via WASM grammar files)
- **Zero infrastructure** — single SQLite file, no server process required
- **In-memory symbol index** — symbol-name substring search runs entirely in JS (`Array.filter` + `String.includes`), bypassing SQLite LIKE scans; results fetched via a single indexed `WHERE id IN (...)` query
- **In-memory embedding cache** — semantic search embedding vectors are cached in the `CodeCacheStore` instance; the full DB load only re-runs when new files are indexed (dirty flag)
- **Batch relationship queries** — parent name, AST nodes, class relationships, callers, and callees are fetched with a single `IN (...)` query per type, replacing an N+1 per-hit loop

---

- **符号缓存** — 类、接口、枚举、方法、函数、字段，含行号范围（仅存结构，不存原始代码）
- **继承关系图** — `extends` / `implements` 关系以图结构存储，新文件入库时自动补全悬空引用
- **调用图谱** — 从方法体提取调用边（caller → callee）
- **AI 定位记忆** — 持久化 AI 会话识别的代码位置，后续会话可直接命中
- **自动失效** — FileWatcher 检测文件变更（100 ms 防抖），自动清除过期缓存并重新解析
- **多语言支持** — Java、TypeScript / JavaScript、Python（通过 WASM 语法文件扩展）
- **零基础设施** — 单个 SQLite 文件，无需额外服务进程
- **内存符号索引** — 符号名称子串搜索完全在 JS 层执行（`Array.filter` + `String.includes`），绕过 SQLite LIKE 全表扫描；结果通过单条 `WHERE id IN (...)` 索引查询取回
- **内存 Embedding 缓存** — 语义搜索向量缓存在 `CodeCacheStore` 实例中，仅在新文件入库（脏标记）时才重新从 DB 加载
- **批量关系查询** — parent 名称、AST 节点、类关系、调用者、被调用者各用一条 `IN (...)` 批量查询替代原先的 N+1 循环

---

## MCP Tools / MCP 工具


| Tool                 | Description                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `query_code_cache`   | Look up symbols, classes, methods by name, pattern, or semantic query. Call this **before** reading source files. |
| `store_code_context` | Parse a source file with tree-sitter and store the extracted structure in the cache.             |
| `index_directory`    | Recursively parse and cache all source files in a directory. Call once to prime the cache for a new project. |
| `store_ai_location`  | Record a code position the AI identified as relevant, with a reason. Persists across sessions.   |
| `get_ai_locations`   | Retrieve previously AI-located positions by file or query text.                                  |
| `invalidate_cache`   | Remove cached data for specified files (FileWatcher does this automatically).                    |
| `cache_stats`        | Show files tracked, symbols cached, cache hits/misses, tokens saved.                             |
| `cache_clear`        | Reset the entire cache.                                                                          |


---


| 工具                   | 说明                                 |
| -------------------- | ---------------------------------- |
| `query_code_cache`   | 按名称、模式或语义查询查找符号、类、方法。读文件**前**优先调用此工具。 |
| `store_code_context` | 用 tree-sitter 解析源文件并将结构存入缓存。       |
| `index_directory`    | 递归解析并缓存目录下所有源文件。新项目首次使用时调用以预热缓存。   |
| `store_ai_location`  | 记录 AI 识别的代码位置及原因，跨会话持久化。           |
| `get_ai_locations`   | 按文件路径或查询文本检索历史 AI 定位记录。            |
| `invalidate_cache`   | 清除指定文件的缓存（FileWatcher 自动调用）。       |
| `cache_stats`        | 显示已缓存文件数、符号数、命中/未命中次数、节省的 token 数。 |
| `cache_clear`        | 重置全部缓存。                            |


---

## Semantic Search / 语义相似搜索

`query_code_cache` supports a `semantic_query` parameter — a natural language description that finds symbols by **meaning** rather than by exact name.

`query_code_cache` 支持 `semantic_query` 参数，通过**语义相似度**而非名称精确匹配来查找符号。

### How it works / 工作原理

1. When a file is cached via `store_code_context`, each symbol is embedded using `[Xenova/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)` (384-dim, quantized, runs entirely locally via `@xenova/transformers`). Embedding generation runs asynchronously — it never delays cache writes.
  文件入库后，每个符号通过本地量化模型（384 维）生成嵌入向量，异步执行不阻塞写入。
2. At query time, `semantic_query` is embedded with the same model, then compared against stored vectors using cosine similarity. Embedding vectors are cached in memory after the first load; the cache is invalidated only when new files are indexed, so repeated semantic queries pay no DB round-trip cost. Top-K results (score ≥ 0.3) are returned and merged with any lexical matches.
  查询时，模型对 `semantic_query` 生成向量，与存储向量做余弦相似度计算。Embedding 向量首次加载后缓存于内存，仅在新文件入库时失效，重复语义查询无需再访问 DB。得分 ≥ 0.3 的 top-K 结果与词法匹配结果合并返回。
3. Results include a `semantic_score` field (0–1) when returned via semantic search. Results are sorted by score descending.
  语义搜索命中的结果包含 `semantic_score` 字段（0–1），结果按得分降序排列。

### Usage example / 使用示例

```json
{
  "tool": "query_code_cache",
  "arguments": {
    "semantic_query": "user authentication and JWT token validation"
  }
}
```

Can be combined with lexical search for hybrid retrieval:  
可与词法搜索组合实现混合检索：

```json
{
  "tool": "query_code_cache",
  "arguments": {
    "symbol": "Auth",
    "semantic_query": "handle login and session expiry",
    "kinds": ["method", "class"]
  }
}
```

### Embedding status / 嵌入向量状态

The `cache_stats` tool shows `Embeddings stored` — this count grows as symbols are embedded in the background.  
`cache_stats` 工具显示 `Embeddings stored`，该数值随后台嵌入生成逐步增加。

Model downloads (~23 MB) are cached in `.model-cache/` on first use.  
模型文件（约 23 MB）首次使用时自动下载并缓存到 `.model-cache/` 目录。

---

## Supported Languages / 支持语言


| Language         | Extension           | WASM Source                  |
| ---------------- | ------------------- | ---------------------------- |
| Java             | `.java`             | `tree-sitter-java` npm       |
| TypeScript / TSX | `.ts` `.tsx`        | `tree-sitter-typescript` npm |
| JavaScript / JSX | `.js` `.mjs` `.jsx` | `tree-sitter-typescript` npm |
| Python           | `.py`               | `tree-sitter-python` npm     |
| Go               | `.go`               | `tree-sitter-go` npm         |
| Rust             | `.rs`               | `tree-sitter-rust` npm       |


---

## Architecture / 架构

```
code-cache-mcp/
├── packages/
│   ├── sdk/                  # Core library (no MCP dependency)
│   │   └── src/
│   │       ├── types.ts      # Shared interfaces
│   │       ├── db.ts         # SQLite schema + typed query helpers
│   │       ├── code-cache.ts # CodeCacheStore — main orchestrator
│   │       ├── parser-java.ts
│   │       ├── parser-typescript.ts
│   │       ├── parser-python.ts
│   │       ├── parser-go.ts
│   │       ├── parser-rust.ts
│   │       ├── parser-registry.ts  # Language dispatcher
│   │       ├── embedder.ts   # Semantic embeddings (all-MiniLM-L6-v2 via @xenova/transformers)
│   │       └── watcher.ts    # FileWatcher (debounced fs.watch)
│   ├── server/               # MCP server entry point
│   │   └── src/
│   │       ├── index.ts      # CLI entry
│   │       ├── mcp.ts        # Tool registrations
│   │       ├── report.ts     # npm run report — token savings CLI (timestamps: UTC+8)
│   │       └── claude-log-reader.ts  # reads ~/.claude/ session logs for per-turn stats
│   └── wasm/                 # tree-sitter WASM grammar binaries
│       ├── tree-sitter-java.wasm
│       ├── tree-sitter-typescript.wasm
│       ├── tree-sitter-python.wasm
│       ├── tree-sitter-go.wasm
│       ├── tree-sitter-rust.wasm
│       └── tree-sitter.wasm
```

### Database schema / 数据库结构


| Table                     | Contents                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `file_versions`           | File path, hash, language, line count (no raw content stored)   |
| `symbols`                 | Every class / method / field with line range (structure only)   |
| `ast_nodes`               | Depth-limited AST JSON per symbol                               |
| `class_relationships`     | Inheritance / implementation edges                              |
| `call_edges`              | Method invocation graph                                         |
| `ai_locations`            | AI-identified code positions with reason and query text         |
| `symbol_embeddings`       | 384-dim embedding vector per symbol for semantic search         |
| `stats` / `session_stats` | Cache hit/miss counters, tokens saved                           |


---

## Setup / 安装配置

### Prerequisites / 前提条件

- Node.js ≥ 18
- npm ≥ 7

### Install / 安装

```bash
cd /path/to/code-cache-mcp
npm install
```

### Register with Claude Code / 注册到 Claude Code

```bash
# Run from the project root directory / 在项目根目录下运行
claude mcp add code-cache-mcp npx tsx "$(pwd)/packages/server/src/index.ts"
```

Or add manually to `~/.claude.json` under `mcpServers` / 或手动添加到 `~/.claude.json` 的 `mcpServers` 字段：

```json
"code-cache-mcp": {
  "type": "stdio",
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/code-cache-mcp/packages/server/src/index.ts"]
}
```

### Environment Variables / 环境变量


| Variable           | Default       | Description                                                                 |
| ------------------ | ------------- | --------------------------------------------------------------------------- |
| `CODE_CACHE_DIR`   | `.code-cache` | Directory for the SQLite database file                                      |
| `METRICS_DB_URL`   | unset         | PostgreSQL connection string; enables dual-write metrics to `mcp_calls` table |
| `ANTHROPIC_API_KEY`| unset         | Enables accurate `tokens_used` counting via Anthropic API (optional)        |


---

## Usage Pattern / 使用模式

**Typical agent workflow / 典型 Agent 工作流：**

```
User asks about code
  → Agent calls query_code_cache({ symbol: "PaymentService" })
      CACHE HIT  → returns symbol structure + inheritance + call graph (tokens saved)
      CACHE MISS → Agent calls store_code_context({ file_path: "PaymentService.java" })
                     → tree-sitter parses file
                     → symbols/relationships/call edges stored in SQLite
                   → Agent calls query_code_cache again → HIT
  → Agent calls store_ai_location({ file_path, start_line: 42, reason: "entry point for payment flow" })
  → Agent answers user (no full file reads needed)

File changes on disk:
  FileWatcher → onFileChanged() → invalidate → re-parse → DB updated
```

---

## Tech Stack / 技术栈


| Component    | Technology                                          |
| ------------ | --------------------------------------------------- |
| Language     | TypeScript (ESM)                                    |
| Runtime      | Node.js + npx tsx                                   |
| Database     | SQLite via `@tursodatabase/database` (libSQL)       |
| Code parsing | `web-tree-sitter` + language-specific WASM grammars |
| MCP SDK      | `@modelcontextprotocol/sdk`                         |
| Validation   | `zod`                                               |


---

## Performance / 性能设计

### Query latency / 查询延迟


| Optimization             | Mechanism                                                                                                                    | Impact                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| In-memory symbol index   | JS `Array.filter` + `String.includes` on `(id, name, kind, filePath)` tuples; rebuilt only on `storeFile` / `invalidateFile` | Eliminates `LIKE '%x%'` full-table scan for `symbol` / `pattern` parameters |
| Batch relationship fetch | Single `WHERE id IN (...)` per relationship type (parent, AST, rels, callers, callees)                                       | Replaces N+1 async DB round-trips in the results loop                    |
| Embedding cache          | `Map<symbol_id, vector>` held in `CodeCacheStore`; `embeddingCacheDirty` flag reloads only after writes                      | Eliminates full `symbol_embeddings` table scan on every `semantic_query` |


### Indexing throughput / 索引吞吐


| Optimization               | Mechanism                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| In-memory FK resolution    | Parent `symbol_id` resolved during parse via `idxToId` map; no post-hoc `UPDATE` scan needed for intra-file references |
| Async embedding generation | `generateEmbeddings` is fire-and-forget — never blocks `storeFile` response                                            |


---

## Design Decisions / 设计说明

**Why SQLite over PostgreSQL / ClickHouse?**  
ClickHouse is OLAP — wrong fit for row-level cache invalidation. PostgreSQL requires a daemon. SQLite via libSQL gives zero operational overhead, built-in JSON1 extension for AST storage, recursive CTEs for graph traversal, and the same driver already proven in [cachebro](https://github.com/glommer/cachebro).

**为何选择 SQLite 而非 PostgreSQL / ClickHouse？**  
ClickHouse 为 OLAP 设计，不适合行级缓存失效操作；PostgreSQL 需要常驻守护进程。libSQL 版 SQLite 零运维开销，内置 JSON1 扩展可存储 AST，支持递归 CTE 进行图遍历，且与 [cachebro](https://github.com/glommer/cachebro) 使用同一驱动。

**Why separate `class_relationships` table instead of `parent_id` on symbols?**  
A class can implement multiple interfaces — this is a graph, not a tree. The `parent_id` column on `symbols` handles *containment* (method inside class); `class_relationships` handles *inheritance* (class extends/implements N parents).

**为何单独建 `class_relationships` 表而非在 symbols 上加 `parent_id`？**  
一个类可以实现多个接口，这是图结构而非树结构。`symbols.parent_id` 处理*包含关系*（方法属于某类），`class_relationships` 处理*继承关系*（类继承/实现 N 个父类/接口）。

---

## References / 参考项目

- [cachebro](https://github.com/glommer/cachebro) — file cache MCP for AI agents (pattern source for FileWatcher, session stats, SQLite setup)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) — incremental parsing system
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) — WASM bindings for tree-sitter

---

## Monitoring Token Savings / 监控 Token 节省效果

### Implementation status / 实现状态


| Approach / 方案           | Status / 状态            | Activation / 启用方式                  |
| ----------------------- | ---------------------- | ---------------------------------- |
| JSONL metrics           | ✅ Always active / 默认启用 | Zero config — writes automatically |
| PostgreSQL dual-write   | ✅ Implemented / 已实现    | Set `METRICS_DB_URL` env var       |
| TokenTracker (external) | ⬜ External tool / 外部工具 | `pip install tokentracker`         |


---

### Approach 1 — JSONL metrics ✅ Always active / 方案一：JSONL 指标（默认启用）

Every MCP tool call is automatically appended to `$CODE_CACHE_DIR/metrics.jsonl` by `MetricsMonitor` in `packages/sdk/src/monitor.ts`. No configuration required.  
每次 MCP 工具调用由 `monitor.ts` 中的 `MetricsMonitor` 自动追加写入 `$CODE_CACHE_DIR/metrics.jsonl`，无需任何配置。

```bash
npm run report          # hit rate, per-file rank, per-session summary, per-turn Claude API usage
jq 'select(.cache_hit)' .code-cache/metrics.jsonl | jq -s 'map(.tokens_saved)|add'
```

Each record:

```json
{"ts":1780814175819,"session_id":"...","tool":"query_code_cache",
 "cache_hit":true,"tokens_saved":1200,"tokens_used":300,
 "symbol":"UserService","hits_count":3,"duration_ms":12}
```

**Estimation method / 估算方式：**

- `tokens_saved` — `(end_line - start_line + 1) × 30` per matched symbol. The constant 30 approximates an average of ~40 chars/line × 0.75 tokens/char. Real lines vary widely (a closing `}` is ~1 token; a dense expression can be 60+), so treat this as a rough **2× overestimate** relative to actual saved tokens. Useful for relative comparison across sessions, not as an absolute figure.  
  每个命中符号按 `行数 × 30` 估算，约等于平均每行 40 字符 × 0.75 token/字符。实际每行 token 数差异较大，总体偏高约 2 倍，适合会话间横向对比，不宜作为精确绝对值。

- `tokens_used` — accurate token count via Anthropic `count_tokens` API when `ANTHROPIC_API_KEY` is set; falls back to `JSON.stringify(response).length / 4` otherwise. Measures the actual MCP response size the agent had to consume.  
  设置 `ANTHROPIC_API_KEY` 时通过 Anthropic API 精确计数；否则退回 `响应字节数 ÷ 4` 估算。反映本次调用实际消耗的 token 量。

`npm run report` also reads `~/.claude/projects/` session logs and shows per-turn Claude API token usage. Timestamps displayed in **Beijing time (UTC+8)**.  
`npm run report` 同时读取 `~/.claude/projects/` 会话日志，展示逐轮 Claude API token 用量，时间戳显示为**北京时间（UTC+8）**。

---

### Approach 2 — PostgreSQL dual-write ✅ Implemented / 方案二：PostgreSQL 双写（已实现）

When `METRICS_DB_URL` is set, `MetricsMonitor` writes each record to **both** JSONL and a PostgreSQL `mcp_calls` table. The `pg` package is installed as an optional dependency — no extra setup needed.  
设置 `METRICS_DB_URL` 后，`MetricsMonitor` 同时写入 JSONL 和 PostgreSQL `mcp_calls` 表。`pg` 已作为 optional dependency 安装，无需额外配置。

**Setup / 启用步骤：**

```bash
# 1. Start a PostgreSQL instance (example with Docker) / 启动 PG（Docker 示例）
docker run -d --name pg-metrics -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16-alpine

# 2. Start MCP server with the connection string / 设置连接串启动 MCP
METRICS_DB_URL=postgres://postgres:pw@localhost:5432/postgres npm start
```

The `mcp_calls` table and indexes are created automatically on first connection.  
首次连接时自动建表和索引，无需手动执行 DDL。

```sql
-- mcp_calls schema (auto-created)
CREATE TABLE mcp_calls (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  cache_hit    BOOLEAN NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT,
  symbol       TEXT,
  hits_count   INTEGER,
  duration_ms  INTEGER
);
```

Useful queries / 常用分析查询：

```sql
-- Hit rate and savings per session / 每会话命中率与节省量
SELECT session_id, COUNT(*) calls, ROUND(AVG(cache_hit::int)::numeric, 2) hit_rate,
       SUM(tokens_saved) saved
FROM mcp_calls GROUP BY session_id ORDER BY MIN(ts) DESC LIMIT 20;

-- Hourly token savings trend / 每小时节省趋势
SELECT DATE_TRUNC('hour', ts) h, SUM(tokens_saved) saved, SUM(tokens_used) used
FROM mcp_calls GROUP BY h ORDER BY h;

-- Top symbols by savings / 节省最多的符号
SELECT symbol, COUNT(*) hits, SUM(tokens_saved) saved
FROM mcp_calls WHERE cache_hit AND symbol IS NOT NULL
GROUP BY symbol ORDER BY saved DESC LIMIT 20;
```

If PG is unavailable or `METRICS_DB_URL` is unset, `MetricsMonitor` silently falls back to JSONL-only — the MCP server never crashes on PG failure.  
若 PG 不可用或未设置环境变量，`MetricsMonitor` 静默降级为 JSONL 单写，MCP 服务不会因 PG 故障崩溃。

---

### Approach 3 — TokenTracker ⬜ External tool / 方案三：TokenTracker（外部工具）

[TokenTracker](https://www.tokentracker.cc) reads Claude Code session logs (`~/.claude/`) and shows macro token totals per session. Useful for A/B comparison (cache on vs off) but cannot break down cache hit/miss or per-file savings.  
TokenTracker 读取 Claude Code 会话日志，展示每会话宏观 token 总量。适合 A/B 对比，但无法区分缓存命中/未命中或单文件节省。

```bash
pip install tokentracker
tokentracker serve   # dashboard at http://localhost:7680
```

No code integration required — this project has no dependency on TokenTracker.  
无代码集成，本项目不依赖 TokenTracker。

---

### Comparison / 方案对比


|                      | JSONL (Approach 1) | PostgreSQL (Approach 2)     | TokenTracker (Approach 3) |
| -------------------- | ------------------ | --------------------------- | ------------------------- |
| **Status**           | ✅ Always on        | ✅ Opt-in (`METRICS_DB_URL`) | ⬜ External                |
| **Granularity**      | Per MCP call       | Per MCP call                | Per Claude session        |
| **Cache hit/miss**   | ✓                  | ✓                           | ✗                         |
| **Per-file savings** | ✓ (`file_path`)    | ✓                           | ✗                         |
| **Call latency**     | ✓ (`duration_ms`)  | ✓                           | ✗                         |
| **SQL analysis**     | `jq` only          | Full SQL                    | Dashboard only            |
| **Infrastructure**   | None               | PostgreSQL instance         | Python + local HTTP       |
| **MCP awareness**    | ✓                  | ✓                           | ✗                         |


---

## License / 许可证

MIT