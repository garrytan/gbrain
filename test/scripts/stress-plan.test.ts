/**
 * scripts/stress/plan.ts: the planning half of `bun run test:stress`, the
 * PR stress gate and the race hunt (docs/TESTING.md#stress-gate).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';
import {
  HELPER_FAN_IN_LIMIT, SPECIAL_FILES, allTestFiles, changedFiles, defaultSeed, directImporters, expandHelper,
  notStressedReason, parseFileList, planShards, profileFor, redact, reproduceLine, seededSample, validRef,
} from '../../scripts/stress/plan.ts';

const REPO = join(import.meta.dir, '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-stress-plan-'));
  dirs.push(root);
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'stress@example.invalid');
  git('config', 'user.name', 'stress');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return root;
}
const sh = (root: string, ...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();

describe('execution profiles', () => {
  test('suffix and location pick the lane; a gated arm with Postgres runs both arms', () => {
    expect(profileFor('test/a.test.ts', { armed: false, postgres: true })).toMatchObject({ name: 'unit', env: 'no-database', arm: 'pglite', timeoutMs: 60_000 });
    expect(profileFor('test/a.serial.test.ts', { armed: false, postgres: true })).toMatchObject({ name: 'serial', env: 'no-database', timeoutMs: 120_000 });
    expect(profileFor('test/a.slow.test.ts', { armed: false, postgres: false })).toMatchObject({ name: 'slow', env: 'no-database' });
    expect(profileFor('test/e2e/a.test.ts', { armed: false, postgres: false })).toMatchObject({ name: 'e2e', env: 'database', arm: 'postgres' });
    expect(profileFor('test/a.serial.test.ts', { armed: true, postgres: true })).toMatchObject({ name: 'postgres-arm', env: 'database', arm: 'pglite+postgres', timeoutMs: 120_000 });
    expect(profileFor('test/a.test.ts', { armed: true, postgres: false })).toMatchObject({ name: 'unit', env: 'no-database' });
  });

  test('slow-file specifics mirror the workflow values a pull request uses', () => {
    const wf = load(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
    const exportStep = wf.jobs['slow-entity-resolve-perf']!.steps.find(s => s.run?.includes('test/export-scale.slow.test.ts'))!;
    const pages = runInNewContext(exportStep.env!.GBRAIN_TEST_EXPORT_SCALE_PAGES!.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { github: { event_name: 'pull_request' } });
    expect(profileFor('test/export-scale.slow.test.ts', { armed: true, postgres: false }).vars).toEqual({ GBRAIN_TEST_EXPORT_SCALE_PAGES: pages });
    expect(exportStep.run).toContain('--timeout=900000');
    expect(SPECIAL_FILES['test/export-scale.slow.test.ts']!.timeoutMs).toBe(900_000);
    const oldBinary = wf.jobs['shared-skills-compatibility']!.steps.find(s => s.run?.includes('test/persistence-skill-old-binary.slow.test.ts'))!;
    expect(Object.keys(oldBinary.env!)).toContain('GBRAIN_TEST_OLD_BINARY');
    expect(oldBinary.run).toContain('--timeout 180000');
    expect(profileFor('test/persistence-skill-old-binary.slow.test.ts', { armed: false, postgres: false })).toMatchObject({ prereq: 'old-binary', timeoutMs: 180_000 });
  });

  test('paid-provider files are listed as not stressed with the reason', () => {
    expect(notStressedReason('test/e2e/x.live.test.ts', new Set())).toContain('paid-provider');
    expect(notStressedReason('test/live/x.test.ts', new Set())).toContain('paid-provider');
    expect(notStressedReason('test/e2e/voyage.test.ts', new Set(['test/e2e/voyage.test.ts']))).toContain('e2e-live-key-only.txt');
    expect(notStressedReason('test/a.test.ts', new Set())).toBeNull();
  });
});

describe('reproduce lines and inputs', () => {
  test('a reproduce line is the local command with every replay value and no credential', () => {
    expect(reproduceLine({ file: 'test/a.test.ts', iterations: 10, firstIteration: 7, seed: 123, postgres: true })).toBe('bun run test:stress test/a.test.ts --iterations 10 --first-iteration 7 --seed 123 --postgres');
    expect(reproduceLine({ file: 'test/a.test.ts', iterations: 3, firstIteration: 1, seed: 5, postgres: false, randomize: true })).toBe('bun run test:stress test/a.test.ts --iterations 3 --seed 5 --randomize');
    expect(redact('DATABASE_URL=postgres://gbrain_test:hunter2@127.0.0.1:5432/gbrain_test bun test')).toBe('DATABASE_URL=postgres://gbrain_test:***@127.0.0.1:5432/gbrain_test bun test');
    expect(redact('PGPASSWORD=hunter2 GH_TOKEN=abc')).toBe('PGPASSWORD=*** GH_TOKEN=***');
    expect(defaultSeed('a'.repeat(40), 'test/a.test.ts')).toBe(defaultSeed('a'.repeat(40), 'test/a.test.ts'));
    expect(defaultSeed('a'.repeat(40), 'test/a.test.ts')).not.toBe(defaultSeed('b'.repeat(40), 'test/a.test.ts'));
  });

  test('dispatch values are validated: test paths only, refs by git check-ref-format or 40-hex', () => {
    expect(parseFileList('test/a.test.ts, test/b/c.serial.test.ts test/a.test.ts')).toEqual({ files: ['test/a.test.ts', 'test/b/c.serial.test.ts'], invalid: [] });
    expect(parseFileList('test/a.test.ts;rm -rf / ../x.test.ts test/../etc.test.ts').invalid).toEqual(['test/a.test.ts;rm', '-rf', '/', '../x.test.ts', 'test/../etc.test.ts']);
    expect(validRef('origin/master')).toBe(true);
    expect(validRef('a'.repeat(40))).toBe(true);
    expect(validRef('$(id)')).toBe(false);
    expect(validRef('-x')).toBe(false);
    expect(validRef('a..b')).toBe(false);
  });
});

describe('changed files', () => {
  test('added, modified and renamed tests count at their new path; deletions and fixtures do not', () => {
    const root = repo({ 'test/keep.test.ts': 'a', 'test/old-name.test.ts': 'x'.repeat(200), 'test/gone.test.ts': 'g', 'test/helpers/h.ts': 'h', 'src/a.ts': '1' });
    const base = sh(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'test/keep.test.ts'), 'b');
    spawnSync('git', ['mv', 'test/old-name.test.ts', 'test/new-name.test.ts'], { cwd: root });
    rmSync(join(root, 'test/gone.test.ts'));
    mkdirSync(join(root, 'test/fixtures'), { recursive: true });
    writeFileSync(join(root, 'test/fixtures/f.test.ts'), 'f');
    writeFileSync(join(root, 'test/added.serial.test.ts'), 'n');
    writeFileSync(join(root, 'test/helpers/h.ts'), 'h2');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'change'], { cwd: root });
    const changed = changedFiles(root, base, 'HEAD');
    expect(changed.error).toBeUndefined();
    expect(changed.tests).toEqual(['test/added.serial.test.ts', 'test/keep.test.ts', 'test/new-name.test.ts']);
    expect(changed.helpers).toEqual(['test/helpers/h.ts']);
  });

  test('a local run without --head includes working-tree and untracked test files', () => {
    const root = repo({ 'test/a.test.ts': 'a' });
    writeFileSync(join(root, 'test/a.test.ts'), 'b');
    writeFileSync(join(root, 'test/new.test.ts'), 'n');
    expect(changedFiles(root, 'master').tests).toEqual(['test/a.test.ts', 'test/new.test.ts']);
  });

  test('an unreachable merge base fails with the next step instead of guessing', () => {
    const root = repo({ 'test/a.test.ts': 'a' });
    const changed = changedFiles(root, 'origin/master', 'HEAD');
    expect(changed.error).toContain('cannot compute the merge base');
    expect(changed.error).toContain('git fetch --no-tags origin master');
  });
});

describe('helper fan-in', () => {
  const importer = (i: number) => [`test/imp-${String(i).padStart(2, '0')}.test.ts`, `import { h } from './helpers/wide.ts';\n`] as const;

  test('direct importers resolve relative specifiers with or without the extension', () => {
    const root = repo({ 'test/helpers/wide.ts': '', 'test/a.test.ts': "import x from './helpers/wide';\n", 'test/sub/b.test.ts': "const m = await import('../helpers/wide.ts');\n", 'test/c.test.ts': "import y from './helpers/other.ts';\n" });
    expect(directImporters(root, 'test/helpers/wide.ts', allTestFiles(root))).toEqual(['test/a.test.ts', 'test/sub/b.test.ts']);
  });

  test('at most 25 importers are all stressed', () => {
    const files = Object.fromEntries([['test/helpers/wide.ts', ''], ...Array.from({ length: HELPER_FAN_IN_LIMIT }, (_, i) => importer(i))]);
    const root = repo(files);
    const exp = expandHelper(root, 'test/helpers/wide.ts', allTestFiles(root), 'a'.repeat(40));
    expect(exp).toMatchObject({ mode: 'all-importers', importers: 25, listedOnly: [] });
    expect(exp.stressed).toHaveLength(25);
  });

  test('above 25: its own tests plus 10 importers sampled by the head SHA, the rest listed', () => {
    const files = Object.fromEntries([['test/helpers/wide.ts', ''], ['test/wide.test.ts', "import { h } from './helpers/wide.ts';\n"], ...Array.from({ length: 40 }, (_, i) => importer(i))]);
    const root = repo(files);
    const tests = allTestFiles(root);
    const a = expandHelper(root, 'test/helpers/wide.ts', tests, 'a'.repeat(40));
    expect(a.mode).toBe('sampled');
    expect(a.importers).toBe(41);
    expect(a.stressed).toContain('test/wide.test.ts');
    expect(a.stressed).toHaveLength(11);
    expect(a.listedOnly).toHaveLength(30);
    expect(expandHelper(root, 'test/helpers/wide.ts', tests, 'a'.repeat(40)).stressed).toEqual(a.stressed);
    expect(expandHelper(root, 'test/helpers/wide.ts', tests, 'b'.repeat(40)).stressed).not.toEqual(a.stressed);
    expect(seededSample([1, 2, 3, 4, 5], 3, 'x')).toEqual(seededSample([1, 2, 3, 4, 5], 3, 'x'));
  });
});

describe('shards', () => {
  test('files pack into the fewest shards under the budget, and every iteration is planned exactly once', () => {
    const shards = planShards([{ file: 'test/a.test.ts', perIterationMs: 57_000 }, { file: 'test/b.test.ts', perIterationMs: 7_000 }, { file: 'test/c.test.ts', perIterationMs: 1_000 }], 10, 25 * 60_000);
    expect(shards.every(s => s.estimateMs <= 25 * 60_000)).toBe(true);
    for (const file of ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']) {
      const its = shards.flatMap(s => s.items).filter(i => i.file === file).flatMap(i => Array.from({ length: i.count }, (_, k) => i.first + k)).sort((x, y) => x - y);
      expect(its).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  test('a file whose ten iterations exceed the budget is split by iteration, never skipped', () => {
    const shards = planShards([{ file: 'test/huge.slow.test.ts', perIterationMs: 6 * 60_000 }], 10, 25 * 60_000);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every(s => s.estimateMs <= 25 * 60_000)).toBe(true);
    expect(shards.flatMap(s => s.items).reduce((n, i) => n + i.count, 0)).toBe(10);
  });

  test('a single iteration longer than the budget still gets its own shard', () => {
    const shards = planShards([{ file: 'test/giant.slow.test.ts', perIterationMs: 40 * 60_000 }], 2, 25 * 60_000);
    expect(shards).toHaveLength(2);
  });
});
