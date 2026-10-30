import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { UNIT_SHARDS, UNIT_SHARDS_PER_JOB } from '../../scripts/sharding.ts';

const root = join(import.meta.dir, '..', '..');
type Job = { needs?: string | string[]; if?: string; steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string>; if?: string; with?: Record<string, string>; 'timeout-minutes'?: number }> };
type Workflow = { on: Record<string, { paths?: string[] }>; jobs: Record<string, Job> };
const loadWorkflow = (name: string) => load(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const unit = loadWorkflow('test.yml');
const e2e = loadWorkflow('e2e.yml');

const fullProfile = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.full_corpus)";
function aggregate(workflow: Workflow, name: string, event: string, results: Record<string, string>, fullCorpus = false) {
  const step = workflow.jobs[name].steps.find(step => step.name === 'Aggregate result')!;
  const render = (value: string) => value
    .replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, job) => results[job] ?? 'success')
    .replaceAll('${{ ' + fullProfile + ' }}', String(event === 'schedule' || (event === 'workflow_dispatch' && fullCorpus)))
    .replace(/\$\{\{ github.event_name \}\}/g, event)
    // The paid-lane switch is unset here; test/paid-lanes-switch-5903.test.ts covers its values.
    .replaceAll('${{ vars.GBRAIN_PAID_LANES }}', '');
  const script = render(step.run!);
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, render(value)]));
  expect(script).not.toContain('${{');
  expect(Object.values(env).join('\n')).not.toContain('${{');
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).status;
}

describe('CI execution evidence', () => {
  test('default gitleaks and verify run independently for every change, with no pass-marker cache', () => {
    for (const [name, workflow] of [['test.yml', unit], ['e2e.yml', e2e]] as const) {
      const source = readFileSync(join(root, '.github/workflows', name), 'utf8');
      expect(source).not.toMatch(/(?:ci|e2e)-pass-|cache-check|cache-write/);
      expect(source).toContain('bun-cache-');
      expect(source).toContain('pglite-snapshot-');
    }
    expect(unit.on.pull_request.paths).toBeUndefined();
    // E2E never runs on pull_request events: the full-ci dispatch runs it on the
    // head before merge (docs/ci-event-parity.md#full-ci-on-pull-requests).
    expect(e2e.on.pull_request).toBeUndefined();
    for (const name of ['gitleaks', 'verify', 'typecheck']) {
      expect(unit.jobs[name].needs).toBeUndefined();
      expect(unit.jobs[name].if).toBe("${{ github.event_name != 'workflow_dispatch' || (inputs.native_only != true && inputs.race_hunt != true && !inputs.stress_files && !inputs.stress_base) }}");
    }
    expect(e2e.jobs.tier2.needs).toBe('jsonb-parity');
    // Keyed Tier 2 runs on the nightly (and a full_corpus dispatch) only, under the
    // repository-wide paid-lane switch (#5903; GBRA-135 L6).
    expect(e2e.jobs.tier2.if).toBe("format('{0}', vars.GBRAIN_PAID_LANES) != '0' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.full_corpus))");
  });

  test('the verify job runs `bun run verify`, which dispatches through run-verify-parallel.sh', () => {
    expect(unit.jobs.verify.steps.some(step => step.run === 'bun run verify')).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.verify).toContain('scripts/run-verify-parallel.sh');
  });

  test('typecheck runs as its own job beside verify, under a measured step timeout, saves its state on every outcome and gates test-status', () => {
    const job = unit.jobs.typecheck;
    const tsc = job.steps.find(step => step.run === 'bun run typecheck')!;
    expect(tsc['timeout-minutes']).toBe(6);
    const restore = job.steps.find(step => step.uses?.startsWith('actions/cache/restore@') && step.with?.path === 'node_modules/.cache/gbrain-typecheck.tsbuildinfo')!;
    const save = job.steps.find(step => step.uses?.startsWith('actions/cache/save@'))!;
    expect(save.if).toBe('always()');
    expect(save.with).toEqual({ path: restore.with!.path, key: restore.with!.key });
    expect(job.steps.indexOf(save)).toBeGreaterThan(job.steps.indexOf(tsc));
    const verify = unit.jobs.verify.steps.find(step => step.run === 'bun run verify')!;
    expect(verify.env?.GBRAIN_VERIFY_SKIP_TYPECHECK).toBe('1');
    expect(JSON.stringify(unit.jobs.verify.steps)).not.toContain('gbrain-typecheck.tsbuildinfo');
    const skipped = spawnSync('bash', [join(root, 'scripts/run-verify-parallel.sh'), '--dry-list'], { cwd: root, encoding: 'utf8', env: { ...process.env, GBRAIN_VERIFY_SKIP_TYPECHECK: '1' } });
    const full = spawnSync('bash', [join(root, 'scripts/run-verify-parallel.sh'), '--dry-list'], { cwd: root, encoding: 'utf8' });
    expect(full.stdout.split('\n')).toContain('typecheck');
    expect(skipped.stdout.split('\n').filter(Boolean)).toEqual(full.stdout.split('\n').filter(line => line && line !== 'typecheck'));
    expect(unit.jobs['test-status'].needs).toContain('typecheck');
    expect(aggregate(unit, 'test-status', 'push', { typecheck: 'failure' })).toBe(1);
  });

  test('macOS 26 validation typechecks in its own job, under a measured step timeout, saves its state on every outcome, and its verify skips tsc (#6056)', () => {
    const mac = loadWorkflow('macos-validation.yml') as Workflow & { jobs: Record<string, Job & { 'runs-on'?: string }> };
    const job = mac.jobs.typecheck;
    expect(job['runs-on']).toBe('macos-26');
    expect(job.if).toBe(mac.jobs['macos-26'].if);
    const tsc = job.steps.find(step => step.run === 'bun run typecheck')!;
    expect(tsc['timeout-minutes']).toBe(15);
    const restore = job.steps.find(step => step.uses?.startsWith('actions/cache/restore@') && step.with?.path === 'node_modules/.cache/gbrain-typecheck.tsbuildinfo')!;
    expect(restore.with!.key).toBe(unit.jobs.typecheck.steps.find(step => step.uses?.startsWith('actions/cache/restore@') && step.with?.path === restore.with!.path)!.with!.key);
    const save = job.steps.find(step => step.uses?.startsWith('actions/cache/save@'))!;
    expect(save.if).toBe('always()');
    expect(save.with).toEqual({ path: restore.with!.path, key: restore.with!.key });
    expect(job.steps.indexOf(restore)).toBeLessThan(job.steps.indexOf(tsc));
    expect(job.steps.indexOf(save)).toBeGreaterThan(job.steps.indexOf(tsc));
    const verify = mac.jobs['macos-26'].steps.find(step => step.run?.includes('bun run verify'))!;
    expect(verify.env?.GBRAIN_VERIFY_SKIP_TYPECHECK).toBe('1');
    expect(JSON.stringify(mac.jobs['macos-26'].steps)).not.toContain('gbrain-typecheck.tsbuildinfo');
  });

  test('unit aggregate rejects failed, cancelled or skipped required jobs', () => {
    expect(unit.jobs['test-status'].if).toBe("${{ needs.changes.outputs.reuse != 'true' && always() && github.event_name != 'pull_request' && (github.event_name != 'workflow_dispatch' || (inputs.native_only != true && inputs.race_hunt != true && !inputs.stress_files && !inputs.stress_base)) }}");
    expect(unit.jobs['test-status'].needs).toEqual([
      'changes', 'gitleaks', 'security-regressions', 'dependency-audit', 'verify', 'typecheck', 'serial-tests',
      'slow-entity-resolve-perf', 'slow-brainbench-e2e', 'brainbench', 'test', 'native-locks', 'persistence-validation',
      'admin-browser', 'shared-skills-compatibility', 'stress-changed-tests',
    ]);
    expect(aggregate(unit, 'test-status', 'pull_request', {})).toBe(0);
    for (const job of unit.jobs['test-status'].needs as string[]) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(aggregate(unit, 'test-status', 'pull_request', { [job]: result }), `${job}: ${result}`).toBe(1);
      }
    }
  });

  test('E2E aggregate gates nightly full-corpus execution and allows its skip on other events', () => {
    expect(e2e.jobs['e2e-status'].if).toBe("${{ needs.prepare-e2e.outputs.reuse != 'true' && always() }}");
    const needs = e2e.jobs['e2e-status'].needs as string[];
    const nightly = ['coverage-full-unit', 'coverage-full-serial', 'coverage-full-slow', 'coverage-full-e2e'];
    expect(needs).toEqual(['jsonb-parity', 'tier1', 'tier1-graduation', 'tier1-backend-matrix', 'postgres15-compat', 'tier2', 'prepare-e2e', 'selected-e2e', ...nightly]);
    for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
      expect(aggregate(e2e, 'e2e-status', event, Object.fromEntries(nightly.map(job => [job, 'skipped'])))).toBe(0);
    }
    expect(aggregate(e2e, 'e2e-status', 'schedule', {})).toBe(0);
    for (const job of needs) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(aggregate(e2e, 'e2e-status', 'schedule', { [job]: result }), `${job}: ${result}`).toBe(1);
        expect(aggregate(e2e, 'e2e-status', 'workflow_dispatch', { [job]: result }, true), `manual full ${job}: ${result}`).toBe(1);
      }
    }
    expect(aggregate(e2e, 'e2e-status', 'workflow_dispatch', {}, true)).toBe(0);
  });

  test('admin manifest changes trigger the security scan and CI installs are frozen', () => {
    expect(loadWorkflow('osv-scanner.yml').on.pull_request.paths).toEqual(expect.arrayContaining(['bun.lock', 'package.json', 'admin/bun.lock', 'admin/package.json']));
    for (const name of ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'release.yml']) {
      const source = readFileSync(join(root, '.github/workflows', name), 'utf8');
      const installs = source.split('\n').filter(line => /^\s*-?\s*run: bun install/.test(line));
      for (const line of installs) expect(line, name).toContain('--frozen-lockfile');
    }
  });

  test('scheduled slow lane includes every slow file excluded from the coverage shards', () => {
    const shard = readFileSync(join(root, 'scripts/test-shard.sh'), 'utf8');
    const excluded = [...shard.matchAll(/-not -name '([^']+\.slow\.test\.ts)'/g)].map(match => match[1]);
    expect(excluded.length).toBeGreaterThan(0);
    const slow = e2e.jobs['coverage-full-slow'].steps.map(step => step.run ?? '').join('\n');
    for (const file of excluded) expect(slow).toContain(`bun test test/${file}`);
  });

  test('unit shard count agrees across the matrix, the shard step and the coverage manifest', () => {
    const job = unit.jobs.test as Job & { strategy: { matrix: { shards: number[][] } } };
    const packs = job.strategy.matrix.shards;
    expect(packs.map(pack => pack.length)).toEqual(packs.map(() => UNIT_SHARDS_PER_JOB));
    const shards = packs.flat();
    expect(shards).toEqual(Array.from({ length: UNIT_SHARDS }, (_, i) => i + 1));
    const run = job.steps.find(step => step.run?.includes('scripts/test-shard-pack.sh'))!;
    expect(run.name).toBe(`Run test shards \${{ join(matrix.shards, ' and ') }} of ${shards.length}`);
    expect(run.run).toBe(`bash scripts/test-shard-pack.sh ${shards.length} \${{ join(matrix.shards, ' ') }}`);
    const merge = unit.jobs['coverage-report'].steps.find(step => step.name === 'Merge lanes')!.run!;
    const expected = /--manifest-expect (\S+)/.exec(merge)![1].split(',').filter(lane => lane.startsWith('shard-'));
    expect(expected).toEqual(shards.map(shard => `shard-${shard}`));
  });

  test('each packed unit shard uploads its own receipts, coverage lane and timing log', () => {
    const job = unit.jobs.test as Job;
    const pack = job.steps.find(step => step.run?.includes('scripts/test-shard-pack.sh'))!;
    expect(pack.env).toEqual({ GBRAIN_SHARD_PACK_DIR: '${{ runner.temp }}/shards' });
    const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => [step.with!.name, step.with!.path]);
    expect(uploads).toEqual(Array.from({ length: UNIT_SHARDS_PER_JOB }, (_, i) => `\${{ matrix.shards[${i}] }}`).flatMap(shard => [
      [`receipts-unit-${shard}`, `\${{ runner.temp }}/shards/${shard}/receipts`],
      [`coverage-shard-${shard}`, `\${{ runner.temp }}/shards/${shard}/coverage`],
      [`timings-unit-${shard}`, `\${{ runner.temp }}/shards/${shard}/unit.log`],
    ]));
  });

  test('the nightly coverage-full-unit lane runs the same unit partition', () => {
    const job = e2e.jobs['coverage-full-unit'] as Job & { strategy: { matrix: { shard: number[] } } };
    const shards = job.strategy.matrix.shard;
    expect(shards).toEqual(Array.from({ length: UNIT_SHARDS }, (_, i) => i + 1));
    const run = job.steps.find(step => step.run?.includes('scripts/test-shard.sh'))!;
    expect(run.name).toBe(`Coverage shard \${{ matrix.shard }}/${UNIT_SHARDS}`);
    expect(run.run).toBe(`scripts/test-shard.sh \${{ matrix.shard }} ${UNIT_SHARDS}`);
    const merge = e2e.jobs['coverage-full-report'].steps.find(step => step.name === 'Merge full corpus')!.run!;
    const expected = /--manifest-expect (\S+)/.exec(merge)![1].split(',').filter(lane => lane.startsWith('shard-'));
    expect(expected).toEqual(shards.map(shard => `shard-${shard}`));
  });
});

describe('test:full exit status', () => {
  test.each([
    { database: '', e2eExit: 0, expected: 0, called: false },
    { database: 'fixture-test-db', e2eExit: 0, expected: 0, called: true },
    { database: 'fixture-test-db', e2eExit: 7, expected: 7, called: true },
  ])('DATABASE_URL=$database E2E exit=$e2eExit', ({ database, e2eExit, expected, called }) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-test-full-'));
    try {
      mkdirSync(join(home, 'scripts'));
      mkdirSync(join(home, 'bin'));
      writeFileSync(join(home, 'bin/bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(home, 'scripts/run-unit-parallel.sh'), 'exit 0\n');
      writeFileSync(join(home, 'scripts/run-e2e.sh'), `echo E2E_CALLED\nexit ${e2eExit}\n`);
      const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:full'];
      writeFileSync(join(home, 'package.json'), JSON.stringify({ scripts: { 'test:full': script } }));
      const result = spawnSync(process.execPath, ['--no-env-file', 'run', 'test:full'], {
        cwd: home, encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: database, PATH: `${join(home, 'bin')}:${process.env.PATH}` },
      });
      expect(result.status).toBe(expected);
      expect(result.stdout.includes('E2E_CALLED')).toBe(called);
      expect(result.stderr.split('\n').some(line => line.startsWith('[test:full] skipped E2E'))).toBe(!called);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
