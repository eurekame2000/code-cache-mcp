import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, extname, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";

const SOURCE_EXTENSIONS = new Set([".java", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".py", ".go", ".rs"]);
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

function getCacheDir(): string {
  const dir = resolve(process.env.CODE_CACHE_DIR ?? ".code-cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function startMcpServer(): Promise<void> {
  const cacheDir = getCacheDir();
  const dbPath = resolve(cacheDir, "code-cache.db");

  // Lazy imports — don't load SDK until first tool call
  const { CodeCacheStore } = await import("@code-cache/sdk");
  const cache = new CodeCacheStore({ dbPath });
  await cache.init();

  // Lazy watcher — start on first store/query, not at startup
  let watcherStarted = false;
  async function ensureWatcher() {
    if (watcherStarted) return;
    watcherStarted = true;
    const { FileWatcher } = await import("@code-cache/sdk");
    const watcher = new FileWatcher(cache);
    watcher.watch([process.cwd()]);
  }

  // Cold-start auto-index: if cache is empty, index cwd in background
  cache.getStats().then(stats => {
    if (stats.files_tracked === 0) {
      const absDir = process.cwd();
      collectSourceFiles(absDir).then(files => {
        if (files.length === 0) return;
        const CONCURRENCY = 4;
        (async () => {
          for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            await Promise.allSettled(batch.map(fp => cache.storeFile(fp, {})));
          }
        })().catch(() => {});
      });
    }
  }).catch(() => {});

  const server = new McpServer({ name: "code-cache-mcp", version: "0.2.0" });

  // ─── Tool 1: query ────────────────────────────────────────────────
  server.tool(
    "query_code_cache",
    `FAST symbol lookup: returns file:line + class hierarchy + call graph. Call this BEFORE Read.
On cache miss, auto-indexes the file and retries — no manual setup needed.`,
    {
      symbol: z.string().optional().describe("Symbol name (partial match, e.g. 'UserService')"),
      file_path: z.string().optional().describe("Filter to one file (absolute path)"),
      kinds: z.array(z.enum(["class", "interface", "enum", "method", "function", "field", "constructor", "record", "variable"])).optional().describe("Filter by symbol kind"),
      include_relationships: z.boolean().optional().describe("Include inheritance and call graph (default: true)"),
    },
    async (params) => {
      try {
        await ensureWatcher();

        if (!params.symbol && !params.file_path) {
          return { content: [{ type: "text" as const, text: "Error: provide at least 'symbol' or 'file_path'." }], isError: true };
        }

        const start = Date.now();
        const includeRels = params.include_relationships !== false; // default true

        let result = await cache.queryBySymbol({
          symbol: params.symbol,
          file_path: params.file_path,
          kinds: params.kinds,
          include_relationships: includeRels,
          include_ast: false,
        });

        // Auto-index on miss: search for files containing the symbol
        let autoIndexed = false;
        if (result.total_hits === 0 && params.symbol) {
          const searchRoot = process.cwd();
          const filesToIndex = await findFilesContainingSymbol(params.symbol, searchRoot);
          if (filesToIndex.length > 0) {
            const CONCURRENCY = 4;
            for (let i = 0; i < filesToIndex.length; i += CONCURRENCY) {
              const batch = filesToIndex.slice(i, i + CONCURRENCY);
              await Promise.all(batch.map(p => cache.storeFile(p, {})));
            }
            result = await cache.queryBySymbol({
              symbol: params.symbol,
              file_path: params.file_path,
              kinds: params.kinds,
              include_relationships: includeRels,
              include_ast: false,
            });
            autoIndexed = true;
          }
        }

        // Auto-persist top hits as ai_locations (fire-and-forget)
        if (result.total_hits > 0) {
          for (const hit of result.hits.slice(0, 3)) {
            cache.storeAiLocation({
              file_path: hit.file_path,
              start_line: hit.start_line,
              end_line: hit.end_line,
              reason: `auto: query=${params.symbol ?? params.file_path}`,
              query_text: params.symbol,
            }).catch(() => {});
          }
        }

        // Build lightweight response
        const hits = result.hits.map(h => {
          const entry: any = {
            name: h.symbol_name,
            kind: h.symbol_kind,
            position: `${h.file_path}:${h.start_line}`,
            lines: `${h.start_line}-${h.end_line}`,
          };
          if (h.parent_symbol) entry.parent = h.parent_symbol;
          if (includeRels && h.relationships?.length) entry.relationships = h.relationships;
          if (includeRels && h.callers?.length) entry.callers = h.callers;
          if (includeRels && h.callees?.length) entry.callees = h.callees;
          return entry;
        });

        const payload: any = {
          hits,
          total: result.total_hits,
          cached: result.cache_hit,
        };
        if (autoIndexed) payload.auto_indexed = true;

        // Attach hotness
        const stats = await cache.getStats();
        const hotness = stats.files_tracked >= 50 ? "HOT" : stats.files_tracked > 0 ? "WARM" : "COLD";
        payload.hotness = hotness;
        payload.files_cached = stats.files_tracked;
        payload.symbols_cached = stats.symbols_cached;

        // Teaching tip on cache hit — positive reinforcement
        if (result.cache_hit && result.total_hits > 0) {
          payload.tip = `${result.total_hits} symbol(s) found via cache. Use Read with offset/limit for the specific line ranges above.`;
        }

        const text = JSON.stringify(payload);

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ─── Tool 2: store ────────────────────────────────────────────────
  server.tool(
    "store_code_context",
    `Parse a source file and cache its structure. Call after Read to build cache for future sessions.`,
    {
      file_path: z.string().describe("Absolute path to the source file to parse and cache"),
      language: z.enum(["java", "typescript", "python", "go", "rust", "auto"]).optional().describe("Language override (default: auto-detect by extension)"),
    },
    async ({ file_path, language }) => {
      try {
        await ensureWatcher();
        const result = await cache.storeFile(file_path, {
          language: language === "auto" ? undefined : language
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ stored: !result.was_cached, cached: result.was_cached, symbols: result.symbols_stored, file: result.file_path }) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ─── Tool 3: index ────────────────────────────────────────────────
  server.tool(
    "index_directory",
    `Index all source files in a directory. Call once for new projects to prime the cache.`,
    {
      directory: z.string().describe("Absolute path to the directory to index recursively"),
      force: z.boolean().optional().describe("Re-index files even if already cached with same hash (default: false)"),
    },
    async ({ directory, force }) => {
      try {
        await ensureWatcher();
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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
