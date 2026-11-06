/**
 * GBRA-248 W1: scripts/check-core-world-reads.ts counts, per file under
 * src/core, the reads and effects that reach the process or the machine
 * (loadConfig, process.env, fs, module-level collections, the spawn wrapper,
 * process-wide hooks, AsyncLocalStorage stores) and fails when a count rises
 * above its baseline row or falls below it without the row falling too.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { countFile } from '../../scripts/check-core-world-reads.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-core-world-reads.ts');
const BASELINE = 'scripts/core-world-reads-baseline.tsv';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-core-world-reads-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries({ [BASELINE]: '# baseline\n', ...files })) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function run(root: string, args: string[] = []) {
  const r = spawnSync('bun', [GUARD, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: r.stdout + '\n' + r.stderr };
}

const row = (path: string, metric: string, count: number, why = 'W6: test') => [path, metric, count, why].join('\t');

describe('check-core-world-reads.ts: what counts', () => {
  test('each metric counts its own construct', () => {
    const counts = countFile([
      "import { readFileSync } from 'node:fs';",
      "import * as fsp from 'fs/promises';",
      "import { spawnSync } from '../spawn.ts';",
      "import { AsyncLocalStorage } from 'node:async_hooks';",
      "const cp = require('child_process');",
      'const cache = new Map<string, number>();',
      'let current = new Set([1, 2]);',
      "const TABLE = new Set(['a', 'b']);",
      'const store = new AsyncLocalStorage<number>();',
      'export function f() {',
      '  const local = new Map();',
      '  const c = loadConfig();',
      '  const k = process.env.OPENAI_API_KEY ?? Bun.env.HOME;',
      "  process.on('exit', () => {});",
      '  process.exit(1);',
      '  return [c, k, local, cp, fsp, readFileSync, spawnSync];',
      '}',
    ].join('\n'));
    expect(counts).toEqual({
      load_config: 1, process_env: 2, fs_import: 2, module_collection: 2, spawn_import: 2, process_global: 2, als_store: 1,
    });
  });

  test('comments, strings and look-alike names never count', () => {
    const counts = countFile([
      '// loadConfig() and process.env.X in a comment',
      "const s = 'process.env.HOME loadConfig() new Map()';",
      "import { x } from './respawn.ts';",
      'export function g(proc: { env: string; exit(): void }) { proc.exit(); return proc.env + s + x; }',
    ].join('\n'));
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('check-core-world-reads.ts: the ratchet', () => {
  test('a tree at its baseline passes', () => {
    const root = tree({
      [BASELINE]: row('src/core/a.ts', 'process_env', 1) + '\n',
      'src/core/a.ts': 'export const k = process.env.K;\n',
    });
    const r = run(root);
    expect(r.out).toContain('check-core-world-reads: ok');
    expect(r.code).toBe(0);
  });

  test('a count above its row fails and names file, metric, baseline, actual and the docs anchor', () => {
    const root = tree({
      [BASELINE]: row('src/core/a.ts', 'process_env', 1) + '\n',
      'src/core/a.ts': 'export const k = process.env.K;\nexport const j = process.env.J;\n',
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/a.ts process_env: baseline 1, actual 2');
    expect(r.out).toContain('take it from engine settings');
    expect(r.out).toContain('docs/architecture/topologies.md#embedded-core-planned');
  });

  test('a file with no row counts against a baseline of zero', () => {
    const root = tree({ 'src/core/new.ts': 'export const c = loadConfig();\ndeclare function loadConfig(): unknown;\n' });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/new.ts load_config: baseline 0, actual 1');
  });

  test('a count below its row is stale, and --prune lowers it without raising anything', () => {
    const root = tree({
      [BASELINE]: [row('src/core/a.ts', 'process_env', 3), row('src/core/gone.ts', 'fs_import', 1)].join('\n') + '\n',
      'src/core/a.ts': 'export const k = process.env.K;\n',
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stale row: src/core/a.ts process_env: baseline 3, actual 1');
    expect(r.out).toContain('stale row: src/core/gone.ts fs_import: baseline 1, actual 0');
    expect(run(root, ['--prune']).code).toBe(0);
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(row('src/core/a.ts', 'process_env', 1) + '\n');
    expect(run(root).code).toBe(0);
  });

  test('duplicate, malformed and unjustified rows fail', () => {
    const root = tree({
      [BASELINE]: [
        row('src/core/a.ts', 'process_env', 1),
        row('src/core/a.ts', 'process_env', 1),
        row('src/core/a.ts', 'env_reads', 1),
        row('src/core/a.ts', 'fs_import', 0),
        ['src/core/a.ts', 'load_config', '1', ' '].join('\t'),
      ].join('\n') + '\n',
      'src/core/a.ts': 'export const k = process.env.K;\n',
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('duplicate row for src/core/a.ts process_env');
    expect(r.out).toContain('unknown metric "env_reads"');
    expect(r.out).toContain('count must be a positive integer');
    expect(r.out).toContain('empty justification');
  });
});
