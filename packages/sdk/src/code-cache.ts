import { readFile } from "fs/promises";
import { resolve } from "path";
import type { CacheConfig, StoreResult, QueryResult, SymbolHit, CacheStats, AiLocation, InvalidateResult } from "./types.js";
import {
  initDb, contentHash, insertFileVersion, getStoredHash,
  insertSymbol, insertAstNode, insertRelationship, insertCallEdge,
  insertAiLocation, deleteByFilePath, resolveParentFks, incrementStat, batchIncrementStats,
  type Db,
} from "./db.js";
import { detectLanguage, getParser, initParsers } from "./parser-registry.js";
import { generateEmbeddings, semanticSearch, embeddingCount } from "./embedder.js";

type SymbolIndexEntry = { id: number; name: string; acronym: string; kind: string; filePath: string };

/** Extract uppercase initials from a camelCase/PascalCase identifier: "UserService" → "us" */
function camelAcronym(name: string): string {
  const letters = name.match(/(?:^[a-z]|[A-Z])/g);
  return letters ? letters.join("").toLowerCase() : "";
}

/** Count newlines without allocating an array (avoids O(n) string objects). */
function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n + 1; // last line has no trailing newline
}

export class CodeCacheStore {
  private db: Db | null = null;
  private dbPath: string;
  private sessionId: string;
  private initialized = false;
  private symbolNameIndex: SymbolIndexEntry[] = [];
  private symbolIndexDirty = true;
  private fileIndexLocks = new Map<string, Promise<StoreResult>>();

  constructor(config: CacheConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.db = await initDb(this.dbPath);
    await initParsers();
    this.initialized = true;
  }

  private getDb(): Db {
    if (!this.db) throw new Error("CodeCacheStore not initialized. Call init() first.");
    return this.db;
  }

  async storeFile(filePath: string, options?: { language?: string }): Promise<StoreResult> {
    await this.init();
    const absPath = resolve(filePath);

    // Dedup concurrent indexing of the same file path
    const existing = this.fileIndexLocks.get(absPath);
    if (existing) {
      const result = await existing;
      // If the other request already indexed this file with the same content, return cached
      const db = this.getDb();
      const source = await readFile(absPath, "utf-8");
      const hash = contentHash(source);
      const storedHash = await getStoredHash(db, absPath);
      if (storedHash === hash) {
        return { ...result, was_cached: true };
      }
      // File changed since the other request locked — proceed to re-index
    }

    const promise = this._doStoreFile(absPath, options);
    this.fileIndexLocks.set(absPath, promise);
    try {
      return await promise;
    } finally {
      this.fileIndexLocks.delete(absPath);
    }
  }

  private async _doStoreFile(absPath: string, options?: { language?: string }): Promise<StoreResult> {
    const db = this.getDb();
    const source = await readFile(absPath, "utf-8");
    const hash = contentHash(source);
    const lines = countLines(source);

    const language = options?.language ?? detectLanguage(absPath) ?? "unknown";
    if (language === "unknown") {
      return { file_path: absPath, language, symbols_stored: 0, classes_found: 0, methods_found: 0, relationships_stored: 0, call_edges_stored: 0, was_cached: false, hash };
    }

    // Check if already cached with same hash
    const storedHash = await getStoredHash(db, absPath);
    if (storedHash === hash) {
      return { file_path: absPath, language, symbols_stored: 0, classes_found: 0, methods_found: 0, relationships_stored: 0, call_edges_stored: 0, was_cached: true, hash };
    }

    // Parse first (CPU-heavy, do it outside DB transaction).
    // If parsing fails, old cache is preserved — no data loss.
    const parser = await getParser(language);
    if (!parser) {
      return { file_path: absPath, language, symbols_stored: 0, classes_found: 0, methods_found: 0, relationships_stored: 0, call_edges_stored: 0, was_cached: false, hash };
    }

    const parseResult = parser.parse(source, absPath);

    // All DB writes in one transaction — includes old data invalidation.
    // Concurrent queries see either pre-transaction (old) or post-commit (new),
    // never empty.
    await db.exec("BEGIN");
    const idxToId = new Map<number, number>();
    try {
      // Invalidate old data INSIDE the transaction, before inserting new
      if (storedHash) {
        await deleteByFilePath(db, absPath);
      }

      await insertFileVersion(db, absPath, hash, language, lines);

      // Insert symbols — track index→DB id mapping for relationships and call edges
      for (let i = 0; i < parseResult.symbols.length; i++) {
        const sym = parseResult.symbols[i];
        let parentDbId: number | undefined;
        if (sym.parent_id !== undefined) {
          parentDbId = idxToId.get(sym.parent_id);
        }
        const id = await insertSymbol(db, { ...sym, file_hash: hash, parent_id: parentDbId });
        idxToId.set(i, id);
      }

      for (const rel of parseResult.relationships) {
        const childId = idxToId.get(rel.child_symbol_id as unknown as number);
        if (childId === undefined) continue;
        await insertRelationship(db, { ...rel, child_symbol_id: childId });
      }

      for (const edge of parseResult.callEdges) {
        const callerId = idxToId.get(edge.caller_id as unknown as number);
        if (callerId === undefined) continue;
        await insertCallEdge(db, { ...edge, caller_id: callerId });
      }

      await resolveParentFks(db, absPath);
      await db.exec("COMMIT");
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }

    await batchIncrementStats(db, this.sessionId, { files_parsed: 1 });

    const classCount = parseResult.symbols.filter(s => ["class", "interface", "enum", "record"].includes(s.symbol_kind)).length;
    const methodCount = parseResult.symbols.filter(s => ["method", "constructor", "function"].includes(s.symbol_kind)).length;

    // Generate embeddings asynchronously — don't await, never block storeFile
    const newSymbolRows = await db.prepare(
      "SELECT id, symbol_kind, symbol_name, signature FROM symbols WHERE file_path = ? AND file_hash = ?"
    ).all(absPath, hash) as any[];
    this.symbolIndexDirty = true;
    generateEmbeddings(db, newSymbolRows).catch(() => {});

    return {
      file_path: absPath,
      language,
      symbols_stored: parseResult.symbols.length,
      classes_found: classCount,
      methods_found: methodCount,
      relationships_stored: parseResult.relationships.length,
      call_edges_stored: parseResult.callEdges.length,
      was_cached: false,
      hash,
    };
  }

  async queryBySymbol(params: {
    symbol?: string;
    file_path?: string;
    pattern?: string;
    semantic_query?: string;
    kinds?: string[];
    include_ast?: boolean;
    include_relationships?: boolean;
    limit?: number;
  }): Promise<QueryResult> {
    await this.init();
    const db = this.getDb();
    const limit = params.limit ?? 20;

    // ── Semantic search path ────────────────────────────────────────────────
    let semanticScores = new Map<number, number>(); // symbol_id → score
    if (params.semantic_query) {
      const semHits = await semanticSearch(db, params.semantic_query, limit, 0.3);
      for (const h of semHits) semanticScores.set(h.symbol_id, h.score);
    }

    // ── Lexical search path ─────────────────────────────────────────────────
    let rows: any[] = [];

    if (params.semantic_query && !params.symbol && !params.pattern && !params.file_path) {
      // Pure semantic — fetch symbol rows for the top-K IDs directly
      if (semanticScores.size > 0) {
        const ids = [...semanticScores.keys()];
        const placeholders = ids.map(() => "?").join(",");
        let semSql = `SELECT * FROM symbols WHERE id IN (${placeholders})`;
        if (params.kinds && params.kinds.length > 0) {
          semSql += ` AND symbol_kind IN (${params.kinds.map(() => "?").join(",")})`;
          rows = await db.prepare(semSql).all(...ids, ...params.kinds);
        } else {
          rows = await db.prepare(semSql).all(...ids);
        }
      }
    } else {
      // ── symbol search: use in-memory index to avoid LIKE full-scan ──────────
      if (params.symbol) {
        if (this.symbolIndexDirty) {
          const indexRows = await db.prepare(
            "SELECT id, symbol_name, symbol_kind, file_path FROM symbols"
          ).all();
          this.symbolNameIndex = (indexRows as any[]).map(r => ({
            id: r.id as number,
            name: (r.symbol_name as string).toLowerCase(),
            acronym: camelAcronym(r.symbol_name as string),
            kind: r.symbol_kind as string,
            filePath: r.file_path as string,
          }));
          this.symbolIndexDirty = false;
        }

        const queryLower = params.symbol.toLowerCase();
        const absFilePath = params.file_path ? resolve(params.file_path) : null;
        const kindSet = params.kinds?.length ? new Set(params.kinds) : null;

        const matchedIds = this.symbolNameIndex
          .filter(e =>
            (e.name.includes(queryLower) || e.acronym === queryLower) &&
            (!absFilePath || e.filePath === absFilePath) &&
            (!kindSet || kindSet.has(e.kind))
          )
          .slice(0, limit)
          .map(e => e.id);

        if (matchedIds.length > 0) {
          const ph = matchedIds.map(() => "?").join(",");
          rows = await db.prepare(`SELECT * FROM symbols WHERE id IN (${ph})`).all(...matchedIds);
        }
      } else {
        // pattern / file_path only — fall through to SQL
        let sql = "SELECT * FROM symbols WHERE 1=1";
        const args: any[] = [];

        if (params.file_path) {
          sql += " AND file_path = ?";
          args.push(resolve(params.file_path));
        }
        if (params.pattern) {
          sql += " AND symbol_name LIKE ?";
          args.push(`%${params.pattern}%`);
        }
        if (params.kinds && params.kinds.length > 0) {
          sql += ` AND symbol_kind IN (${params.kinds.map(() => "?").join(",")})`;
          args.push(...params.kinds);
        }
        sql += " LIMIT ?";
        args.push(limit);
        rows = await db.prepare(sql).all(...args);
      }

      // If semantic_query also provided, merge additional semantic hits not already in lexical results
      if (params.semantic_query && semanticScores.size > 0) {
        const existingIds = new Set(rows.map((r: any) => r.id as number));
        const extraIds = [...semanticScores.keys()].filter(id => !existingIds.has(id));
        if (extraIds.length > 0) {
          const ph = extraIds.map(() => "?").join(",");
          const extraRows = await db.prepare(`SELECT * FROM symbols WHERE id IN (${ph})`).all(...extraIds);
          rows = [...rows, ...extraRows].slice(0, limit);
        }
      }
    }

    // Sort: semantic score first (if available), then lexical order
    if (semanticScores.size > 0) {
      rows.sort((a: any, b: any) => {
        const sa = semanticScores.get(a.id) ?? 0;
        const sb = semanticScores.get(b.id) ?? 0;
        return sb - sa;
      });
    }

    // ── Batch-fetch all enrichment data upfront (eliminates N+1 queries) ──────
    const rowIds = rows.map((r: any) => r.id as number);
    const parentIds = [...new Set(rows.map((r: any) => r.parent_id as number | null).filter((id): id is number => id != null))];

    // Batch: parent names
    const parentNameMap = new Map<number, string>();
    if (parentIds.length > 0) {
      const ph = parentIds.map(() => "?").join(",");
      const parentRows = await db.prepare(`SELECT id, symbol_name FROM symbols WHERE id IN (${ph})`).all(...parentIds);
      for (const p of parentRows as any[]) parentNameMap.set(p.id as number, p.symbol_name as string);
    }

    // Batch: AST nodes (only if requested)
    const astMap = new Map<number, any>();
    if (params.include_ast && rowIds.length > 0) {
      const ph = rowIds.map(() => "?").join(",");
      const astRows = await db.prepare(`SELECT * FROM ast_nodes WHERE symbol_id IN (${ph})`).all(...rowIds);
      for (const a of astRows as any[]) {
        if (!astMap.has(a.symbol_id)) {
          astMap.set(a.symbol_id as number, a.ast_json ? JSON.parse(a.ast_json) : { node_type: a.node_type });
        }
      }
    }

    // Batch: relationships, callers, callees (only if requested)
    const relMap = new Map<number, { type: "extends" | "implements"; target: string }[]>();
    const callersMap = new Map<number, { symbol: string; line: number }[]>();
    const calleesMap = new Map<number, { name: string; line: number }[]>();

    if (params.include_relationships && rowIds.length > 0) {
      const ph = rowIds.map(() => "?").join(",");

      const relRows = await db.prepare(
        `SELECT child_symbol_id, parent_name, relationship FROM class_relationships WHERE child_symbol_id IN (${ph})`
      ).all(...rowIds);
      for (const r of relRows as any[]) {
        const id = r.child_symbol_id as number;
        if (!relMap.has(id)) relMap.set(id, []);
        relMap.get(id)!.push({ type: r.relationship as "extends" | "implements", target: r.parent_name as string });
      }

      // Callers by resolved callee_id
      const callerRowsById = await db.prepare(
        `SELECT ce.callee_id, s.symbol_name AS caller_name, ce.call_line
         FROM call_edges ce JOIN symbols s ON s.id = ce.caller_id
         WHERE ce.callee_id IN (${ph})`
      ).all(...rowIds);

      // Callers by unresolved callee_name (dangling FK edges)
      const symbolNames = [...new Set(rows.map((r: any) => r.symbol_name as string))];
      const namePh = symbolNames.map(() => "?").join(",");
      const callerRowsByName = await db.prepare(
        `SELECT ce.callee_name, s.symbol_name AS caller_name, ce.call_line
         FROM call_edges ce JOIN symbols s ON s.id = ce.caller_id
         WHERE ce.callee_name IN (${namePh})`
      ).all(...symbolNames);

      // Build callee_name → symbol_id map from current rows for dedup
      const nameToIds = new Map<string, number[]>();
      for (const r of rows as any[]) {
        if (!nameToIds.has(r.symbol_name)) nameToIds.set(r.symbol_name, []);
        nameToIds.get(r.symbol_name)!.push(r.id as number);
      }

      for (const r of callerRowsById as any[]) {
        const id = r.callee_id as number;
        if (!callersMap.has(id)) callersMap.set(id, []);
        callersMap.get(id)!.push({ symbol: r.caller_name as string, line: r.call_line as number });
      }
      for (const r of callerRowsByName as any[]) {
        const ids = nameToIds.get(r.callee_name as string) ?? [];
        for (const id of ids) {
          if (!callersMap.has(id)) callersMap.set(id, []);
          const existing = callersMap.get(id)!;
          const key = `${r.caller_name}:${r.call_line}`;
          if (!existing.some(e => `${e.symbol}:${e.line}` === key)) {
            existing.push({ symbol: r.caller_name as string, line: r.call_line as number });
          }
        }
      }

      const calleeRows = await db.prepare(
        `SELECT ce.caller_id, ce.callee_name, ce.call_line, s.file_path AS callee_file_path
         FROM call_edges ce LEFT JOIN symbols s ON s.id = ce.callee_id
         WHERE ce.caller_id IN (${ph})`
      ).all(...rowIds);
      for (const c of calleeRows as any[]) {
        const id = c.caller_id as number;
        if (!calleesMap.has(id)) calleesMap.set(id, []);
        const entry: { name: string; line: number; file_path?: string } = { name: c.callee_name as string, line: c.call_line as number };
        if (c.callee_file_path) entry.file_path = c.callee_file_path as string;
        calleesMap.get(id)!.push(entry);
      }
    }

    const hits: SymbolHit[] = [];
    let tokensSaved = 0;

    for (const row of rows) {
      const hit: SymbolHit = {
        symbol_name: row.symbol_name,
        symbol_kind: row.symbol_kind,
        file_path: row.file_path,
        start_line: row.start_line,
        end_line: row.end_line,
        ...(semanticScores.has(row.id) ? { semantic_score: semanticScores.get(row.id) } : {}),
      };

      if (row.parent_id) hit.parent_symbol = parentNameMap.get(row.parent_id);

      if (params.include_ast) hit.ast = astMap.get(row.id);

      if (params.include_relationships) {
        hit.relationships = relMap.get(row.id) ?? [];
        hit.callers = callersMap.get(row.id) ?? [];
        hit.callees = calleesMap.get(row.id) ?? [];
      }

      tokensSaved += (row.end_line - row.start_line + 1) * 30;
      hits.push(hit);
    }

    const cacheHit = hits.length > 0;
    if (cacheHit) {
      await batchIncrementStats(db, this.sessionId, { cache_hits: 1, tokens_saved: tokensSaved });
    } else {
      await batchIncrementStats(db, this.sessionId, { cache_misses: 1 });
    }

    return { hits, total_hits: hits.length, cache_hit: cacheHit, tokens_saved_estimate: tokensSaved };
  }

  async storeAiLocation(params: {
    file_path: string;
    start_line: number;
    end_line: number;
    reason?: string;
    query_text?: string;
  }): Promise<{ location_id: number; symbol_name?: string; stored: true }> {
    await this.init();
    const db = this.getDb();
    const absPath = resolve(params.file_path);

    let fileHash = "";
    try {
      const source = await readFile(absPath, "utf-8");
      fileHash = contentHash(source);
    } catch { /* file may not exist */ }

    // Find enclosing symbol
    const enclosing = await db.prepare(
      `SELECT id, symbol_name FROM symbols
       WHERE file_path = ? AND start_line <= ? AND end_line >= ?
       ORDER BY (end_line - start_line) ASC LIMIT 1`
    ).all(absPath, params.start_line, params.end_line);

    const symbolId = enclosing.length > 0 ? (enclosing[0] as any).id : undefined;
    const symbolName = enclosing.length > 0 ? (enclosing[0] as any).symbol_name : undefined;

    const loc: AiLocation = {
      session_id: this.sessionId,
      file_path: absPath,
      file_hash: fileHash,
      start_line: params.start_line,
      end_line: params.end_line,
      symbol_id: symbolId,
      reason: params.reason,
      query_text: params.query_text,
      located_at: Date.now(),
    };

    const id = await insertAiLocation(db, loc);
    return { location_id: id, symbol_name: symbolName, stored: true };
  }

  async getAiLocations(params: {
    file_path?: string;
    query_text?: string;
    session_id?: string;
    limit?: number;
  }): Promise<AiLocation[]> {
    await this.init();
    const db = this.getDb();
    const limit = params.limit ?? 10;

    let sql = "SELECT * FROM ai_locations WHERE 1=1";
    const args: any[] = [];

    if (params.file_path) {
      sql += " AND file_path = ?";
      args.push(resolve(params.file_path));
    }
    if (params.session_id) {
      sql += " AND session_id = ?";
      args.push(params.session_id);
    }
    if (params.query_text) {
      sql += " AND (query_text LIKE ? OR reason LIKE ?)";
      args.push(`%${params.query_text}%`, `%${params.query_text}%`);
    }
    sql += " ORDER BY located_at DESC LIMIT ?";
    args.push(limit);

    return (await db.prepare(sql).all(...args)) as AiLocation[];
  }

  async invalidateFile(filePath: string): Promise<InvalidateResult> {
    await this.init();
    const db = this.getDb();
    const absPath = resolve(filePath);
    const removed = await deleteByFilePath(db, absPath);
    this.symbolIndexDirty = true;
    return { file_path: absPath, symbols_removed: removed };
  }

  async getStats(): Promise<CacheStats> {
    await this.init();
    const db = this.getDb();

    const [files, symbols, aiLocs, hits, misses, tokens, sessionTokens, embCount] = await Promise.all([
      db.prepare("SELECT COUNT(DISTINCT path) as c FROM file_versions").all(),
      db.prepare("SELECT COUNT(*) as c FROM symbols").all(),
      db.prepare("SELECT COUNT(*) as c FROM ai_locations").all(),
      db.prepare("SELECT value FROM stats WHERE key = 'cache_hits'").all(),
      db.prepare("SELECT value FROM stats WHERE key = 'cache_misses'").all(),
      db.prepare("SELECT value FROM stats WHERE key = 'tokens_saved'").all(),
      db.prepare("SELECT value FROM session_stats WHERE session_id = ? AND key = 'tokens_saved'").all(this.sessionId),
      embeddingCount(db),
    ]);

    return {
      files_tracked: (files[0] as any).c,
      symbols_cached: (symbols[0] as any).c,
      ai_locations_stored: (aiLocs[0] as any).c,
      cache_hits: hits.length > 0 ? (hits[0] as any).value : 0,
      cache_misses: misses.length > 0 ? (misses[0] as any).value : 0,
      tokens_saved_total: tokens.length > 0 ? (tokens[0] as any).value : 0,
      tokens_saved_session: sessionTokens.length > 0 ? (sessionTokens[0] as any).value : 0,
      embeddings_count: embCount as number,
    };
  }

  async clear(): Promise<void> {
    await this.init();
    const db = this.getDb();
    await db.exec(`
      DELETE FROM ai_locations;
      DELETE FROM call_edges;
      DELETE FROM class_relationships;
      DELETE FROM ast_nodes;
      DELETE FROM symbol_embeddings;
      DELETE FROM symbols WHERE parent_id IS NOT NULL;
      DELETE FROM symbols;
      DELETE FROM file_versions;
      DELETE FROM session_stats;
      UPDATE stats SET value = 0;
    `);
    this.symbolNameIndex = [];
    this.symbolIndexDirty = true;
    this.fileIndexLocks.clear();
  }

  async onFileChanged(filePath: string): Promise<void> {
    // Invalidate cache immediately so stale data is never served.
    // If re-index fails, cache stays empty — callers read the file directly.
    // Empty results are safer than stale results.
    await this.invalidateFile(filePath);
    try {
      await this.storeFile(filePath);
    } catch { /* ignore — cache stays empty, next query auto-indexes */ }
  }

  async onFileDeleted(filePath: string): Promise<void> {
    await this.invalidateFile(filePath);
  }

  /** @internal test only — force symbol index rebuild on next query */
  _forceSymbolIndexDirty(): void { this.symbolIndexDirty = true; }
}
