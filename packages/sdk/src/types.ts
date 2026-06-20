export interface CacheConfig {
  dbPath: string;
  sessionId: string;
  watchPaths?: string[];
}

export type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "constructor" | "function" | "field" | "variable";
export type RelationshipKind = "extends" | "implements";

export interface SymbolRow {
  id?: number;
  file_path: string;
  file_hash: string;
  language: string;
  symbol_name: string;
  symbol_kind: SymbolKind;
  start_line: number;
  end_line: number;
  parent_id?: number;
}

export interface AstNodeRow {
  id?: number;
  symbol_id: number;
  node_type: string;
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  ast_json?: string;
}

export interface ClassRelationship {
  child_symbol_id: number;
  parent_name: string;
  parent_symbol_id?: number;
  relationship: RelationshipKind;
}

export interface CallEdge {
  caller_id: number;
  callee_name: string;
  callee_id?: number;
  call_line: number;
}

export interface AiLocation {
  id?: number;
  session_id: string;
  file_path: string;
  file_hash: string;
  start_line: number;
  end_line: number;
  symbol_id?: number;
  reason?: string;
  query_text?: string;
  located_at: number;
}

export interface ParseResult {
  symbols: Omit<SymbolRow, "id" | "file_hash">[];
  relationships: Omit<ClassRelationship, "child_symbol_id" | "parent_symbol_id">[];
  callEdges: Omit<CallEdge, "caller_id" | "callee_id">[];
}

export interface StoreResult {
  file_path: string;
  language: string;
  symbols_stored: number;
  classes_found: number;
  methods_found: number;
  relationships_stored: number;
  call_edges_stored: number;
  was_cached: boolean;
  hash: string;
}

export interface SymbolHit {
  symbol_name: string;
  symbol_kind: SymbolKind;
  file_path: string;
  start_line: number;
  end_line: number;
  ast?: object;
  parent_symbol?: string;
  relationships?: Array<{ type: RelationshipKind; target: string }>;
  callers?: Array<{ symbol: string; line: number }>;
  callees?: Array<{ name: string; line: number; file_path?: string }>;
  semantic_score?: number;  // cosine similarity [0,1] when semantic search used
}

export interface QueryResult {
  hits: SymbolHit[];
  total_hits: number;
  cache_hit: boolean;
  tokens_saved_estimate: number;
}

export interface InvalidateResult {
  file_path: string;
  symbols_removed: number;
}

export interface CacheStats {
  files_tracked: number;
  symbols_cached: number;
  ai_locations_stored: number;
  cache_hits: number;
  cache_misses: number;
  tokens_saved_total: number;
  tokens_saved_session: number;
  embeddings_count: number;
}

export interface LanguageParser {
  parse(source: string, filePath: string): ParseResult;
}
