import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, basename, extname } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { CodeCacheStore, FileWatcher, MetricsMonitor, TokenTracker } from "@code-cache/sdk";

const SOURCE_EXTENSIONS = new Set([".java", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".py", ".go"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".code-cache", "dist", "build", "target", "__pycache__"]);

/** Walk root, return all source files whose filename or content contains symbol. */
function findFilesContainingSymbol(symbol: string, root: string, maxFiles = 100): string[] {
  const found: string[] = [];
  const lower = symbol.toLowerCase();
  const queue = [root];
  while (queue.length > 0 && found.length < maxFiles) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = `${dir}/${entry}`;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { queue.push(full); continue; }
      const ext = extname(entry);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      const stem = basename(entry, ext);
      if (stem === symbol || stem.toLowerCase() === lower) {
        found.push(full);
      } else {
        try {
          const content = readFileSync(full, "utf-8");
          if (content.includes(symbol)) found.push(full);
        } catch { /* skip unreadable */ }
      }
      if (found.length >= maxFiles) break;
    }
  }
  return found;
}

/** Walk root, return all source files. */
function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = `${dir}/${entry}`;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { queue.push(full); continue; }
      if (SOURCE_EXTENSIONS.has(extname(entry))) files.push(full);
    }
  }
  return files;
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
For best results on a new project, call index_directory first.`,
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
    },
    async (params) => {
      try {
        if (!params.symbol && !params.file_path && !params.pattern && !params.semantic_query) {
          return { content: [{ type: "text" as const, text: "Error: at least one of symbol, file_path, pattern, or semantic_query is required." }], isError: true };
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
            filesToIndex = findFilesContainingSymbol(params.symbol, searchRoot);
          }
          if (filesToIndex.length > 0) {
            await Promise.all(filesToIndex.map(p => cache.storeFile(p, {})));
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
        const payload: any = {
          total_hits: result.total_hits,
          cache_hit: result.cache_hit,
          tokens_saved_estimate: result.tokens_saved_estimate,
          hits: grouped,
        };
        if (autoIndexedFiles.length > 0) { payload.auto_indexed = true; payload.auto_indexed_files = autoIndexedFiles; }
        const text = JSON.stringify(payload, null, 2);
        // tokens_used = accurate API count when ANTHROPIC_API_KEY is set, else chars/4 estimate
        const tokensUsed = await tracker.count(text);
        await monitor.record({
          tool: "query_code_cache",
          cache_hit: result.cache_hit,
          tokens_saved: result.tokens_saved_estimate,
          tokens_used: tokensUsed,
          hits_count: result.total_hits,
          symbol: params.symbol,
          file_path: params.file_path,
          duration_ms: Date.now() - start,
        });
        const stats = await cache.getStats();
        const footer = `\n\n[code-cache-mcp: ~${stats.tokens_saved_session.toLocaleString()} tokens saved this session]`;
        return { content: [{ type: "text" as const, text: text + footer }] };
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
Supports Java, TypeScript, JavaScript, and Python.`,
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
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
        const files = collectSourceFiles(absDir);
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
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "store_ai_location",
    `Record a code position that you have identified as relevant to the current query.
This persists the location so future AI sessions can find the same code faster.
Include a brief reason explaining what this location does or why it is relevant.`,
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
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_ai_locations",
    `Retrieve previously identified code locations.
Call this at the start of a session when you need to find code related to a query —
a prior AI session may have already located it.`,
    {
      file_path: z.string().optional().describe("Filter locations to a specific file"),
      query_text: z.string().optional().describe("Loose match against stored queries and reasons"),
      session_id: z.string().optional().describe("Limit to locations from a specific session"),
      limit: z.number().optional().describe("Max results (default: 10)"),
    },
    async (params) => {
      try {
        const locations = await cache.getAiLocations(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(locations, null, 2) }] };
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
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "cache_stats",
    `Show code cache statistics: files tracked, symbols cached, AI locations stored, cache hits/misses, tokens saved.`,
    {},
    async () => {
      try {
        const stats = await cache.getStats();
        const text = [
          "code-cache-mcp stats:",
          `  Files tracked:        ${stats.files_tracked}`,
          `  Symbols cached:       ${stats.symbols_cached}`,
          `  Embeddings stored:    ${stats.embeddings_count}`,
          `  AI locations stored:  ${stats.ai_locations_stored}`,
          `  Cache hits:           ${stats.cache_hits}`,
          `  Cache misses:         ${stats.cache_misses}`,
          `  Tokens saved (session): ~${stats.tokens_saved_session.toLocaleString()}`,
          `  Tokens saved (total):   ~${stats.tokens_saved_total.toLocaleString()}`,
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

  process.on("SIGINT", async () => {
    watcher.close();
    await monitor.close();
    process.exit(0);
  });
}
