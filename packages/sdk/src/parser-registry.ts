import { extname } from "path";
import type { LanguageParser } from "./types.js";

type ParserFactory = () => Promise<LanguageParser>;

const registry = new Map<string, ParserFactory>();
const cache = new Map<string, LanguageParser>();

export function registerParser(language: string, factory: ParserFactory): void {
  registry.set(language, factory);
}

export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".java": "java",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "typescript",
    ".mjs": "typescript",
    ".jsx": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? null;
}

export async function getParser(language: string): Promise<LanguageParser | null> {
  if (cache.has(language)) return cache.get(language)!;
  const factory = registry.get(language);
  if (!factory) return null;
  const parser = await factory();
  cache.set(language, parser);
  return parser;
}

// initParsers removed in v0.2.0 — parsers are registered lazily by CodeCacheStore.init()
// and WASM grammars load on first use via getParser()
