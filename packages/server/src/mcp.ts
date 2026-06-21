import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, basename, extname } from "path";
import { existsSync, mkdirSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { CodeCacheStore, FileWatcher, MetricsMonitor, TokenTracker } from "@code-cache/sdk";

const SOURCE_EXTENSIONS = new Set([".java", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".py", ".go"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".code-cache", "dist", "build", "target", "__pycache__"]);

/** Walk root, return all source files whose filename or content contains symbol. */
async function findFilesContainingSymbol(symbol: string, root: string, maxFiles = 100): Promise<string[]> {
  const found: string[] = [];
  const lower = symbol.toLowerCase();
  const queue = [root];
  while (queue.length > 0 && found.length < maxFiles) {
    const dir = queue.shift()!;
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = `${dir}/${entry}`;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) { queue.push(full); continue; }
      const ext = extname(entry);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      const stem = basename(entry, ext);
      if (stem === symbol || stem.toLowerCase() === lower) {
        found.push(full);
      } else {
        try {
          const content = await readFile(full, "utf-8");
          if (content.includes(symbol)) found.push(full);
        } catch { /* skip unreadable */ }
      }
      if (found.length >= maxFiles) break;
    }
  }
  return found;
}

/** Walk root, return all source files. */
async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = `${dir}/${entry}`;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) { queue.push(full); continue; }
      if (SOURCE_EXTENSIONS.has(extname(entry))) files.push(full);
    }
  }
  return files;
}

/** Read lines [startLine, endLine] (1-based) from a file. Returns "" on error. */
async function fetchSnippet(filePath: string, startLine: number, endLine: number): Promise<string> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(startLine - 1, Math.min(endLine, startLine + 149)).join("\n");
  } catch {
    return "";
  }
}

/**
 * Token-based Jaccard similarity between two code snippets.
 * Ignores whitespace differences; returns [0,1].
 */
function snippetSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => {
    const tokens = s.split(/[\s\n\r\t,;(){}[\].<>]+/).filter(t => t.length > 1);
    return new Set(tokens);
  };
  const ta = tokenize(a), tb = tokenize(b);
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Minimal unified diff of two line arrays. Returns "(identical)" when no changes. */
function computeUnifiedDiff(aLines: string[], bLines: string[], labelA: string, labelB: string): string {
  const MAX = 120;
  const a = aLines.slice(0, MAX);
  const b = bLines.slice(0, MAX);
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Array<{ op: "=" | "-" | "+"; line: string }> = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      ops.push({ op: "=", line: a[i] }); i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ op: "+", line: b[j] }); j++;
    } else {
      ops.push({ op: "-", line: a[i] }); i++;
    }
  }
  if (!ops.some(o => o.op !== "=")) return "(identical)";
  return `--- ${labelA}\n+++ ${labelB}\n` +
    ops.map(o => o.op === "=" ? ` ${o.line}` : o.op === "-" ? `-${o.line}` : `+${o.line}`).join("\n");
}

/** Longest common prefix of an array of strings. */
function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) return "";
  }
  return prefix;
}

/**
 * Group hits by (file_path, parent_symbol). Common context appears once.
 * For multi-symbol groups: annotates name_prefix (shared) + diff (unique suffix per symbol).
 * Each entry includes position ("file:line") for quick navigation.
 */
function groupHits(hits: any[]): any[] {
  const groups = new Map<string, { file_path: string; parent_symbol?: string; symbols: any[] }>();

  for (const h of hits) {
    const key = `${h.file_path}\0${h.parent_symbol ?? ""}`;
    if (!groups.has(key)) groups.set(key, { file_path: h.file_path, parent_symbol: h.parent_symbol, symbols: [] });
    const sym: any = {
      name: h.symbol_name,
      kind: h.symbol_kind,
      lines: `${h.start_line}-${h.end_line}`,
      position: `${h.file_path}:${h.start_line}`,
    };
    if (h.semantic_score !== undefined) sym.score = h.semantic_score;
    if (h.ast) sym.ast = h.ast;
    if (h.relationships?.length) sym.relationships = h.relationships;
    if (h.callers?.length) sym.callers = h.callers;
    if (h.callees?.length) sym.callees = h.callees;
    groups.get(key)!.symbols.push(sym);
  }

  return [...groups.values()].map(g => {
    const base: any = { file_path: g.file_path };
    if (g.parent_symbol) base.parent_symbol = g.parent_symbol;

    if (g.symbols.length === 1) return { ...base, ...g.symbols[0] };

    // Annotate name diff: extract common prefix, mark unique suffix per symbol
    const names = g.symbols.map((s: any) => s.name as string);
    const prefix = commonPrefix(names);
    if (prefix.length > 2) {
      base.name_prefix = prefix;
      g.symbols.forEach((s: any) => { s.diff = s.name.slice(prefix.length) || "(same)"; });
    }

    return { ...base, symbols: g.symbols };
  });
}

function getCacheDir(): string {
  const dir = resolve(process.env.CODE_CACHE_DIR ?? ".code-cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function startMcpServer(): Promise<void> {
  const cacheDir = getCacheDir();
  const dbPath = resolve(cacheDir, "code-cache.db");
  const sessionId = randomUUID();

  const cache = new CodeCacheStore({ dbPath, sessionId });
  await cache.init();

  const monitor = new MetricsMonitor(cacheDir, sessionId);
  const tracker = new TokenTracker(process.env.ANTHROPIC_API_KEY);

  // Per-session context: dedup + diff reference tracking
  interface SessionEntry { file_path: string; start_line: number; end_line: number; symbol_name?: string; snippet?: string; ts: number }
  const sessionLog: SessionEntry[] = [];
  const queryCache = new Map<string, { result: any; ts: number }>();

  const watcher = new FileWatcher(cache);
  watcher.watch([process.cwd()]);

  const server = new McpServer({ name: "code-cache-mcp", version: "0.1.0" });

  server.tool(
    "query_code_cache",
    `Query the code cache for symbols, classes, methods, or code patterns.
Returns parsed code structure: symbol kinds, line ranges, inheritance relationships, and call graph edges. Does NOT return raw source code.

USE THIS TOOL when:
- Finding where a class/method is defined (symbol lookup)
- Understanding inheritance, interface, or call graph relationships
- The file is >100 lines and you only need structure or location
- Revisiting code already seen this session (cache hit is nearly free)

SKIP THIS TOOL and use Read directly when:
- File is <50 lines (Read is cheaper than a cache miss + index)
- You need the actual implementation body to understand logic
- You only need this once and the file is small

After a cache hit: use the returned start_line/end_line with the Read tool
  (offset=start_line-1, limit=end_line-start_line+1) to read just that section — never read the whole file.

At least one of 'symbol', 'file_path', or 'pattern' is required.
On cache miss, auto-indexes files containing the symbol from search_root (defaults to cwd).

--- Progressive workflow for cache building ---
To build up the cache incrementally without upfront cost:
1. After you Read a source file, call store_code_context (fire-and-forget, non-blocking)
2. When you find a relevant code segment, call store_ai_location to persist it
3. Next session: call get_ai_locations first to see what was found before
Over time, this makes query_code_cache faster without ever doing a full index_directory.`,
    {
      symbol: z.string().optional().describe("Class or method name to look up (partial match)"),
      file_path: z.string().optional().describe("Absolute path to filter results to one file"),
      pattern: z.string().optional().describe("SQL LIKE pattern matched against symbol names (e.g. '%Service%')"),
      semantic_query: z.string().optional().describe("Natural language query for semantic similarity search using embeddings (e.g. 'user authentication logic')"),
      kinds: z.array(z.enum(["class", "interface", "enum", "method", "function", "field", "constructor", "record", "variable"])).optional().describe("Filter by symbol kind"),
      include_ast: z.boolean().optional().describe("Include AST JSON for each hit (default: false)"),
      include_relationships: z.boolean().optional().describe("Include inheritance/call graph info (default: false)"),
      limit: z.number().optional().describe("Max results to return (default: 20)"),
      search_root: z.string().optional().describe("Directory to search when auto-indexing on cache miss (default: cwd). Set to the project root, e.g. '/Users/me/projects/my-app'"),
      diff_against: z.object({
        file_path: z.string(),
        start_line: z.number(),
        end_line: z.number(),
      }).optional().describe("Diff each result against this known code location (file_path + line range). Use when you want to compare results to a specific code snippet you already know."),
      auto_diff_from_session: z.boolean().optional().describe("When true, auto-select the most recently seen code in this session as the diff reference. Useful for 'find similar code to what we just looked at'."),
      code_snippet: z.string().optional().describe("Raw source code text to look up in session context. Checks if this exact or similar code was seen earlier in this conversation. Returns file:line location + programmatic diff against similar matches. Does NOT use AI to generate the diff — purely algorithmic. Use this when you have a code segment and want to know where it came from or find variants seen this session."),
    },
    async (params) => {
      try {
        // code_snippet path: session-context lookup only, no DB query
        if (params.code_snippet) {
          const querySnippet = params.code_snippet.trim();
          const candidates = sessionLog.filter(e => e.snippet);
          const scored = candidates
            .map(e => ({ e, sim: snippetSimilarity(querySnippet, e.snippet!) }))
            .filter(({ sim }) => sim > 0.25)
            .sort((a, b) => b.sim - a.sim)
            .slice(0, 5);

          if (scored.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              source: "session_context",
              session_id: sessionId,
              matches: [],
              message: "No similar code found in session context. Use semantic_query to search the DB.",
            }) }] };
          }

          const matches = scored.map(({ e, sim }) => {
            const isIdentical = sim > 0.98;
            const diff = isIdentical
              ? "(identical)"
              : computeUnifiedDiff(
                  querySnippet.split("\n"),
                  (e.snippet ?? "").split("\n"),
                  "queried_snippet",
                  `${basename(e.file_path)}:${e.start_line}-${e.end_line}`
                );
            return {
              file_path: e.file_path,
              position: `${e.file_path}:${e.start_line}`,
              start_line: e.start_line,
              end_line: e.end_line,
              symbol_name: e.symbol_name,
              similarity: Math.round(sim * 100) / 100,
              exact_match: isIdentical,
              diff,
            };
          });

          return { content: [{ type: "text" as const, text: JSON.stringify({
            source: "session_context",
            session_id: sessionId,
            matches,
          }) }] };
        }

        if (!params.symbol && !params.file_path && !params.pattern && !params.semantic_query) {
          return { content: [{ type: "text" as const, text: "Error: at least one of symbol, file_path, pattern, semantic_query, or code_snippet is required." }], isError: true };
        }

        // Dedup: if same query already answered this session, return cached result immediately
        const cacheKey = [params.symbol, params.file_path, params.pattern, params.semantic_query].join("|");
        const prevQuery = queryCache.get(cacheKey);
        if (prevQuery && !params.diff_against && !params.auto_diff_from_session) {
          const dedupPayload = { ...prevQuery.result, already_seen_this_session: true, first_seen_ms_ago: Date.now() - prevQuery.ts, session_id: sessionId };
          return { content: [{ type: "text" as const, text: JSON.stringify(dedupPayload) + `\n\n[code-cache-mcp: duplicate query — result from session cache]` }] };
        }

        const start = Date.now();
        let result = await cache.queryBySymbol(params);

        // Auto-index on miss: search root for all files containing the symbol
        let autoIndexedFiles: string[] = [];
        if (result.total_hits === 0) {
          const searchRoot = params.search_root ? resolve(params.search_root) : process.cwd();
          let filesToIndex: string[] = [];
          if (params.file_path) {
            filesToIndex = [params.file_path];
          } else if (params.symbol) {
            filesToIndex = await findFilesContainingSymbol(params.symbol, searchRoot);
          }
          if (filesToIndex.length > 0) {
            const CONCURRENCY = 4;
            for (let i = 0; i < filesToIndex.length; i += CONCURRENCY) {
              const batch = filesToIndex.slice(i, i + CONCURRENCY);
              await Promise.all(batch.map(p => cache.storeFile(p, {})));
            }
            result = await cache.queryBySymbol(params);
            autoIndexedFiles = filesToIndex;
            // Record each auto-indexed file as a store in metrics
            const storeStart = Date.now();
            for (const fp of filesToIndex) {
              await monitor.record({
                tool: "store_code_context",
                cache_hit: false,
                tokens_saved: 0,
                tokens_used: 0,
                file_path: fp,
                duration_ms: Date.now() - storeStart,
              });
            }
          }
        }

        const grouped = groupHits(result.hits);

        // Log hits to session (with snippet text for future code_snippet lookups)
        await Promise.all(result.hits.map(async hit => {
          const snippet = await fetchSnippet(hit.file_path, hit.start_line, hit.end_line);
          sessionLog.push({ file_path: hit.file_path, start_line: hit.start_line, end_line: hit.end_line, symbol_name: hit.symbol_name, snippet: snippet || undefined, ts: Date.now() });
        }));

        // Auto-persist top hits as ai_locations (fire-and-forget, cross-session memory)
        if (result.total_hits > 0) {
          for (const hit of result.hits.slice(0, 3)) {
            cache.storeAiLocation({
              file_path: hit.file_path,
              start_line: hit.start_line,
              end_line: hit.end_line,
              reason: `auto-recorded: query=${params.symbol ?? params.semantic_query ?? params.pattern ?? params.file_path}`,
              query_text: params.symbol ?? params.semantic_query ?? params.pattern,
            }).catch(() => {});
          }
        }

        // Compute diffs if requested
        const diffRef = params.diff_against
          ?? (params.auto_diff_from_session && sessionLog.length > result.hits.length
            ? sessionLog[sessionLog.length - result.hits.length - 1]
            : undefined);
        if (diffRef) {
          const refSnippet = await fetchSnippet(diffRef.file_path, diffRef.start_line, diffRef.end_line);
          if (refSnippet) {
            const refLabel = `${basename(diffRef.file_path)}:${diffRef.start_line}-${diffRef.end_line}`;
            for (const hit of grouped) {
              const hitEntry = Array.isArray(hit.symbols) ? hit.symbols[0] : hit;
              const lines = (hitEntry.lines as string | undefined)?.split("-");
              const sl = lines ? parseInt(lines[0]) : hit.start_line;
              const el = lines ? parseInt(lines[1]) : hit.end_line;
              if (!sl || !el) continue;
              const hitSnippet = await fetchSnippet(hit.file_path, sl, el);
              if (hitSnippet) {
                const hitLabel = `${basename(hit.file_path)}:${sl}-${el}`;
                hitEntry.diff = computeUnifiedDiff(refSnippet.split("\n"), hitSnippet.split("\n"), refLabel, hitLabel);
              }
            }
          }
        }

        const payload: any = {
          session_id: sessionId,
          total_hits: result.total_hits,
          cache_hit: result.cache_hit,
          tokens_saved_estimate: result.tokens_saved_estimate,
          hits: grouped,
        };
        if (autoIndexedFiles.length > 0) { payload.auto_indexed = true; payload.auto_indexed_files = autoIndexedFiles; }

        // Store in session query cache after first successful query
        queryCache.set(cacheKey, { result: payload, ts: Date.now() });

        const text = JSON.stringify(payload);
        // Truncate very large responses to avoid blowing the context window
        const MAX_RESPONSE_LENGTH = 50000;
        const display = text.length > MAX_RESPONSE_LENGTH
          ? text.slice(0, MAX_RESPONSE_LENGTH) + `\n\n[response truncated at ${MAX_RESPONSE_LENGTH.toLocaleString()} chars; ${result.total_hits} total hits]`
          : text;
        const stats = await cache.getStats();
        const footer = `\n\n[code-cache-mcp: ~${stats.tokens_saved_session.toLocaleString()} tokens saved this session]`;
        const responseContent = { content: [{ type: "text" as const, text: display + footer }] };

        // Fire token counting + metrics async — don't block the response
        tracker.count(text).then(tokensUsed => {
          monitor.record({
            tool: "query_code_cache",
            cache_hit: result.cache_hit,
            tokens_saved: result.tokens_saved_estimate,
            tokens_used: tokensUsed,
            hits_count: result.total_hits,
            symbol: params.symbol,
            file_path: params.file_path,
            duration_ms: Date.now() - start,
          });
        }).catch(() => {});

        return responseContent;
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "store_code_context",
    `Parse a source file using tree-sitter and store the extracted code structure
(classes, methods, fields, inheritance, call graph) in the code cache.
Call this when you encounter a file that is not yet in the cache or when a file has changed.
Subsequent queries via query_code_cache will be served instantly from cache.
Supports Java, TypeScript, JavaScript, and Python.

--- Progressive cache build pattern ---
Call this fire-and-forget (non-blocking, do NOT wait for the result) after every Read of a source file
that is not trivially small. This builds the cache incrementally — at zero user-visible cost — so that
future sessions benefit from cache hits without ever running index_directory.`,
    {
      file_path: z.string().describe("Absolute path to the source file to parse and cache"),
      language: z.enum(["java", "typescript", "python", "go", "auto"]).optional().describe("Language override (default: auto-detect by extension)"),
    },
    async ({ file_path, language }) => {
      try {
        const start = Date.now();
        const result = await cache.storeFile(file_path, {
          language: language === "auto" ? undefined : language
        });
        await monitor.record({
          tool: "store_code_context",
          cache_hit: result.was_cached,
          tokens_saved: 0,
          tokens_used: 0,
          file_path,
          duration_ms: Date.now() - start,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "index_directory",
    `Recursively parse and cache all source files in a directory.
Call this once at the start of a session for a new project to prime the cache.
After indexing, query_code_cache will serve results instantly without file reads.
Supports Java, TypeScript, JavaScript, and Python.
Returns counts of files indexed, symbols extracted, and any errors.`,
    {
      directory: z.string().describe("Absolute path to the directory to index recursively"),
      force: z.boolean().optional().describe("Re-index files even if already cached with same hash (default: false)"),
    },
    async ({ directory, force }) => {
      try {
        const start = Date.now();
        const absDir = resolve(directory);
        if (!existsSync(absDir)) {
          return { content: [{ type: "text" as const, text: `Error: directory not found: ${absDir}` }], isError: true };
        }
        const files = await collectSourceFiles(absDir);
        let filesIndexed = 0;
        let filesSkipped = 0;
        let symbolsTotal = 0;
        const errors: string[] = [];

        const CONCURRENCY = 4;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
          const batch = files.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map(fp => cache.storeFile(fp, {})));
          for (let j = 0; j < results.length; j++) {
            const fp = batch[j];
            const res = results[j];
            if (res.status === "rejected") {
              errors.push(`${fp}: ${(res.reason as any).message}`);
            } else {
              const r = res.value;
              if (r.was_cached && !force) {
                filesSkipped++;
              } else {
                filesIndexed++;
                symbolsTotal += r.symbols_stored;
                await monitor.record({
                  tool: "store_code_context",
                  cache_hit: r.was_cached,
                  tokens_saved: 0,
                  tokens_used: 0,
                  file_path: fp,
                  duration_ms: 0,
                });
              }
            }
          }
        }

        const result = {
          directory: absDir,
          files_found: files.length,
          files_indexed: filesIndexed,
          files_skipped_cached: filesSkipped,
          symbols_extracted: symbolsTotal,
          errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
          duration_ms: Date.now() - start,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "store_ai_location",
    `Record a code position that you have identified as relevant to the current query.
This persists the location so future AI sessions can find the same code faster.
Include a brief reason explaining what this location does or why it is relevant.

--- Progressive cache build pattern ---
Call this fire-and-forget (non-blocking) whenever you identify a code segment relevant to the conversation.
Example: after locating a class definition, record its file and line range with a reason like
"implements the BCD-to-decimal conversion". Over time, get_ai_locations becomes a cross-session memory.`,
    {
      file_path: z.string().describe("Absolute path to the source file"),
      start_line: z.number().describe("Start line of the relevant code (1-based)"),
      end_line: z.number().describe("End line of the relevant code (1-based)"),
      reason: z.string().optional().describe("Why this location is relevant"),
      query_text: z.string().optional().describe("The user question that led to this location"),
    },
    async (params) => {
      try {
        const result = await cache.storeAiLocation(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_ai_locations",
    `Retrieve previously identified code locations.
Call this near the start of a session (before Read/grep) when you need to find code related to a query —
a prior AI session may have already located it. This is the cross-session memory retrieval step of the
progressive cache workflow: store_ai_location in session N → get_ai_locations in session N+1.

Also call this after store_ai_location to verify the data was persisted.`,
    {
      file_path: z.string().optional().describe("Filter locations to a specific file"),
      query_text: z.string().optional().describe("Loose match against stored queries and reasons"),
      session_id: z.string().optional().describe("Limit to locations from a specific session"),
      limit: z.number().optional().describe("Max results (default: 10)"),
    },
    async (params) => {
      try {
        const locations = await cache.getAiLocations(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(locations) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "invalidate_cache",
    `Invalidate cached code structure for specified files.
Call this when you know a file has been modified and the cache may be stale.
The FileWatcher calls this automatically on file changes, but you can call it explicitly if needed.`,
    {
      file_paths: z.array(z.string()).describe("Absolute paths of files to invalidate"),
    },
    async ({ file_paths }) => {
      try {
        const results = await Promise.all(file_paths.map(p => cache.invalidateFile(p)));
        return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "cache_hotness",
    `Check whether the code cache has data worth using. Call this near session start before deciding
which approach to use for code queries.

Returns a clear HOT/COLD signal plus cache statistics. Use the hotness level to decide:

--- Decision guide ---
HOT (50+ files cached):
  query_code_cache will likely return cache hits. Prefer it over Read for files >100 lines
  or when you need inheritance / call graph info.

WARM (1-49 files cached):
  query_code_cache may return partial hits. For the cached files it will be fast.
  For uncached files, it will auto-index on miss + fire-and-forget store. OK to use.

COLD (0 files):
  query_code_cache will always miss and trigger auto-indexing, which is more expensive
  than grep + Read. Use grep/Read directly for this session.
  After each Read, fire-and-forget store_code_context to build cache for next session.
  Consider calling index_directory if working on a large project for many sessions.`,
    {},
    async () => {
      try {
        const stats = await cache.getStats();
        let hotness: string;
        if (stats.files_tracked >= 50) hotness = "HOT";
        else if (stats.files_tracked > 0) hotness = "WARM";
        else hotness = "COLD";
        const text = [
          `code-cache hotness: ${hotness}`,
          `  Session ID:           ${sessionId}`,
          `  Files tracked:        ${stats.files_tracked}`,
          `  Symbols cached:       ${stats.symbols_cached}`,
          `  AI locations stored:  ${stats.ai_locations_stored}`,
          `  Cache hits:           ${stats.cache_hits}`,
          `  Cache misses:         ${stats.cache_misses}`,
          `  Tokens saved (total):   ~${stats.tokens_saved_total.toLocaleString()}`,
          "",
          hotness === "COLD" ? "Recommendation: use grep/Read directly this session. Optionally call index_directory to prime the cache for future sessions." :
          hotness === "WARM" ? "Recommendation: query_code_cache may help for already-cached files. For uncached files, grep/Read is still fine." :
          "Recommendation: cache is hot. Prefer query_code_cache for symbol lookups >100 lines in cached directories.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "cache_clear",
    "Clear all cached code data. Use to reset the cache completely.",
    {},
    async () => {
      try {
        await cache.clear();
        return { content: [{ type: "text" as const, text: "Cache cleared." }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    watcher.close();
    monitor.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
