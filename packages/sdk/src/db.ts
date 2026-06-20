import { connect } from "@tursodatabase/database";
import { createHash } from "crypto";
import type {
  SymbolRow, AstNodeRow, ClassRelationship, CallEdge, AiLocation
} from "./types.js";

export type Db = Awaited<ReturnType<typeof connect>>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_versions (
  path      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  language  TEXT NOT NULL,
  lines     INTEGER NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (path, hash)
);

CREATE INDEX IF NOT EXISTS idx_fv_path ON file_versions(path);

CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path      TEXT NOT NULL,
  file_hash      TEXT NOT NULL,
  language       TEXT NOT NULL,
  symbol_name    TEXT NOT NULL,
  symbol_kind    TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  parent_id      INTEGER,
  signature      TEXT,
  FOREIGN KEY (parent_id) REFERENCES symbols(id)
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path, file_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(symbol_kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);

CREATE TABLE IF NOT EXISTS ast_nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id  INTEGER NOT NULL,
  node_type  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  start_col  INTEGER NOT NULL,
  end_col    INTEGER NOT NULL,
  ast_json   TEXT,
  FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ast_nodes_symbol ON ast_nodes(symbol_id);

CREATE TABLE IF NOT EXISTS class_relationships (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  child_symbol_id  INTEGER NOT NULL,
  parent_name      TEXT NOT NULL,
  parent_symbol_id INTEGER,
  relationship     TEXT NOT NULL,
  FOREIGN KEY (child_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cr_child ON class_relationships(child_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cr_parent_name ON class_relationships(parent_name);
CREATE INDEX IF NOT EXISTS idx_cr_parent_id ON class_relationships(parent_symbol_id);

CREATE TABLE IF NOT EXISTS call_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id   INTEGER NOT NULL,
  callee_name TEXT NOT NULL,
  callee_id   INTEGER,
  call_line   INTEGER NOT NULL,
  FOREIGN KEY (caller_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (callee_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ce_caller ON call_edges(caller_id);
CREATE INDEX IF NOT EXISTS idx_ce_callee_name ON call_edges(callee_name);

CREATE TABLE IF NOT EXISTS ai_locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  file_hash  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  symbol_id  INTEGER,
  reason     TEXT,
  query_text TEXT,
  located_at INTEGER NOT NULL,
  FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ail_session ON ai_locations(session_id);
CREATE INDEX IF NOT EXISTS idx_ail_file ON ai_locations(file_path);
CREATE INDEX IF NOT EXISTS idx_ail_located_at ON ai_locations(located_at DESC);

CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id  INTEGER PRIMARY KEY,
  embedding  TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, key)
);

INSERT OR IGNORE INTO stats(key, value) VALUES
  ('tokens_saved', 0),
  ('cache_hits', 0),
  ('cache_misses', 0),
  ('files_parsed', 0);
`;

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function initDb(dbPath: string): Promise<Db> {
  const db = await connect(dbPath, { experimental: ["multiprocess_wal"] });
  // Must be set per-connection — SQLite default is OFF, CASCADE DELETE won't fire without it
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec(SCHEMA);
  // Migrate old DBs that stored raw code
  try { await db.exec("ALTER TABLE file_versions DROP COLUMN content"); } catch { /* already gone or new DB */ }
  try { await db.exec("ALTER TABLE symbols DROP COLUMN source_snippet"); } catch { /* already gone or new DB */ }
  // Add signature column to symbols for pre-existing DBs (nullable, old rows safe)
  try { await db.exec("ALTER TABLE symbols ADD COLUMN signature TEXT"); } catch { /* already present or new DB */ }
  // Clean up orphan rows left by prior runs where foreign_keys was OFF
  await db.exec(`
    DELETE FROM symbol_embeddings WHERE symbol_id NOT IN (SELECT id FROM symbols);
    DELETE FROM class_relationships WHERE child_symbol_id NOT IN (SELECT id FROM symbols);
  `);
  return db;
}

export async function insertFileVersion(
  db: Db,
  path: string,
  hash: string,
  language: string,
  lines: number,
): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO file_versions (path, hash, language, lines, cached_at) VALUES (?, ?, ?, ?, ?)"
  ).run(path, hash, language, lines, Date.now());
}

export async function getStoredHash(db: Db, path: string): Promise<string | null> {
  const rows = await db.prepare(
    "SELECT hash FROM file_versions WHERE path = ? ORDER BY cached_at DESC LIMIT 1"
  ).all(path);
  return rows.length > 0 ? (rows[0] as any).hash as string : null;
}

export async function insertSymbol(db: Db, sym: SymbolRow): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO symbols (file_path, file_hash, language, symbol_name, symbol_kind, start_line, end_line, parent_id, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sym.file_path, sym.file_hash, sym.language, sym.symbol_name, sym.symbol_kind,
    sym.start_line, sym.end_line, sym.parent_id ?? null, sym.signature ?? null
  );
  const id = (result as any).lastInsertRowid as number;
  return id;
}

export async function insertAstNode(db: Db, node: AstNodeRow): Promise<void> {
  await db.prepare(
    `INSERT INTO ast_nodes (symbol_id, node_type, start_line, end_line, start_col, end_col, ast_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    node.symbol_id, node.node_type, node.start_line, node.end_line,
    node.start_col, node.end_col, node.ast_json ?? null
  );
}

export async function insertRelationship(db: Db, rel: ClassRelationship): Promise<void> {
  await db.prepare(
    `INSERT INTO class_relationships (child_symbol_id, parent_name, parent_symbol_id, relationship)
     VALUES (?, ?, ?, ?)`
  ).run(rel.child_symbol_id, rel.parent_name, rel.parent_symbol_id ?? null, rel.relationship);
}

export async function insertCallEdge(db: Db, edge: CallEdge): Promise<void> {
  await db.prepare(
    `INSERT INTO call_edges (caller_id, callee_name, callee_id, call_line)
     VALUES (?, ?, ?, ?)`
  ).run(edge.caller_id, edge.callee_name, edge.callee_id ?? null, edge.call_line);
}

export async function insertAiLocation(db: Db, loc: AiLocation): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO ai_locations (session_id, file_path, file_hash, start_line, end_line, symbol_id, reason, query_text, located_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    loc.session_id, loc.file_path, loc.file_hash, loc.start_line, loc.end_line,
    loc.symbol_id ?? null, loc.reason ?? null, loc.query_text ?? null, loc.located_at
  );
  return (result as any).lastInsertRowid as number;
}

export async function deleteByFilePath(db: Db, filePath: string): Promise<number> {
  // NULL out nullable FK references before deleting — required for both old DBs (no ON DELETE SET NULL)
  // and as a safety net for existing tables that predate the schema fix
  await db.prepare(
    `UPDATE class_relationships SET parent_symbol_id = NULL
     WHERE parent_symbol_id IN (SELECT id FROM symbols WHERE file_path = ?)`
  ).run(filePath);
  await db.prepare(
    `UPDATE call_edges SET callee_id = NULL
     WHERE callee_id IN (SELECT id FROM symbols WHERE file_path = ?)`
  ).run(filePath);
  await db.prepare(
    `UPDATE ai_locations SET symbol_id = NULL
     WHERE symbol_id IN (SELECT id FROM symbols WHERE file_path = ?)`
  ).run(filePath);
  // Delete children (methods/fields with parent_id) before parents (classes) to satisfy
  // the self-referencing symbols.parent_id FK — SQLite checks constraints row-by-row
  await db.prepare("DELETE FROM symbols WHERE file_path = ? AND parent_id IS NOT NULL").run(filePath);
  const result = await db.prepare("DELETE FROM symbols WHERE file_path = ?").run(filePath);
  await db.prepare("DELETE FROM file_versions WHERE path = ?").run(filePath);
  return (result as any).rowsAffected as number ?? 0;
}

export async function resolveParentFks(db: Db, filePath: string): Promise<void> {
  // Resolve FKs for relationships/edges whose source symbol is from this file
  await db.prepare(`
    UPDATE class_relationships
    SET parent_symbol_id = (
      SELECT id FROM symbols WHERE symbol_name = class_relationships.parent_name LIMIT 1
    )
    WHERE parent_symbol_id IS NULL
      AND child_symbol_id IN (SELECT id FROM symbols WHERE file_path = ?)
  `).run(filePath);

  await db.prepare(`
    UPDATE call_edges
    SET callee_id = (
      SELECT id FROM symbols WHERE symbol_name = call_edges.callee_name LIMIT 1
    )
    WHERE callee_id IS NULL
      AND caller_id IN (SELECT id FROM symbols WHERE file_path = ?)
  `).run(filePath);
}

export async function incrementStat(db: Db, sessionId: string, key: string, amount = 1): Promise<void> {
  await db.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(amount, key);
  await db.prepare(
    "INSERT INTO session_stats (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = value + ?"
  ).run(sessionId, key, amount, amount);
}

export async function batchIncrementStats(
  db: Db,
  sessionId: string,
  updates: Record<string, number>,
): Promise<void> {
  await db.exec("BEGIN");
  try {
    for (const [key, amount] of Object.entries(updates)) {
      await db.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(amount, key);
      await db.prepare(
        "INSERT INTO session_stats (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = value + ?"
      ).run(sessionId, key, amount, amount);
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

export async function insertEmbedding(db: Db, symbolId: number, vector: number[], model: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding, model) VALUES (?, ?, ?)"
  ).run(symbolId, JSON.stringify(vector), model);
}

export async function getAllEmbeddings(db: Db): Promise<{ symbol_id: number; vector: number[] }[]> {
  const rows = await db.prepare("SELECT symbol_id, embedding FROM symbol_embeddings").all();
  return (rows as any[]).map(r => ({
    symbol_id: r.symbol_id as number,
    vector: JSON.parse(r.embedding) as number[],
  }));
}

export async function loadEmbeddingsBatch(db: Db, offset: number, limit: number): Promise<{ symbol_id: number; vector: number[] }[]> {
  const rows = await db.prepare("SELECT symbol_id, embedding FROM symbol_embeddings LIMIT ? OFFSET ?").all(limit, offset);
  return (rows as any[]).map(r => ({
    symbol_id: r.symbol_id as number,
    vector: JSON.parse(r.embedding) as number[],
  }));
}

export async function getEmbeddingCount(db: Db): Promise<number> {
  const rows = await db.prepare("SELECT COUNT(*) as c FROM symbol_embeddings").all();
  return (rows[0] as any).c as number;
}
