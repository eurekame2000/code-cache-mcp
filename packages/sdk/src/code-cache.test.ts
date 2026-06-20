import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, unlinkSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { CodeCacheStore } from './code-cache.js';

// ── Test data paths ───────────────────────────────────────────────────────────
const JAVA_MASTER = resolve('/Users/eureka/mcp/Java-master/src/main/java');
const LOWEST_SET_BIT = resolve(
  '/Users/eureka/mcp/Java-master/src/main/java/com/thealgorithms/bitmanipulation/LowestSetBit.java'
);
const LOWEST_SET_BIT_TEST = resolve(
  '/Users/eureka/mcp/Java-master/src/test/java/com/thealgorithms/bitmanipulation/LowestSetBitTest.java'
);
const ITERATIVE_BINARY_SEARCH = resolve(
  '/Users/eureka/mcp/Java-master/src/main/java/com/thealgorithms/searches/IterativeBinarySearch.java'
);

// ── Helpers ───────────────────────────────────────────────────────────────────
const tmpDbs: string[] = [];

function newTestStore(): CodeCacheStore {
  const path = `/tmp/cc-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`;
  tmpDbs.push(path);
  return new CodeCacheStore({ dbPath: path, sessionId: 'test' });
}

function pickRandomJavaFiles(root: string, n: number): string[] {
  const all: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) all.push(full);
    }
  }
  walk(root);
  // Fisher-Yates shuffle, take first n
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n);
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// Cleanup all tmp DBs after all tests
after(() => {
  for (const p of tmpDbs) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
});

// ── 1. storeFile 基础正确性 ───────────────────────────────────────────────────
describe('storeFile correctness', () => {
  test('returns symbols_stored > 0 for valid java file', async () => {
    const store = newTestStore();
    const r = await store.storeFile(LOWEST_SET_BIT);
    assert.ok(r.symbols_stored > 0, `expected symbols_stored > 0, got ${r.symbols_stored}`);
    assert.equal(r.language, 'java');
    assert.equal(r.was_cached, false);
  });

  test('was_cached=true on second store of same file', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    const r2 = await store.storeFile(LOWEST_SET_BIT);
    assert.equal(r2.was_cached, true);
    assert.equal(r2.symbols_stored, 0);
  });

  test('stores correct class and method counts', async () => {
    const store = newTestStore();
    const r = await store.storeFile(LOWEST_SET_BIT);
    assert.equal(r.classes_found, 1);   // LowestSetBit class
    assert.equal(r.methods_found, 3);   // constructor + isolateLowestSetBit + clearLowestSetBit
  });
});

// ── 2. queryBySymbol 精确命中正确性 ──────────────────────────────────────────
describe('queryBySymbol correctness', () => {
  let store: CodeCacheStore;

  before(async () => {
    store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    await store.storeFile(LOWEST_SET_BIT_TEST);
  });

  test('known symbol returns cache_hit=true', async () => {
    const r = await store.queryBySymbol({ symbol: 'LowestSetBit' });
    assert.equal(r.cache_hit, true);
    assert.ok(r.total_hits > 0);
  });

  test('isolateLowestSetBit has 7 callers', async () => {
    const r = await store.queryBySymbol({
      symbol: 'isolateLowestSetBit',
      include_relationships: true,
      kinds: ['method'],
    });
    const method = r.hits.find(h => h.symbol_name === 'isolateLowestSetBit');
    assert.ok(method, 'method not found');
    assert.equal(method!.callers?.length, 7, `expected 7 callers, got ${method!.callers?.length}`);
  });

  test('kinds filter returns only matching symbol_kind', async () => {
    const r = await store.queryBySymbol({ symbol: 'LowestSetBit', kinds: ['class'] });
    for (const hit of r.hits) {
      assert.equal(hit.symbol_kind, 'class', `unexpected kind: ${hit.symbol_kind}`);
    }
  });

  test('file_path filter returns only symbols from that file', async () => {
    const r = await store.queryBySymbol({
      symbol: 'Bit',
      file_path: LOWEST_SET_BIT,
    });
    for (const hit of r.hits) {
      assert.equal(hit.file_path, LOWEST_SET_BIT);
    }
  });

  test('nonexistent symbol returns cache_hit=false and total_hits=0', async () => {
    const r = await store.queryBySymbol({ symbol: 'XYZ_NONEXISTENT_9999' });
    assert.equal(r.cache_hit, false);
    assert.equal(r.total_hits, 0);
  });
});

// ── 3. Symbol index 缓存行为 ──────────────────────────────────────────────────
describe('symbol index cache behavior', () => {
  test('query after invalidateFile excludes invalidated symbols', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);

    let r = await store.queryBySymbol({ symbol: 'isolateLowestSetBit' });
    assert.equal(r.cache_hit, true);

    await store.invalidateFile(LOWEST_SET_BIT);
    r = await store.queryBySymbol({ symbol: 'isolateLowestSetBit' });
    assert.equal(r.cache_hit, false);
    assert.equal(r.total_hits, 0);
  });

  test('clear() resets store and next query returns miss', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    await store.clear();
    const r = await store.queryBySymbol({ symbol: 'LowestSetBit' });
    assert.equal(r.cache_hit, false);
  });

  test('re-store after invalidate makes symbol findable again', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    await store.invalidateFile(LOWEST_SET_BIT);
    await store.storeFile(LOWEST_SET_BIT);
    const r = await store.queryBySymbol({ symbol: 'LowestSetBit' });
    assert.equal(r.cache_hit, true);
  });
});

// ── 4. 随机查询正确性 ─────────────────────────────────────────────────────────
describe('randomized query correctness', { timeout: 120_000 }, () => {
  test('all 50 randomly sampled stored symbols are findable', async () => {
    const store = newTestStore();
    const files = pickRandomJavaFiles(JAVA_MASTER, 30);

    for (const f of files) {
      await store.storeFile(f).catch(() => { /* skip unsupported */ });
    }

    // Collect stored symbol names via file_path queries
    const storedNames: string[] = [];
    for (const f of files) {
      const r = await store.queryBySymbol({ file_path: f, limit: 100 });
      storedNames.push(...r.hits.map(h => h.symbol_name));
    }

    if (storedNames.length === 0) {
      // No symbols indexed (e.g. language unsupported) — skip gracefully
      return;
    }

    const sample = pickRandom(storedNames, Math.min(50, storedNames.length));
    let misses = 0;
    const missedNames: string[] = [];

    for (const name of sample) {
      const r = await store.queryBySymbol({ symbol: name });
      if (!r.cache_hit || r.total_hits === 0) {
        misses++;
        missedNames.push(name);
      }
    }

    assert.equal(misses, 0,
      `${misses} symbols not findable after indexing: ${missedNames.slice(0, 5).join(', ')}`
    );
  });

  test('substring query returns superset of exact match', async () => {
    const store = newTestStore();
    // Index several search files
    const searchDir = resolve(
      '/Users/eureka/mcp/Java-master/src/main/java/com/thealgorithms/searches'
    );
    const files = readdirSync(searchDir)
      .filter(f => f.endsWith('.java'))
      .map(f => join(searchDir, f));
    for (const f of files) await store.storeFile(f).catch(() => {});

    const exact = await store.queryBySymbol({ symbol: 'BinarySearch', limit: 100 });
    const broad = await store.queryBySymbol({ symbol: 'Search', limit: 100 });

    const exactNames = new Set(exact.hits.map(h => h.symbol_name));
    const broadNames = new Set(broad.hits.map(h => h.symbol_name));

    for (const name of exactNames) {
      assert.ok(broadNames.has(name),
        `exact match '${name}' missing from broad query results`
      );
    }
  });

  test('case-insensitive: lowercase query matches original case', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    await store.storeFile(LOWEST_SET_BIT_TEST);

    const r1 = await store.queryBySymbol({ symbol: 'lowestsetbit', limit: 50 });
    const r2 = await store.queryBySymbol({ symbol: 'LowestSetBit', limit: 50 });

    const names1 = r1.hits.map(h => h.symbol_name).sort();
    const names2 = r2.hits.map(h => h.symbol_name).sort();
    assert.deepEqual(names1, names2);
  });
});

// ── 5. 命中率随查询次数提升 ───────────────────────────────────────────────────
describe('hit rate progression', () => {
  test('hit rate 0% before indexing, 100% after', async () => {
    const store = newTestStore();

    // Known symbols from LowestSetBit.java (cold — not yet indexed)
    const knownSymbols = ['LowestSetBit', 'isolateLowestSetBit', 'clearLowestSetBit'];

    // Round 1: cold cache — all misses
    let hits = 0;
    for (const s of knownSymbols) {
      const r = await store.queryBySymbol({ symbol: s });
      if (r.cache_hit) hits++;
    }
    assert.equal(hits, 0, 'expected 0 hits before indexing');

    // Index
    await store.storeFile(LOWEST_SET_BIT);

    // Round 2: warm cache — all hits
    hits = 0;
    for (const s of knownSymbols) {
      const r = await store.queryBySymbol({ symbol: s });
      if (r.cache_hit) hits++;
    }
    assert.equal(hits, knownSymbols.length, `expected ${knownSymbols.length} hits after indexing`);
  });

  test('repeated identical queries all return cache_hit=true', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);

    for (let i = 0; i < 10; i++) {
      const r = await store.queryBySymbol({ symbol: 'LowestSetBit' });
      assert.equal(r.cache_hit, true, `query #${i + 1} returned cache_hit=false`);
    }
  });
});

// ── 6. 性能基准：冷 vs 热 symbol index ───────────────────────────────────────
describe('symbol index performance', { timeout: 60_000 }, () => {
  test('warm index query faster than cold index query', async () => {
    const store = newTestStore();
    // Index 50 files to build a non-trivial symbol table
    const files = pickRandomJavaFiles(JAVA_MASTER, 50);
    for (const f of files) await store.storeFile(f).catch(() => {});

    // Cold: force index rebuild
    store._forceSymbolIndexDirty();
    const t0 = Date.now();
    await store.queryBySymbol({ symbol: 'Search' });
    const coldMs = Date.now() - t0;

    // Warm: index cached from previous query
    const t1 = Date.now();
    await store.queryBySymbol({ symbol: 'Search' });
    const warmMs = Date.now() - t1;

    // Warm must be faster (allow 2ms floor for noise)
    assert.ok(
      warmMs <= coldMs + 2,
      `warm query (${warmMs}ms) not faster than cold (${coldMs}ms)`
    );
    // Also log for visibility
    console.log(`    cold=${coldMs}ms  warm=${warmMs}ms`);
  });

  test('100 sequential random queries complete within 5 seconds', async () => {
    const store = newTestStore();
    const files = pickRandomJavaFiles(JAVA_MASTER, 20);
    for (const f of files) await store.storeFile(f).catch(() => {});

    const storedNames: string[] = [];
    for (const f of files) {
      const r = await store.queryBySymbol({ file_path: f, limit: 100 });
      storedNames.push(...r.hits.map(h => h.symbol_name));
    }
    const queries = pickRandom(storedNames, 100);

    const start = Date.now();
    for (const q of queries) {
      await store.queryBySymbol({ symbol: q });
    }
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `100 queries took ${elapsed}ms (> 5000ms limit)`);
    console.log(`    100 queries: ${elapsed}ms (~${(elapsed / 100).toFixed(1)}ms avg)`);
  });
});

// ── 7. 关系图正确性 ───────────────────────────────────────────────────────────
describe('relationship correctness', () => {
  test('IterativeBinarySearch implements SearchAlgorithm', async () => {
    const store = newTestStore();
    await store.storeFile(ITERATIVE_BINARY_SEARCH);

    const r = await store.queryBySymbol({
      symbol: 'IterativeBinarySearch',
      include_relationships: true,
      kinds: ['class'],
    });

    const cls = r.hits.find(h => h.symbol_name === 'IterativeBinarySearch');
    assert.ok(cls, 'IterativeBinarySearch class not found');
    assert.ok(cls!.relationships && cls!.relationships.length > 0, 'no relationships found');

    const impl = cls!.relationships!.find(
      rel => rel.type === 'implements' && rel.target === 'SearchAlgorithm'
    );
    assert.ok(impl, `implements SearchAlgorithm not found; got: ${JSON.stringify(cls!.relationships)}`);
  });

  test('include_relationships=false returns no relationship fields', async () => {
    const store = newTestStore();
    await store.storeFile(ITERATIVE_BINARY_SEARCH);

    const r = await store.queryBySymbol({
      symbol: 'IterativeBinarySearch',
      include_relationships: false,
    });
    for (const hit of r.hits) {
      assert.equal(hit.relationships, undefined);
      assert.equal(hit.callers, undefined);
      assert.equal(hit.callees, undefined);
    }
  });
});

// ── 8. 边界与容错 ─────────────────────────────────────────────────────────────
describe('edge cases', () => {
  test('query with limit=1 returns at most 1 hit', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);
    await store.storeFile(LOWEST_SET_BIT_TEST);

    const r = await store.queryBySymbol({ symbol: 'Bit', limit: 1 });
    assert.ok(r.hits.length <= 1);
  });

  test('store same file twice returns was_cached=true second time', async () => {
    const store = newTestStore();
    const r1 = await store.storeFile(LOWEST_SET_BIT);
    const r2 = await store.storeFile(LOWEST_SET_BIT);
    assert.equal(r1.was_cached, false);
    assert.equal(r2.was_cached, true);
  });

  test('invalidate nonexistent file returns symbols_removed=0', async () => {
    const store = newTestStore();
    const r = await store.invalidateFile('/tmp/nonexistent_file_xyz.java');
    assert.equal(r.symbols_removed, 0);
  });

  test('getStats reflects stored symbols count', async () => {
    const store = newTestStore();
    const before = await store.getStats();
    assert.equal(before.symbols_cached, 0);

    await store.storeFile(LOWEST_SET_BIT);
    const after = await store.getStats();
    assert.ok(after.symbols_cached > 0);
  });

  test('pattern query finds symbols by name', async () => {
    const store = newTestStore();
    await store.storeFile(LOWEST_SET_BIT);

    const r = await store.queryBySymbol({ pattern: 'isolateLowest' });
    assert.ok(r.total_hits > 0, `pattern 'isolateLowest' found no results`);
    assert.equal(r.cache_hit, true);
  });
});
