import type { Db } from "./db.js";
import { insertEmbedding, loadEmbeddingsBatch, getEmbeddingCount } from "./db.js";

const MODEL = "Xenova/all-MiniLM-L6-v2";

let _pipeline: any | null = null;
let _initPromise: Promise<void> | null = null;
let _available = true; // set false if init fails (offline / import error)

async function getPipeline(): Promise<any | null> {
  if (!_available) return null;
  if (_pipeline) return _pipeline;
  if (_initPromise) { await _initPromise; return _pipeline; }

  _initPromise = (async () => {
    try {
      const { pipeline, env } = await import("@xenova/transformers" as any);
      // Cache models in project dir to avoid re-downloads
      env.cacheDir = "./.model-cache";
      env.allowRemoteModels = true;
      _pipeline = await pipeline("feature-extraction", MODEL, { quantized: true });
    } catch {
      _available = false;
    }
  })();

  await _initPromise;
  return _pipeline;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function embed(text: string): Promise<number[] | null> {
  const pipe = await getPipeline();
  if (!pipe) return null;
  // mean-pool the token embeddings
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/** Text used to represent a symbol for embedding. */
export function symbolEmbedText(symbolKind: string, symbolName: string, signature?: string): string {
  if (signature) return `${symbolKind} ${signature}`;
  return `${symbolKind} ${symbolName}`;
}

/** Generate + store embeddings for a list of symbols. Fire-and-forget safe. */
export async function generateEmbeddings(
  db: Db,
  symbols: { id: number; symbol_kind: string; symbol_name: string; signature?: string | null }[]
): Promise<void> {
  const pipe = await getPipeline();
  if (!pipe) return; // embedding unavailable — graceful skip

  for (const sym of symbols) {
    try {
      const text = symbolEmbedText(sym.symbol_kind, sym.symbol_name, sym.signature ?? undefined);
      const vec = await embed(text);
      if (vec) await insertEmbedding(db, sym.id, vec, MODEL);
    } catch {
      // don't let embedding failure affect cache writes
    }
  }
}

export interface SemanticHit {
  symbol_id: number;
  score: number;
}

/**
 * Embed `query`, compare against stored vectors, return top-K symbol IDs.
 * Loads embeddings in batches from SQLite to bound memory usage.
 * Falls back to empty array if embeddings unavailable.
 */
export async function semanticSearch(
  db: Db,
  query: string,
  topK = 10,
  minScore = 0.3,
): Promise<SemanticHit[]> {
  const queryVec = await embed(query);
  if (!queryVec) return [];

  const BATCH_SIZE = 1000;
  const total = await getEmbeddingCount(db);
  if (total === 0) return [];

  const candidates: SemanticHit[] = [];

  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = await loadEmbeddingsBatch(db, offset, BATCH_SIZE);
    for (const { symbol_id, vector } of batch) {
      const score = cosineSimilarity(queryVec, vector);
      if (score >= minScore) candidates.push({ symbol_id, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function embeddingAvailable(): boolean {
  return _available;
}

export async function embeddingCount(db: Db): Promise<number> {
  return getEmbeddingCount(db);
}
