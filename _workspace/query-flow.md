# query_code_cache 完整查询流程图

> 更新于实现 code_snippet / session dedup / auto diff / auto ai_location 之后

```
query_code_cache(params)
│
├─ code_snippet 存在?
│   ├─ YES → 【Session 代码片段查找路径】
│   │         sessionLog 过滤有 snippet 的条目
│   │         → snippetSimilarity(querySnippet, entry.snippet)  [token Jaccard]
│   │         → 按 similarity 排序，取 top 5，阈值 > 0.25
│   │         ├─ 无命中 (scores all < 0.25)
│   │         │   → 返回 {matches:[], message:"use semantic_query"}
│   │         └─ 有命中
│   │             ├─ similarity > 0.98  → diff = "(identical)" + position
│   │             └─ 0.25~0.98          → computeUnifiedDiff(query, entry.snippet)
│   │                                       [LCS算法，非AI]
│   │             → 返回 {source:"session_context", matches:[{position,similarity,diff}]}
│   └─ NO → 继续↓
│
├─ 参数全空 (无symbol/file_path/pattern/semantic_query)?
│   └─ YES → Error
│
├─ queryCache 命中同 key? (symbol|file_path|pattern|semantic_query)
│   且无 diff_against / auto_diff_from_session?
│   └─ YES → 返回缓存结果 + already_seen_this_session:true + first_seen_ms_ago
│
└─ 【DB 查询路径】
    │
    ├─ semantic_query 存在?
    │   └─ YES → embedder.semanticSearch() → 向量余弦相似度 → symbol_ids
    │
    ├─ symbol 存在?
    │   └─ YES → 内存 symbolNameIndex 模糊匹配 (含 camelCase 首字母缩写)
    │
    └─ pattern/file_path only → SQL LIKE 查询
    │
    ↓ result = queryBySymbol()
    │
    ├─ total_hits == 0? (cache miss)
    │   └─ YES → 【自动索引路径】
    │             file_path → [该文件]
    │             symbol    → findFilesContainingSymbol(symbol, search_root)
    │                         → 文件名匹配 + grep 内容匹配
    │             → cache.storeFile() × N (并发4) [tree-sitter 解析]
    │             → 重新 queryBySymbol()
    │             → 写 metrics
    │
    ↓ result (有或无命中)
    │
    ├─ groupHits()  按 (file_path, parent_symbol) 分组，提取公共前缀
    │
    ├─ 写 sessionLog (file_path, start_line, end_line, symbol_name, snippet←fetchSnippet)
    │   [供后续 code_snippet 查询使用]
    │
    ├─ total_hits > 0?
    │   └─ YES → storeAiLocation() fire-and-forget, top 3 hits
    │             [跨 session 记忆，写 SQLite ai_locations 表]
    │
    ├─ diff_against 或 auto_diff_from_session?
    │   └─ YES → fetchSnippet(diffRef) + fetchSnippet(each hit)
    │             → computeUnifiedDiff() [LCS]
    │             → 每条 hit 加 diff 字段
    │
    ├─ 写 queryCache (key → {result, ts})
    │
    ├─ 截断 > 50000 chars
    │
    └─ 返回 {session_id, total_hits, cache_hit, hits, tokens_saved_estimate}
        + 异步: tracker.count() → monitor.record() [metrics]
```

## 数据流向总结

```
输入类型          查询源          副作用
─────────────────────────────────────────────────────
code_snippet  → 内存 sessionLog → 无 (只读)
symbol/pattern → 内存 index     → sessionLog + ai_locations
semantic_query → SQLite embeddings → sessionLog + ai_locations
cache miss     → 磁盘文件        → SQLite symbols + sessionLog
重复查询        → 内存 queryCache → 无
```

## 注意事项

- AI 是翻译层，不透传用户原始查询语句到 params
- `query_text` 存的是 AI 构造的符号名，非用户原话，跨 session 语义召回可能偏移
- `code_snippet` 需 AI 主动传代码文本，不会自动从上下文提取
