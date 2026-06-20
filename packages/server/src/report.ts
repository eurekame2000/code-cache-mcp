#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import type { CallRecord } from "@code-cache/sdk";
import { readClaudeTurns } from "./claude-log-reader.js";
import type { TurnUsage } from "./claude-log-reader.js";

function getCacheDir(): string {
  return resolve(process.env.CODE_CACHE_DIR ?? ".code-cache");
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function bar(ratio: number, width = 20): string {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function main() {
  const metricsPath = resolve(getCacheDir(), "metrics.jsonl");

  if (!existsSync(metricsPath)) {
    console.log("No metrics file found at:", metricsPath);
    console.log("Start the MCP server and make some queries first.");
    process.exit(0);
  }

  const lines = readFileSync(metricsPath, "utf-8")
    .split("\n")
    .filter(Boolean);

  if (lines.length === 0) {
    console.log("Metrics file is empty — no calls recorded yet.");
    process.exit(0);
  }

  const records: CallRecord[] = lines.map(l => JSON.parse(l));

  // Overall stats
  const queryRecords = records.filter(r => r.tool === "query_code_cache");
  const storeRecords = records.filter(r => r.tool === "store_code_context");
  const totalCalls = queryRecords.length;
  const hits = queryRecords.filter(r => r.cache_hit).length;
  const misses = totalCalls - hits;
  const hitRate = totalCalls > 0 ? hits / totalCalls : 0;
  const totalSaved = queryRecords.reduce((s, r) => s + r.tokens_saved, 0);
  const totalUsed = queryRecords.reduce((s, r) => s + r.tokens_used, 0);
  const savings_pct = (totalSaved + totalUsed) > 0 ? totalSaved / (totalSaved + totalUsed) : 0;

  // Sessions
  const sessions = new Set(records.map(r => r.session_id));

  // Per-file savings
  const fileSavings = new Map<string, number>();
  for (const r of queryRecords) {
    if (r.file_path && r.tokens_saved > 0) {
      const key = basename(r.file_path);
      fileSavings.set(key, (fileSavings.get(key) ?? 0) + r.tokens_saved);
    }
  }
  const topFiles = [...fileSavings.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Per-tool breakdown
  const toolGroups = new Map<string, { calls: number; hits: number; saved: number }>();
  for (const r of records) {
    const g = toolGroups.get(r.tool) ?? { calls: 0, hits: 0, saved: 0 };
    g.calls++;
    if (r.cache_hit) g.hits++;
    g.saved += r.tokens_saved;
    toolGroups.set(r.tool, g);
  }

  // Session breakdown (last 10)
  const sessionMap = new Map<string, { calls: number; hits: number; saved: number; start: number }>();
  for (const r of records) {
    const s = sessionMap.get(r.session_id) ?? { calls: 0, hits: 0, saved: 0, start: r.ts };
    s.calls++;
    if (r.cache_hit) s.hits++;
    s.saved += r.tokens_saved;
    if (r.ts < s.start) s.start = r.ts;
    sessionMap.set(r.session_id, s);
  }
  const recentSessions = [...sessionMap.entries()]
    .sort((a, b) => b[1].start - a[1].start)
    .slice(0, 10);

  // Avg duration
  const avgDuration = records.length > 0
    ? records.reduce((s, r) => s + r.duration_ms, 0) / records.length
    : 0;

  const separator = "─".repeat(50);

  console.log(`
code-cache-mcp  token savings report
${separator}
Sessions:           ${fmt(sessions.size)}
Total records:      ${fmt(records.length)}  (queries: ${fmt(totalCalls)}, stores: ${fmt(storeRecords.length)})
Cache hits:         ${fmt(hits)}  / ${fmt(totalCalls)}  (${(hitRate * 100).toFixed(1)}%)
  ${bar(hitRate)} ${(hitRate * 100).toFixed(1)}%
Tokens saved:       ~${fmt(totalSaved)}
Tokens used:        ~${fmt(totalUsed)}
Net savings:        ~${(savings_pct * 100).toFixed(1)}%
Avg response time:  ${avgDuration.toFixed(0)} ms
`);

  if (topFiles.length > 0) {
    console.log("Top files by tokens saved:");
    const maxSaved = topFiles[0][1];
    for (const [file, saved] of topFiles) {
      const ratio = saved / maxSaved;
      console.log(`  ${file.padEnd(40)} ${fmt(saved).padStart(8)} tokens  ${bar(ratio, 12)}`);
    }
    console.log();
  }

  console.log("Tool breakdown:");
  for (const [tool, g] of [...toolGroups.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const hr = g.calls > 0 ? (g.hits / g.calls * 100).toFixed(0) : "0";
    console.log(`  ${tool.padEnd(25)} ${fmt(g.calls).padStart(6)} calls  hit: ${hr.padStart(3)}%  saved: ~${fmt(g.saved)}`);
  }

  console.log();
  console.log("Recent sessions:");
  console.log(`  ${"session".padEnd(14)}  ${"calls".padStart(6)}  ${"hits".padStart(5)}  ${"hit%".padStart(5)}  ${"saved".padStart(10)}`);
  for (const [sid, s] of recentSessions) {
    const hr = s.calls > 0 ? (s.hits / s.calls * 100).toFixed(0) + "%" : "—";
    console.log(`  ${sid.slice(0, 12)}..${"".padEnd(0)}  ${fmt(s.calls).padStart(6)}  ${fmt(s.hits).padStart(5)}  ${hr.padStart(5)}  ${("~" + fmt(s.saved)).padStart(10)}`);
  }
  // ── Per-turn Claude API usage (from ~/.claude/projects/) ──────────────────
  const cwd = process.cwd();
  const turns = readClaudeTurns(cwd);

  if (turns.length > 0) {
    console.log();
    console.log(`Per-turn Claude API token usage  (${turns.length} turns found in ${cwd})`);
    console.log(`  ${"#".padStart(4)}  ${"timestamp".padEnd(19)}  ${"input".padStart(8)}  ${"output".padStart(7)}  ${"cache_rd".padStart(8)}  ${"cache_cr".padStart(8)}  ${"total".padStart(8)}  ${"dur(s)".padStart(7)}  ${"mcp_saved".padStart(10)}`);
    console.log("  " + "─".repeat(95));

    // For each turn, sum MCP tokens_saved within the time window [turn.timestamp, turn.end_timestamp]
    const turnRows = turns.slice(-30); // show last 30 turns
    for (const [idx, turn] of turnRows.entries()) {
      const mcpSaved = records
        .filter(r => r.ts >= turn.timestamp && r.ts <= turn.end_timestamp && r.tokens_saved > 0)
        .reduce((s, r) => s + r.tokens_saved, 0);

      const ts = new Date(turn.timestamp + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
      const durS = (turn.duration_ms / 1000).toFixed(1);
      const saved = mcpSaved > 0 ? `~${fmt(mcpSaved)}` : "—";
      console.log(
        `  ${String(idx + 1).padStart(4)}  ${ts}  ${fmt(turn.input_tokens).padStart(8)}  ${fmt(turn.output_tokens).padStart(7)}  ${fmt(turn.cache_read_tokens).padStart(8)}  ${fmt(turn.cache_creation_tokens).padStart(8)}  ${fmt(turn.total_tokens).padStart(8)}  ${durS.padStart(7)}  ${saved.padStart(10)}`
      );
    }

    // Totals
    const totInput = turns.reduce((s, t) => s + t.input_tokens, 0);
    const totOutput = turns.reduce((s, t) => s + t.output_tokens, 0);
    const totCacheRead = turns.reduce((s, t) => s + t.cache_read_tokens, 0);
    const totCacheCreate = turns.reduce((s, t) => s + t.cache_creation_tokens, 0);
    const totTotal = turns.reduce((s, t) => s + t.total_tokens, 0);
    console.log("  " + "─".repeat(95));
    console.log(
      `  ${"TOTAL".padStart(4)}  ${"".padEnd(19)}  ${fmt(totInput).padStart(8)}  ${fmt(totOutput).padStart(7)}  ${fmt(totCacheRead).padStart(8)}  ${fmt(totCacheCreate).padStart(8)}  ${fmt(totTotal).padStart(8)}`
    );

    // MCP savings as % of raw input tokens (excluding cache reads)
    if (totInput + totalSaved > 0) {
      const withoutCache = totInput + totalSaved;
      const savePct = (totalSaved / withoutCache * 100).toFixed(1);
      console.log();
      console.log(`  MCP cache saved ~${fmt(totalSaved)} tokens = ${savePct}% of estimated uncached input`);
      console.log(`  (Without cache, AI would have re-read ~${fmt(totalSaved)} extra tokens of source code)`);
    }

    console.log();
    console.log(`  Note: 'input' = fresh tokens billed; 'cache_rd' = prompt cache hits (cheap); 'mcp_saved' = tokens the code cache avoided sending.`);
  }

  console.log();
  console.log(`Metrics file: ${metricsPath}`);
}

main();
