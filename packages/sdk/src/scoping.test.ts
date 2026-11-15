import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CodeCacheStore, isUnderPath, looksMinified } from './code-cache.js';

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'cc-scope-'));
const tmpDbs: string[] = [];

function newTestStore(): CodeCacheStore {
  const path = join(tmpdir(), `cc-scope-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  tmpDbs.push(path);
  return new CodeCacheStore({ dbPath: path });
}

after(() => {
  for (const p of tmpDbs) {
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  }
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
const PROJ_A = join(FIXTURE_DIR, 'proj-a');
const PROJ_B = join(FIXTURE_DIR, 'proj-b');
before(() => {
  mkdirSync(PROJ_A, { recursive: true });
  mkdirSync(PROJ_B, { recursive: true });
  // proj-a: two files sharing a symbol name
  writeFileSync(join(PROJ_A, 'a.py'), [
    'class Greeter:',
    '    def hello(self):',
    '        return "a"',
    '',
    'def run_demo():',
    '    g = Greeter()',
    '    return g.hello()',
    '',
  ].join('\n'));
  writeFileSync(join(PROJ_B, 'b.py'), [
    'class Greeter:',
    '    def hello(self):',
    '        return "b"',
    '',
  ].join('\n'));
  // minified junk file in proj-b
  writeFileSync(join(PROJ_B, 'bundle.min.js'),
    'var a=1;var b=2;' + 'x=1;'.repeat(300) + '\n'.repeat(5));
});

// ── isUnderPath ───────────────────────────────────────────────────────────────
describe('isUnderPath boundary checks', () => {
  test('accepts nested paths and the root itself', () => {
    assert.ok(isUnderPath('/work/proj/src/a.ts', '/work/proj'));
    assert.ok(isUnderPath('/work/proj', '/work/proj'));
  });
  test('rejects sibling prefixes that merely share a string prefix', () => {
    assert.ok(!isUnderPath('/work/proj-other/src/a.ts', '/work/proj'));
  });
});

// ── looksMinified ─────────────────────────────────────────────────────────────
describe('looksMinified heuristic', () => {
  test('flags single mega-lines', () => {
    assert.ok(looksMinified('var a=1;' + 'x=1;'.repeat(500)));
  });
  test('flags many long lines', () => {
    const src = Array.from({ length: 10 }, () => 'x'.repeat(300)).join('\n');
    assert.ok(looksMinified(src));
  });
  test('accepts normal hand-written source', () => {
    assert.ok(!looksMinified('function foo() {\n  return 1;\n}\n'));
  });
});

// ── minified files are not indexed ────────────────────────────────────────────
describe('storeFile skips minified files', () => {
  test('bundle.min.js yields zero symbols and is not cached', async () => {
    const store = newTestStore();
    const r = await store.storeFile(join(PROJ_B, 'bundle.min.js'));
    assert.equal(r.symbols_stored, 0);
    assert.equal(r.was_cached, false);
    // A second store must re-attempt (not short-circuit as cached)
    const r2 = await store.storeFile(join(PROJ_B, 'bundle.min.js'));
    assert.equal(r2.was_cached, false);
  });
});

// ── force re-index ────────────────────────────────────────────────────────────
describe('storeFile force', () => {
  test('force=true re-parses an unchanged file', async () => {
    const store = newTestStore();
    const f = join(PROJ_A, 'a.py');
    const first = await store.storeFile(f);
    assert.equal(first.was_cached, false);
    assert.ok(first.symbols_stored > 0);
    const cached = await store.storeFile(f);
    assert.equal(cached.was_cached, true);
    assert.ok(cached.symbols_stored > 0, 'cached result reports real symbol count');
    const forced = await store.storeFile(f, { force: true });
    assert.equal(forced.was_cached, false, 'force bypasses the hash short-circuit');
    assert.ok(forced.symbols_stored > 0);
  });
});

// ── scope_root ────────────────────────────────────────────────────────────────
describe('queryBySymbol scope_root', () => {
  test('filters symbols from other projects', async () => {
    const store = newTestStore();
    await store.storeFile(join(PROJ_A, 'a.py'));
    await store.storeFile(join(PROJ_B, 'b.py'));

    const scoped = await store.queryBySymbol({ symbol: 'Greeter', scope_root: PROJ_A });
    assert.equal(scoped.total_hits, 1);
    assert.ok(scoped.hits[0].file_path.startsWith(PROJ_A));

    const unscoped = await store.queryBySymbol({ symbol: 'Greeter' });
    assert.equal(unscoped.total_hits, 2);

    // Explicit file_path outside scope is honored (deliberate intent)
    const explicit = await store.queryBySymbol({
      symbol: 'Greeter', file_path: join(PROJ_B, 'b.py'), scope_root: PROJ_A,
    });
    assert.equal(explicit.total_hits, 1);
    assert.ok(explicit.hits[0].file_path.startsWith(PROJ_B));
  });

  test('results are deduped by (name, file, line)', async () => {
    const store = newTestStore();
    await store.storeFile(join(PROJ_A, 'a.py'));
    // Simulate legacy duplicate rows by forcing a re-insert
    await store.storeFile(join(PROJ_A, 'a.py'), { force: true });
    const q = await store.queryBySymbol({ symbol: 'Greeter', include_relationships: false });
    const keys = q.hits.map(h => `${h.symbol_name}:${h.file_path}:${h.start_line}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate hits');
  });
});

// ── builtin call-edge noise ───────────────────────────────────────────────────
describe('call graph builtin filtering', () => {
  test('unresolved builtin callees are dropped, user methods kept', async () => {
    const store = newTestStore();
    const f = join(FIXTURE_DIR, 'calls.py');
    writeFileSync(f, [
      'class Box:',
      '    def fetch(self):',
      '        return 1',
      '',
      'def use_box(box):',
      '    d = {}',
      '    d.get("k")',
      '    box.fetch()',
      '    return d',
      '',
    ].join('\n'));
    await store.storeFile(f);
    const q = await store.queryBySymbol({ symbol: 'use_box', include_relationships: true });
    assert.equal(q.total_hits, 1);
    const callees = q.hits[0].callees ?? [];
    const names = callees.map(c => c.name);
    assert.ok(!names.includes('get'), 'unresolved d.get() noise must be dropped');
    assert.ok(names.includes('fetch'), 'resolved user method survives');
  });

  test('callees that resolve to real symbols keep their file_path', async () => {
    const store = newTestStore();
    const f = join(FIXTURE_DIR, 'chain.py');
    writeFileSync(f, [
      'def helper():',
      '    return 1',
      '',
      'def main():',
      '    return helper()',
      '',
    ].join('\n'));
    await store.storeFile(f);
    const q = await store.queryBySymbol({ symbol: 'main', include_relationships: true });
    const callees = q.hits[0].callees ?? [];
    const helper = callees.find(c => c.name === 'helper');
    assert.ok(helper, 'real callee survives filtering');
    assert.ok(helper.file_path, 'resolved callee carries file_path');
  });
});
