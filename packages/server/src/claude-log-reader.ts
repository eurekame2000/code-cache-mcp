import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

export interface TurnUsage {
  session_id: string;
  turn_index: number;
  timestamp: number;           // ms, when the user message arrived
  end_timestamp: number;       // ms, when the assistant finished
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;        // input + output (excl. cached)
  effective_tokens: number;    // input + output + cache_read (what we "consumed")
}

interface LogEntry {
  type: string;
  subtype?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: {
    role?: string;
    content?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  durationMs?: number;
  cwd?: string;
}

function projectHash(cwd: string): string {
  // Claude Code maps /Users/foo/bar → -Users-foo-bar
  return cwd.replace(/\//g, "-");
}

function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

function findProjectDir(cwd: string): string | null {
  const base = claudeProjectsDir();
  const hash = projectHash(cwd);
  const dir = join(base, hash);
  if (existsSync(dir)) return dir;

  // Also try parent directories (user may run from subdir)
  const parts = cwd.split("/").filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    const parent = "/" + parts.slice(0, i).join("/");
    const h = projectHash(parent);
    const d = join(base, h);
    if (existsSync(d)) return d;
  }
  return null;
}

function parseTimestamp(ts?: string): number {
  if (!ts) return 0;
  return new Date(ts).getTime();
}

/** Parse one session JSONL file into per-turn usage records. */
function parseSessions(filePath: string): TurnUsage[] {
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const entries: LogEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  if (entries.length === 0) return [];

  // Recover session_id from any entry
  const session_id = entries.find(e => e.sessionId)?.sessionId ?? "unknown";

  const turns: TurnUsage[] = [];

  // Split into turns: each starts with a 'user' type entry, ends before next 'user'
  const userIdxs: number[] = [];
  entries.forEach((e, i) => { if (e.type === "user") userIdxs.push(i); });

  // Also record turn_duration indices for end timestamps
  const turnDurationMap = new Map<string, { ts: number; duration: number }>();
  for (const e of entries) {
    if (e.type === "system" && e.subtype === "turn_duration" && e.timestamp) {
      turnDurationMap.set(e.parentUuid ?? "", {
        ts: parseTimestamp(e.timestamp),
        duration: e.durationMs ?? 0,
      });
    }
  }

  for (let ti = 0; ti < userIdxs.length; ti++) {
    const start = userIdxs[ti];
    const end = userIdxs[ti + 1] ?? entries.length;
    const turnEntries = entries.slice(start, end);

    const userEntry = turnEntries[0];
    const userTs = parseTimestamp(userEntry.timestamp);

    // Find the last assistant entry with usage in this turn
    let lastUsage: TurnUsage["input_tokens"] | null = null;
    let lastAssistantEntry: LogEntry | null = null;
    for (const e of turnEntries) {
      if (e.type === "assistant" && e.message?.usage?.input_tokens !== undefined) {
        lastAssistantEntry = e;
        lastUsage = e.message!.usage!.input_tokens!;
      }
    }

    if (!lastAssistantEntry || !lastAssistantEntry.message?.usage) continue;

    const u = lastAssistantEntry.message.usage;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;

    // End timestamp: from turn_duration if available, else last assistant entry timestamp
    const tdInfo = turnDurationMap.get(lastAssistantEntry.uuid ?? "");
    const endTs = tdInfo?.ts ?? parseTimestamp(lastAssistantEntry.timestamp);
    const dur = tdInfo?.duration ?? (endTs - userTs);

    turns.push({
      session_id,
      turn_index: ti,
      timestamp: userTs,
      end_timestamp: endTs,
      duration_ms: dur,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
      total_tokens: input + output,
      effective_tokens: input + output + cacheRead,
    });
  }

  return turns;
}

export function readClaudeTurns(cwd: string): TurnUsage[] {
  const dir = findProjectDir(cwd);
  if (!dir) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => join(dir, f));

  const all: TurnUsage[] = [];
  for (const f of files) {
    try { all.push(...parseSessions(f)); } catch { /* skip unreadable */ }
  }

  // Sort by timestamp
  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}
