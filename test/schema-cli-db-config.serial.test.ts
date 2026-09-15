/**
 * #4653 — the schema inspection verbs (show / explain / graph / lint) must
 * resolve the active pack through the same tier chain `schema active` uses,
 * including tier 4 (brain-wide DB config `schema_pack`).
 *
 * Serial because it opens a persistent PGLite database and then hands that
 * database to CLI subprocesses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO_ROOT = join(import.meta.dir, '..');

let home: string;

function runSchema(...args: string[]) {
  return spawnSync('bun', ['run', 'src/cli.ts', 'schema', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GBRAIN_DATABASE_URL: '',
      DATABASE_URL: '',
      GBRAIN_SCHEMA_PACK: '',
      GBRAIN_HOME: home,
    },
    timeout: 60_000,
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-db-config-'));
  const gbrainDir = join(home, '.gbrain');
  const dbPath = join(gbrainDir, 'brain.pglite');
  mkdirSync(gbrainDir, { recursive: true });
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    // Tier 4 only: no env var, no config.json schema_pack.
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
  } finally {
    await engine.disconnect();
  }
  writeFileSync(
    join(gbrainDir, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath }),
    'utf-8',
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('#4653 schema inspection verbs honor DB-config schema_pack (tier 4)', () => {
  test('schema show prints the DB-configured pack header', () => {
    const r = runSchema('show');
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').split('\n')[0]).toBe('# gbrain-base-v2 v1.2.0');
  }, 90_000);

  test('schema explain <v2-only type> exits 0', () => {
    // `tweet` exists only in gbrain-base-v2 — pre-fix: exit 1, "not in active pack `gbrain-base`".
    const r = runSchema('explain', 'tweet', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout ?? '').pack).toBe('gbrain-base-v2');
  }, 90_000);

  test('schema graph --json and schema lint --json report the DB-configured pack', () => {
    const graph = runSchema('graph', '--json');
    expect(graph.status).toBe(0);
    expect(JSON.parse(graph.stdout ?? '').pack).toBe('gbrain-base-v2');
    const lint = runSchema('lint', '--json');
    expect(JSON.parse(lint.stdout ?? '').pack).toBe('gbrain-base-v2');
  }, 120_000);
});
