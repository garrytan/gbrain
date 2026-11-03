/**
 * CI E2E lane wiring pins (.github/workflows/e2e.yml).
 *
 *   1. prepare-e2e feeds scripts/select-e2e.ts the pull request's changed
 *      files from the GitHub API (shallow checkout, no git history) and fails
 *      closed to the whole corpus when the list is incomplete; nothing masks
 *      the selector's exit code.
 *   2. The e2e-status aggregate requires the selected lane, which never
 *      receives live provider keys (fork-runnable, never spends tokens).
 *   3. Every test/e2e/*.test.ts runs in Selected E2E or is in E2E_EXCLUSIONS
 *      with a named owning job: a job in this workflow that names the file,
 *      the tier1-backend-matrix job (scripts/e2e-backend-matrix.txt),
 *      persistence-validation.yml, or the live-key lanes.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { BACKEND_MATRIX_OWNED, E2E_EXCLUSIONS, PERSISTENCE_VALIDATION_OWNED, prepareMatrix } from '../../scripts/e2e-matrix.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const yml = readFileSync(join(repoRoot, '.github/workflows/e2e.yml'), 'utf8');
const persistenceYml = readFileSync(join(repoRoot, '.github/workflows/persistence-validation.yml'), 'utf8');

/** Slice one top-level job block out of the workflow (2-space-indented keys). */
function jobBlock(name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = yml.slice(start + 1);
  const next = rest.slice(2).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}

const LIVE_KEY_FILES = new Set([
  'test/e2e/skills.test.ts',
  'test/e2e/voyage-rerank-live.test.ts',
  'test/e2e/voyage-multimodal.test.ts',
]);

/** The job that runs an excluded file instead of Selected E2E, or null when nothing owns it. */
function owner(file: string, exclusions: Set<string>): string | null {
  if (!exclusions.has(file)) return 'selected-e2e';
  if (PERSISTENCE_VALIDATION_OWNED.has(file) && persistenceYml.includes(file)) return 'persistence-validation.yml';
  if (BACKEND_MATRIX_OWNED.has(file) && jobBlock('tier1-backend-matrix').includes('scripts/e2e-backend-matrix.txt')) return 'tier1-backend-matrix';
  if (LIVE_KEY_FILES.has(file)) return 'live-key lane';
  const named = yml.replace(jobBlock('selected-e2e'), '');
  return named.includes(file) ? 'named job in e2e.yml' : null;
}

describe('selected-e2e job wiring', () => {
  const job = jobBlock('selected-e2e');
  const prep = jobBlock('prepare-e2e');

  test('consumes select-e2e with nothing masking its exit code', () => {
    expect(prep).toContain('bun scripts/select-e2e.ts --changed-files');
    expect(job).not.toContain('bun scripts/select-e2e.ts');
    expect(job).toContain('bun scripts/e2e-matrix.ts run');
    for (const line of prep.split('\n').filter(l => l.includes('bun scripts/select-e2e.ts'))) {
      expect(line).not.toContain('|| true');
      expect(line).not.toContain('|| echo');
    }
    expect(job).not.toContain('continue-on-error');
  });

  test('status gates on the job', () => {
    const status = jobBlock('e2e-status');
    expect(status).toContain('selected-e2e');
    expect(status).toContain('needs.selected-e2e.result');
    // The aggregate loop must actually check the result, not just need it.
    expect(status.includes('"$SELECTED"')).toBe(true);
  });

  test('fork-runnable: no live provider keys anywhere in the job block', () => {
    for (const secret of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'secrets.']) {
      expect(job).not.toContain(secret);
    }
  });

  test('prepare-e2e classifies from the pull request files API on a shallow checkout', () => {
    expect(prep).not.toContain('fetch-depth');
    expect(prep).not.toContain('git fetch');
    expect(prep).toContain('bash scripts/ci-changed-files.sh');
    expect(prep).toContain('pull-requests: read');
  });

  test('selector emits separate lines so workflow exclusions retain other selected files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-selector-wiring-'));
    try {
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      };
      git(['init', '-q']);
      git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty']);
      git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
      mkdirSync(join(dir, 'test/e2e'), { recursive: true });
      const files = ['test/e2e/mechanical.test.ts', 'test/e2e/route-a.test.ts', 'test/e2e/route-b.test.ts'];
      for (const file of files) writeFileSync(join(dir, file), '// fixture\n');
      const selected = spawnSync(process.execPath, ['--no-env-file', join(repoRoot, 'scripts/select-e2e.ts')], { cwd: dir, encoding: 'utf8' });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe(files.join('\n') + '\n');
      const filtered = prepareMatrix(selected.stdout.trim().split('\n'), new Map());
      expect(filtered.include.flatMap(row => row.files).sort()).toEqual(files.slice(1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepare-e2e changed-file classification', () => {
  const step = jobBlock('prepare-e2e');
  const script = (() => {
    const lines = step.split('\n');
    const start = lines.findIndex(l => l.trim() === 'run: |');
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && !line.startsWith('          ')) break;
      body.push(line.slice(10));
    }
    return body.join('\n');
  })();
  const all = readdirSync(join(repoRoot, 'test/e2e')).filter(f => f.endsWith('.test.ts')).map(f => `test/e2e/${f}`).sort();

  function select(env: Record<string, string>, ghFiles: string, ghExit = 0): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-prepare-e2e-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(dir, 'gh-files'), ghFiles);
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "${join(dir, 'gh-files')}"\nexit ${ghExit}\n`, { mode: 0o755 });
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'out'), FULL_CORPUS: 'false', REPO: 'o/r', PR: '1', ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(join(dir, 'selected.txt'), 'utf8').split('\n').filter(Boolean);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a complete doc-only pull request list selects nothing', () => {
    expect(select({ EVENT: 'pull_request', CHANGED_FILES: '2' }, 'docs/a.md\nREADME.md\n')).toEqual([]);
  });

  test('a code change selects the whole corpus', () => {
    expect(select({ EVENT: 'pull_request', CHANGED_FILES: '2' }, 'docs/a.md\nsrc/cli.ts\n')).toEqual(all);
  });

  test.each([
    ['a truncated pull request list', { EVENT: 'pull_request', CHANGED_FILES: '3' }, 'docs/a.md\n', 0],
    ['a capped pull request (3000 files)', { EVENT: 'pull_request', CHANGED_FILES: '3000' }, 'docs/a.md\n', 0],
    ['an unknown changed-file count', { EVENT: 'pull_request', CHANGED_FILES: '' }, 'docs/a.md\n', 0],
    ['an API error', { EVENT: 'pull_request', CHANGED_FILES: '1' }, 'docs/a.md\n', 1],
    ['a capped merge-group compare', { EVENT: 'merge_group', BASE_SHA: 'a', HEAD_SHA: 'b' }, '', 1],
    ['a push (no pull request context)', { EVENT: 'push' }, 'docs/a.md\n', 0],
  ] as const)('%s fails closed to the whole corpus', (_label, env, files, exit) => {
    expect(select(env, files, exit)).toEqual(all);
  });

  test('a complete doc-only merge-group compare selects nothing', () => {
    expect(select({ EVENT: 'merge_group', BASE_SHA: 'a', HEAD_SHA: 'b' }, 'docs/a.md\n')).toEqual([]);
  });
});

describe('e2e file ownership', () => {
  const files = readdirSync(join(repoRoot, 'test/e2e')).filter(f => f.endsWith('.test.ts')).map(f => `test/e2e/${f}`);

  test('every e2e file runs in Selected E2E or names the job that owns it', () => {
    expect(files.length).toBeGreaterThan(150);
    const unowned = files.filter(f => owner(f, E2E_EXCLUSIONS) === null);
    if (unowned.length) throw new Error(`excluded from Selected E2E with no owning job (add the file to a named job, or drop it from E2E_EXCLUSIONS):\n${unowned.join('\n')}`);
  });

  test('every exclusion names an existing file', () => {
    expect([...E2E_EXCLUSIONS].filter(f => !files.includes(f))).toEqual([]);
  });

  test('a file excluded without an owning job fails the ownership check', () => {
    const fixture = 'test/e2e/fixture-unowned.test.ts';
    expect(owner(fixture, new Set([...E2E_EXCLUSIONS, fixture]))).toBeNull();
    expect(owner(fixture, E2E_EXCLUSIONS)).toBe('selected-e2e');
  });

  test('backend-matrix files are owned by the tier1-backend-matrix job, which e2e-status requires', () => {
    for (const file of BACKEND_MATRIX_OWNED) expect(owner(file, E2E_EXCLUSIONS), file).not.toBeNull();
    const matrix = jobBlock('tier1-backend-matrix');
    expect(matrix).toContain('GBRAIN_CI_REQUIRE_PGBOUNCER');
    expect(matrix).toContain('pgbouncer:');
    expect(jobBlock('e2e-status')).toContain('needs.tier1-backend-matrix.result');
  });
});

describe('tier1-graduation job (GBRA-135 L2)', () => {
  const GRADUATION = [...E2E_EXCLUSIONS].filter(f => f.startsWith('test/e2e/graduation-'));

  test('runs every excluded graduation file once, in two weighted shards, on direct Postgres and PgBouncer', () => {
    const job = jobBlock('tier1-graduation');
    expect(GRADUATION).toHaveLength(15);
    const run = job.split('\n').find(l => l.includes('run: bash scripts/run-e2e.sh '))!;
    expect(run.trim().replace('run: bash scripts/run-e2e.sh ', '').split(' ').sort()).toEqual([...GRADUATION].sort());
    expect(job).toContain('shard: [1, 2]');
    expect(job).toContain('SHARD: ${{ matrix.shard }}/2');
    expect(job).toContain('GBRAIN_PGBOUNCER_URL: postgresql://postgres:postgres@localhost:55433/gbrain_test?prepare=false');
    expect(job).toContain('GBRAIN_TEST_RECEIPT_LANE: tier1');
    expect(job).toContain('name: receipts-tier1-graduation-${{ matrix.shard }}');
    for (const file of GRADUATION) expect(jobBlock('tier1')).not.toContain(file);
  });

  test('e2e-status requires the job and checks its result', () => {
    const status = jobBlock('e2e-status');
    expect(status).toContain('tier1-graduation');
    expect(status).toContain('GRADUATION: ${{ needs.tier1-graduation.result }}');
    expect(status).toContain('"$GRADUATION"');
  });
});
