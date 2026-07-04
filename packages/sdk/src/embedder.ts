// Embedder removed in v0.2.0 — semantic search stripped for lighter weight.
// All exports are no-ops for backward compatibility.

export async function generateEmbeddings(): Promise<void> {}
export async function semanticSearch(): Promise<any[]> { return []; }
export function embeddingAvailable(): boolean { return false; }
export async function embeddingCount(): Promise<number> { return 0; }
