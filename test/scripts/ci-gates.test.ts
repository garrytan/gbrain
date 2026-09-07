import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeLoad } from 'js-yaml';

const root = join(import.meta.dir, '..', '..');
type Job = { needs?: string | string[]; if?: string; steps: Array<{ name?: string; run?: string; uses?: string }> };
type Workflow = { on: Record<string, { paths?: string[] }>; jobs: Record<string, Job> };
const loadWorkflow = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const unit = loadWorkflow('test.yml');
const e2e = loadWorkflow('e2e.yml');

function aggregate(workflow: Workflow, name: string, event: string, results: Record<string, string>) {
  const script = workflow.jobs[name].steps.find(step => step.name === 'Aggregate result')!.run!
    .replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, job) => results[job] ?? 'success')
    .replace(/\$\{\{ github.event_name \}\}/g, event);
  expect(script).not.toContain('${{');
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8' }).status;
}

describe('CI execution evidence', () => {
  test('gitleaks and verify run independently for every change, with no pass-marker cache', () => {
    for (const [name, workflow] of [['test.yml', unit], ['e2e.yml', e2e]] as const) {
      const source = readFileSync(join(root, '.github/workflows', name), 'utf8');
      expect(source).not.toMatch(/(?:ci|e2e)-pass-|cache-check|cache-write/);
      expect(source).toContain('bun-cache-');
      expect(source).toContain('pglite-snapshot-');
      expect(workflow.on.pull_request.paths).toBeUndefined();
    }
    for (const name of ['gitleaks', 'verify']) {
      expect(unit.jobs[name].needs).toBeUndefined();
      expect(unit.jobs[name].if).toBeUndefined();
    }
    expect(e2e.jobs.tier2.needs).toBe('jsonb-parity');
    expect(e2e.jobs.tier2.if).toBeUndefined();
  });

  test('unit aggregate rejects failed, cancelled or skipped required jobs', () => {
    expect(unit.jobs['test-status'].if).toBe('always()');
    expect(unit.jobs['test-status'].needs).toEqual([
      'gitleaks', 'verify', 'serial-tests', 'slow-eval-longmemeval',
      'slow-entity-resolve-perf', 'slow-brainbench-e2e', 'brainbench', 'test',
    ]);
    expect(aggregate(unit, 'test-status', 'pull_request', {})).toBe(0);
    for (const job of unit.jobs['test-status'].needs as string[]) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(aggregate(unit, 'test-status', 'pull_request', { [job]: result }), `${job}: ${result}`).toBe(1);
      }
    }
  });

  test('E2E aggregate gates nightly full-corpus execution and allows its skip on other events', () => {
    expect(e2e.jobs['e2e-status'].if).toBe('always()');
    const needs = e2e.jobs['e2e-status'].needs as string[];
    const nightly = ['coverage-full-unit', 'coverage-full-serial', 'coverage-full-slow', 'coverage-full-e2e'];
    expect(needs).toEqual(['jsonb-parity', 'tier1', 'tier2', 'selected-e2e', ...nightly]);
    for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
      expect(aggregate(e2e, 'e2e-status', event, Object.fromEntries(nightly.map(job => [job, 'skipped'])))).toBe(0);
    }
    expect(aggregate(e2e, 'e2e-status', 'schedule', {})).toBe(0);
    for (const job of needs) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(aggregate(e2e, 'e2e-status', 'schedule', { [job]: result }), `${job}: ${result}`).toBe(1);
      }
    }
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
