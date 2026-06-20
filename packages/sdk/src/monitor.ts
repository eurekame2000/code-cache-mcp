import { appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

export interface CallRecord {
  ts: number;
  session_id: string;
  tool: string;
  cache_hit: boolean;
  tokens_saved: number;
  tokens_used: number;
  file_path?: string;
  symbol?: string;
  hits_count?: number;
  duration_ms: number;
}

export class MetricsMonitor {
  private metricsPath: string;
  private sessionId: string;
  private pgClient: any | null = null;
  private pgReady = false;

  constructor(metricsDir: string, sessionId: string) {
    this.metricsPath = resolve(metricsDir, "metrics.jsonl");
    this.sessionId = sessionId;
    this.initPg();
  }

  private async initPg(): Promise<void> {
    const url = process.env.METRICS_DB_URL;
    if (!url) return;
    try {
      const { default: pg } = await import("pg" as any);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS mcp_calls (
          id          BIGSERIAL PRIMARY KEY,
          ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          session_id  TEXT NOT NULL,
          tool        TEXT NOT NULL,
          cache_hit   BOOLEAN NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          tokens_used  INTEGER NOT NULL DEFAULT 0,
          file_path   TEXT,
          symbol      TEXT,
          hits_count  INTEGER,
          duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_mc_session ON mcp_calls(session_id);
        CREATE INDEX IF NOT EXISTS idx_mc_ts ON mcp_calls(ts);
        CREATE INDEX IF NOT EXISTS idx_mc_tool ON mcp_calls(tool, cache_hit);
      `);
      this.pgClient = client;
      this.pgReady = true;
    } catch {
      // PG optional — JSONL always works
    }
  }

  async record(record: Omit<CallRecord, "ts" | "session_id">): Promise<void> {
    const entry: CallRecord = {
      ts: Date.now(),
      session_id: this.sessionId,
      ...record,
    };

    // Always write JSONL
    try {
      const dir = dirname(this.metricsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.metricsPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // don't crash MCP if metrics write fails
    }

    // Optionally write to PG
    if (this.pgReady && this.pgClient) {
      try {
        await this.pgClient.query(
          `INSERT INTO mcp_calls (ts, session_id, tool, cache_hit, tokens_saved, tokens_used, file_path, symbol, hits_count, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            new Date(entry.ts), entry.session_id, entry.tool, entry.cache_hit,
            entry.tokens_saved, entry.tokens_used, entry.file_path ?? null,
            entry.symbol ?? null, entry.hits_count ?? null, entry.duration_ms,
          ]
        );
      } catch {
        // don't crash on PG failure
      }
    }
  }

  /** Wrap an async tool handler, recording metrics automatically. */
  async wrap<T extends { tokens_saved?: number; total_hits?: number; cache_hit?: boolean }>(
    tool: string,
    opts: { file_path?: string; symbol?: string },
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    let cache_hit = false;
    let tokens_saved = 0;
    let hits_count: number | undefined;
    let tokens_used = 0;

    try {
      const result = await fn();
      cache_hit = result.cache_hit ?? false;
      tokens_saved = result.tokens_saved ?? 0;
      hits_count = result.total_hits;
      return result;
    } finally {
      await this.record({
        tool,
        cache_hit,
        tokens_saved,
        tokens_used,
        hits_count,
        file_path: opts.file_path,
        symbol: opts.symbol,
        duration_ms: Date.now() - start,
      });
    }
  }

  async close(): Promise<void> {
    if (this.pgClient) {
      try { await this.pgClient.end(); } catch { /* ignore */ }
    }
  }
}
