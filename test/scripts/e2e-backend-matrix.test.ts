/**
 * E2E backend matrix (refactor wave 1): scripts/e2e-backend-matrix.txt lists
 * the files run on direct Postgres AND through PgBouncer by scripts/run-e2e.sh.
 * This pins the list's completeness, the CI wiring that supplies the pooled
 * target with an explicit prepare mode, and the runner's per-backend
 * executed-test-count assertion (docs/TESTING.md#e2e-backend-matrix).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const MATRIX = 'scripts/e2e-backend-matrix.txt';

function parseMatrix(text: string) {
  const listed: string[] = [];
  const excluded: { path: string; reason: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      const [path, reason = ''] = line.slice(1).split('\t');
      excluded.push({ path, reason: reason.trim() });
    } else listed.push(line.split('\t')[0]);
  }
  return { listed, excluded };
}

describe('scripts/e2e-backend-matrix.txt', () => {
  const { listed, excluded } = parseMatrix(readFileSync(join(REPO, MATRIX), 'utf8'));

  test('every entry names an existing test file exactly once; exclusions carry a reason', () => {
    const all = [...listed, ...excluded.map((e) => e.path)];
    expect(new Set(all).size).toBe(all.length);
    for (const path of all) expect(existsSync(join(REPO, path)), path).toBe(true);
    for (const e of excluded) expect(e.reason.length, e.path).toBeGreaterThan(0);
  });

  test('covers the E5 binding matrix and every test/e2e parity file', () => {
    expect(listed).toContain('test/e2e/executor-binding-matrix.test.ts');
    const parity = readdirSync(join(REPO, 'test/e2e'))
      .filter((f) => /parity.*\.test\.ts$/.test(f))
      .map((f) => `test/e2e/${f}`);
    const covered = new Set([...listed, ...excluded.map((e) => e.path)]);
    expect(parity.filter((p) => !covered.has(p))).toEqual([]);
    expect(listed.length).toBeGreaterThanOrEqual(parity.length - excluded.length);
  });

  test('CI lanes supply the pooled target with an explicit prepare mode and require its execution', () => {
    for (const file of ['scripts/ubicloud/ci-item.sh', '.github/workflows/e2e.yml']) {
      const text = readFileSync(join(REPO, file), 'utf8');
      expect(text, file).toMatch(/GBRAIN_PGBOUNCER_E2E_URL=\S+\?prepare=false/);
      expect(text, file).toContain('GBRAIN_CI_REQUIRE_PGBOUNCER');
    }
    // ci:local names a database behind its single pooler; run-e2e.sh pins prepare=false.
    const local = readFileSync(join(REPO, 'scripts/ci-local.sh'), 'utf8');
    expect(local.match(/GBRAIN_PGBOUNCER_E2E_DB=\S+/g)?.length).toBe(4);
    expect(local).toContain('GBRAIN_CI_REQUIRE_PGBOUNCER');
  });
});

describe('run-e2e.sh backend-matrix passes', () => {
  function setup(testBody: string): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-backend-matrix-'));
    for (const dir of ['scripts/lib', 'test/e2e']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['run-e2e.sh', 'sharding.ts', 'lib/test-env.sh']) copyFileSync(join(REPO, 'scripts', file), join(root, 'scripts', file));
    writeFileSync(join(root, MATRIX), '# fixture\ntest/e2e/m.test.ts\n');
    writeFileSync(join(root, 'test/e2e/m.test.ts'), testBody);
    writeFileSync(join(root, 'test/e2e/plain.test.ts'), "import {test,expect} from 'bun:test'; test('plain',()=>expect(process.env.GBRAIN_TEST_BACKEND).toBeUndefined());");
    return root;
  }
  const record = (root: string) => `import {test,expect} from 'bun:test';
import {appendFileSync} from 'node:fs';
test('records its backend',()=>{ appendFileSync(${JSON.stringify(join(root, 'passes.txt'))}, process.env.GBRAIN_TEST_BACKEND+' '+process.env.DATABASE_URL+'\\n'); expect(1).toBe(1); });
test.skipIf(process.env.SKIP_ON === process.env.GBRAIN_TEST_BACKEND)('backend-sensitive',()=>expect(1).toBe(1));`;
  function run(root: string, env: Record<string, string>) {
    return spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/m.test.ts', 'test/e2e/plain.test.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GBRAIN_NO_SNAPSHOT: '1',
        SHARD: '',
        COVERAGE_DIR: '',
        GBRAIN_DATABASE_URL: '',
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/gbrain_test',
        ...env,
      },
    });
  }
  const pooled = 'postgresql://postgres@127.0.0.1:2/gbrain_test?prepare=false';

  test('a listed file runs on postgres-direct then pgbouncer with equal counts; unlisted files run once', () => {
    const root = setup('');
    try {
      writeFileSync(join(root, 'test/e2e/m.test.ts'), record(root));
      const r = run(root, { GBRAIN_PGBOUNCER_E2E_URL: pooled, GBRAIN_CI_REQUIRE_PGBOUNCER: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(join(root, 'passes.txt'), 'utf8').trim().split('\n')).toEqual([
        'postgres-direct postgresql://postgres@127.0.0.1:1/gbrain_test',
        `pgbouncer ${pooled}`,
      ]);
      expect(r.stdout).toContain('m.test.ts postgres-direct=2 pgbouncer=2');
      expect(r.stdout).toContain('Tests: 5 passed, 0 failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unequal executed counts across backends fail the file', () => {
    const root = setup('');
    try {
      writeFileSync(join(root, 'test/e2e/m.test.ts'), record(root));
      const r = run(root, { GBRAIN_PGBOUNCER_E2E_URL: pooled, SKIP_ON: 'pgbouncer' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAILED: m.test.ts executed 2 tests on postgres-direct but 1 on pgbouncer (must be equal and non-zero)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pooled database name derives the URL from the pooler with prepare=false pinned', () => {
    const root = setup('');
    try {
      writeFileSync(join(root, 'test/e2e/m.test.ts'), record(root));
      const r = run(root, { GBRAIN_PGBOUNCER_URL: 'postgresql://postgres@127.0.0.1:2/gbrain_pgbouncer_test', GBRAIN_PGBOUNCER_E2E_DB: 'gbrain_pooled_2_test' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(join(root, 'passes.txt'), 'utf8')).toContain('pgbouncer postgresql://postgres@127.0.0.1:2/gbrain_pooled_2_test?prepare=false');
      const missing = run(root, { GBRAIN_PGBOUNCER_URL: '', GBRAIN_PGBOUNCER_E2E_DB: 'gbrain_pooled_2_test' });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('GBRAIN_PGBOUNCER_E2E_DB needs GBRAIN_PGBOUNCER_URL');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pooled URL without an explicit prepare mode is refused', () => {
    const root = setup("import {test,expect} from 'bun:test'; test('x',()=>expect(1).toBe(1));");
    try {
      const r = run(root, { GBRAIN_PGBOUNCER_E2E_URL: pooled.replace('?prepare=false', '') });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('must set the pooler prepare mode explicitly');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a required pooler with no pooled URL fails listed files instead of skipping them', () => {
    const root = setup("import {test,expect} from 'bun:test'; test('x',()=>expect(1).toBe(1));");
    try {
      const r = run(root, { GBRAIN_CI_REQUIRE_PGBOUNCER: '1' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('is in scripts/e2e-backend-matrix.txt but neither GBRAIN_PGBOUNCER_E2E_URL nor GBRAIN_PGBOUNCER_E2E_DB is set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
