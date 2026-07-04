import { connect } from "@tursodatabase/database";
import { createHash } from "crypto";
import type {
  SymbolRow, ClassRelationship, CallEdge, AiLocation
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

CREATE INDEX IF NOT EXISTS idx_ail_file ON ai_locations(file_path);
CREATE INDEX IF NOT EXISTS idx_ail_located_at ON ai_locations(located_at DESC);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
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
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec(SCHEMA);
  // Migrate old DBs
  try { await db.exec("ALTER TABLE file_versions DROP COLUMN content"); } catch {}
  try { await db.exec("ALTER TABLE symbols DROP COLUMN source_snippet"); } catch {}
  try { await db.exec("ALTER TABLE symbols ADD COLUMN signature TEXT"); } catch {}
  // Drop tables removed in v0.2.0
  try { await db.exec("DROP TABLE IF EXISTS symbol_embeddings"); } catch {}
  try { await db.exec("DROP TABLE IF EXISTS query_history"); } catch {}
  try { await db.exec("DROP TABLE IF EXISTS session_stats"); } catch {}
  try { await db.exec("DROP TABLE IF EXISTS ast_nodes"); } catch {}
  // Clean up orphan rows
  await db.exec(`
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
  const childResult = await db.prepare("DELETE FROM symbols WHERE file_path = ? AND parent_id IS NOT NULL").run(filePath);
  const parentResult = await db.prepare("DELETE FROM symbols WHERE file_path = ?").run(filePath);
  await db.prepare("DELETE FROM file_versions WHERE path = ?").run(filePath);
  const children = (childResult as any).rowsAffected as number ?? 0;
  const parents = (parentResult as any).rowsAffected as number ?? 0;
  return children + parents;
}

export async function resolveParentFks(db: Db, filePath: string): Promise<void> {
  await db.prepare(`
    UPDATE class_relationships
    SET parent_symbol_id = (
      SELECT id FROM symbols
      WHERE symbol_name = class_relationships.parent_name
        AND file_path = (SELECT file_path FROM symbols WHERE id = class_relationships.child_symbol_id)
      LIMIT 1
    )
    WHERE parent_symbol_id IS NULL
      AND child_symbol_id IN (SELECT id FROM symbols WHERE file_path = ?)
  `).run(filePath);

  await db.prepare(`
    UPDATE call_edges
    SET callee_id = (
      SELECT id FROM symbols
      WHERE symbol_name = call_edges.callee_name
        AND file_path = (SELECT file_path FROM symbols WHERE id = call_edges.caller_id)
      LIMIT 1
    )
    WHERE callee_id IS NULL
      AND caller_id IN (SELECT id FROM symbols WHERE file_path = ?)
  `).run(filePath);
}

export async function incrementStat(db: Db, key: string, amount = 1): Promise<void> {
  await db.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(amount, key);
}

export async function batchIncrementStats(
  db: Db,
  updates: Record<string, number>,
): Promise<void> {
  await db.exec("BEGIN");
  try {
    for (const [key, amount] of Object.entries(updates)) {
      await db.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(amount, key);
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
