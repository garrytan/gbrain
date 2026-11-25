/**
 * unit-suite-gate (docs/ci-event-parity.md#unit-suite-gate): one always-run check with a fixed name that fails when the
 * unit suite failed and passes when it passed or was rightly skipped. Covers the pull-request scope, the verdict, the
 * CLI on a skipped-suite path and a failing-suite path, and the workflow's own name and needs expressions.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';
import { judge, unitScope, type PrFile, type Policy } from '../../scripts/ci-unit-suite-gate.ts';

const root = join(import.meta.dir, '../..');
const policy = JSON.parse(readFileSync(join(root, '.gstack/ship-policy.json'), 'utf8')) as Policy;
const bump = (line: (v: string) => string) => `@@ -1 +1 @@\n-${line('0.60.769.0')}\n+${line('0.60.770.0')}`;
const release: PrFile[] = [
  { filename: 'VERSION', status: 'modified', patch: bump(v => v) },
  { filename: 'package.json', status: 'modified', patch: `@@ -1,4 +1,4 @@\n {\n   "name": "gbrain",\n-  "version": "0.60.769.0",\n+  "version": "0.60.770.0",` },
  { filename: 'plugin-variants/gbrain-daily/.claude-plugin/plugin.json', status: 'modified', patch: bump(v => `  "version": "${v}",`) },
  { filename: 'plugin/README.md', status: 'modified', patch: bump(v => `<!-- gbrain-plugin-tree-stamp: ${v} -->`) },
  { filename: 'BOOTSTRAP_FOR_AGENTS.md', status: 'modified', patch: bump(v => `<!-- gbrain-runbook-stamp: ${v} -->`) },
  { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -1,3 +1,6 @@\n+## [0.60.770.0]\n+\n+- Something a user sees.' },
  { filename: 'changelog.d/alice-example-fix.md', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-bump: patch\n-- Something a user sees.' },
];

describe('unitScope: which pull requests rightly skip the unit suite', () => {
  test('a release PR that moves only stamps and folds changelog entries is release-only', () => {
    expect(unitScope(release, release.length, policy)).toEqual({ unit: 'skip', why: 'release-only: only release stamps and changelog entries change' });
  });

  test('a PR that only adds or edits changelog entries is changelog-only', () => {
    const files = [{ filename: 'changelog.d/acme-example.md', status: 'added', patch: '@@ -0,0 +1 @@\n+bump: patch' }, { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -3 +3 @@\n-a\n+b' }];
    expect(unitScope(files, 2, policy)).toEqual({ unit: 'skip', why: 'changelog-only: only changelog entries change' });
  });

  test('anything more runs the suite: code, a stamp file with a non-stamp line, a generated file, no patch, a short list', () => {
    const run = (files: PrFile[], changed = files.length) => unitScope(files, changed, policy).unit;
    expect(run([...release, { filename: 'src/core/behavior-changes.generated.ts', status: 'modified', patch: '@@ -1 +1 @@\n+export const X = 1;' }])).toBe('run');
    expect(run([{ filename: 'package.json', status: 'modified', patch: '@@ -5 +5 @@\n-  "zod": "4.3.6",\n+  "zod": "4.6.6",' }])).toBe('run');
    expect(run([{ filename: 'plugin/README.md', status: 'modified', patch: '@@ -9 +9 @@\n-old words\n+new words' }])).toBe('run');
    expect(run([{ filename: 'VERSION', status: 'modified', patch: '@@ -1 +1 @@\n-0.60.1.0\n+not-a-version' }])).toBe('run');
    expect(run([{ filename: 'package.json', status: 'modified', patch: '@@ -3 +3 @@\n-  "version": "0.60.769.0",\n+  "version": "0.60.770.0", "scripts": {"postinstall": "x"},' }])).toBe('run');
    expect(run([{ filename: 'plugin/README.md', status: 'modified', patch: '@@ -1 +1 @@\n-<!-- gbrain-plugin-tree-stamp: 0.60.769.0 -->\n+<!-- gbrain-plugin-tree-stamp: 0.60.770.0 --> extra text' }])).toBe('run');
    expect(run([{ filename: 'plugin/README.md', status: 'modified', patch: '@@ -1 +1 @@\n-<!-- gbrain-plugin-tree-stamp: 0.60.769.0 -->\n+text <!-- gbrain-plugin-tree-stamp: 0.60.770.0 -->' }])).toBe('run');
    expect(run([{ filename: 'package.json', status: 'modified' }])).toBe('run');
    expect(run([{ filename: 'docs/guide.md', status: 'renamed', previous_filename: 'changelog.d/x.md', patch: '' }])).toBe('run');
    expect(run(release, release.length + 1)).toBe('run');
    expect(run([], 0)).toBe('run');
  });
});

describe('judge: the verdict on each event', () => {
  test('failing-suite paths fail: a failed, cancelled or unexplained skipped unit suite', () => {
    for (const event of ['push', 'workflow_dispatch', 'schedule', 'merge_group']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) expect(judge({ event, test: result, reuse: '' })).toMatchObject({ gate: true, ok: false });
    }
    expect(judge({ event: 'push', test: 'failure', reuse: 'true' }).ok).toBe(false);
  });

  test('skipped-suite paths pass: a reusing master push and a changelog-only or release-only pull request', () => {
    expect(judge({ event: 'push', test: 'skipped', reuse: 'true' })).toMatchObject({ gate: true, ok: true });
    expect(judge({ event: 'pull_request', test: 'skipped', unit: 'skip' })).toMatchObject({ gate: true, ok: true });
    expect(judge({ event: 'workflow_dispatch', test: 'success' })).toMatchObject({ gate: true, ok: true });
  });

  test('a code pull request is not the gate', () => {
    expect(judge({ event: 'pull_request', test: 'skipped', unit: 'run' })).toMatchObject({ gate: false, ok: true });
    expect(judge({ event: 'pull_request', test: 'skipped', unit: '' })).toMatchObject({ gate: false, ok: true });
  });
});

describe('the CLI as the job runs it', () => {
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync('bun', ['scripts/ci-unit-suite-gate.ts', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } });

  test('scope reads the pull request file list and prints skip or run; an unreadable list runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-suite-gate-'));
    try {
      const files = join(dir, 'files.ndjson');
      writeFileSync(files, release.map(f => JSON.stringify(f)).join('\n') + '\n');
      expect(cli(['scope', '--files', files, '--changed', String(release.length)]).stdout.trim()).toBe('skip');
      expect(cli(['scope', '--files', files, '--changed', '99']).stdout.trim()).toBe('run');
      expect(cli(['scope', '--files', join(dir, 'missing.ndjson'), '--changed', '1']).stdout.trim()).toBe('run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('judge exits 1 on a failing suite and 0 on a rightly skipped one', () => {
    const failing = cli(['judge'], { EVENT: 'workflow_dispatch', TEST_RESULT: 'failure', REUSE: '', UNIT: '' });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('::error::unit-suite-gate fails: the unit suite did not pass (test: failure)');
    expect(cli(['judge'], { EVENT: 'push', TEST_RESULT: 'skipped', REUSE: 'true', UNIT: '' }).status).toBe(0);
    expect(cli(['judge'], { EVENT: 'pull_request', TEST_RESULT: 'skipped', REUSE: '', UNIT: 'skip' }).status).toBe(0);
    expect(cli(['judge'], { EVENT: 'push', TEST_RESULT: 'skipped', REUSE: '', UNIT: '' }).status).toBe(1);
  });
});

describe('test.yml unit-suite-gate job', () => {
  type Step = { id?: string; if?: string; env?: Record<string, string>; run?: string; with?: Record<string, string> };
  type Job = { name?: string; if?: string; needs?: string[]; outputs?: Record<string, string>; steps?: Step[] };
  const jobs = (load(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs;
  const gate = jobs['unit-suite-gate']!;
  const evaluate = (expression: string, event: string, unit = '', inputs: Record<string, unknown> = {}) => runInNewContext(
    expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''),
    { always: () => true, github: { event_name: event }, inputs: { native_only: false, race_hunt: false, stress_files: '', stress_base: '', ...inputs }, needs: { changes: { outputs: { unit } } } },
  );

  test('it always runs, after the changes and unit-suite jobs, except on a scoped dispatch', () => {
    for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule', 'merge_group']) expect(evaluate(gate.if!, event)).toBe(true);
    for (const inputs of [{ native_only: true }, { race_hunt: true }, { stress_files: 'test/a.test.ts' }, { stress_base: 'origin/master' }]) expect(evaluate(gate.if!, 'workflow_dispatch', '', inputs)).toBe(false);
    expect(gate.needs).toEqual(['changes', 'test']);
    expect(gate.steps!.at(-1)!.run).toBe('bun scripts/ci-unit-suite-gate.ts judge');
    expect(gate.steps!.at(-1)!.env!.TEST_RESULT).toBe('${{ needs.test.result }}');
  });

  test('its name is fixed, with no Bun version or shard count, and only a judging run carries it', () => {
    expect(gate.name).not.toMatch(/matrix|bun|shard/i);
    for (const event of ['push', 'workflow_dispatch', 'schedule', 'merge_group']) expect(evaluate(gate.name!, event)).toBe('unit-suite-gate');
    expect(evaluate(gate.name!, 'pull_request', 'skip')).toBe('unit-suite-gate');
    expect(evaluate(gate.name!, 'pull_request', 'run')).toBe('unit-suite-not-run');
    expect(evaluate(gate.name!, 'pull_request', '')).toBe('unit-suite-not-run');
    expect(evaluate(gate.name!, 'workflow_dispatch', '', { native_only: true })).toBe('unit-suite-not-run');
    expect(evaluate(gate.name!, 'workflow_dispatch', '', { stress_files: 'test/a.test.ts' })).toBe('unit-suite-not-run');
  });

  test('the changes job reads the scope only on pull requests, from a checkout that has the script and the ship policy', () => {
    const changes = jobs.changes as Required<Pick<Job, 'outputs' | 'steps'>>;
    expect(changes.outputs.unit).toBe('${{ steps.unit.outputs.unit }}');
    expect(changes.steps.find(s => s.id === 'unit')!.if).toBe("github.event_name == 'pull_request'");
    for (const step of changes.steps.filter(s => s.with?.['sparse-checkout'])) {
      expect(step.with!['sparse-checkout']).toContain('scripts/ci-unit-suite-gate.ts');
      expect(step.with!['sparse-checkout']).toContain('.gstack/ship-policy.json');
    }
  });
});
