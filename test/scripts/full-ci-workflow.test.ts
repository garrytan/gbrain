import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

// Full CI on pull requests (docs/ci-event-parity.md#full-ci-on-pull-requests):
// a pull request runs the cheap tier, the full-ci dispatch runs the full suite
// on its head, and a master push may reuse a passed full-suite run of its tree.
type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; 'continue-on-error'?: boolean; env?: Record<string, string>; with?: Record<string, string> };
type Job = { if?: string; name?: string; needs?: string[] | string; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, { types?: string[]; branches?: string[] } | null>; permissions?: unknown; jobs: Record<string, Job> };
const root = join(import.meta.dir, '../..');
const workflow = (name: string) => load(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const unit = workflow('test.yml');
const e2e = workflow('e2e.yml');
const dispatcher = workflow('full-ci.yml');

type Context = { event: string; inputs?: Record<string, unknown>; outputs?: Record<string, string>; action?: string; label?: string; pr?: Record<string, unknown> };
function evaluate(expression: string, context: Context): unknown {
  const js = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/needs\.prepare-e2e\./g, "needs['prepare-e2e'].")
    .replace(/outputs\.(\w+(?:-\w+)+)/g, (_, key) => `outputs['${key}']`)
    .replace(/labels\.\*\.name/g, 'labels.map(label => label.name)');
  const outputs = { 'native-scope': 'full', convergence: 'run', reuse: '', ...context.outputs };
  return runInNewContext(js, {
    always: () => true,
    contains: (list: unknown[], item: unknown) => list.includes(item),
    format: (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])),
    vars: { GBRAIN_PAID_LANES: '' },
    github: { event_name: context.event, repository: 'acme-example/gbrain',
      event: { action: context.action, label: { name: context.label }, pull_request: context.pr ?? {} } },
    inputs: context.inputs ?? {},
    needs: { changes: { outputs }, 'prepare-e2e': { outputs } },
  }, { timeout: 100 });
}
const template = (value: string, context: Context) => value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(evaluate(expression.trim(), context)));
const runs = (w: Workflow, context: Context) =>
  Object.entries(w.jobs).filter(([, job]) => !job.if || Boolean(evaluate(job.if, context))).map(([name]) => name).sort();
const step = (job: Job, name: string) => job.steps!.find(s => s.name === name)!;
const bash = (script: string, env: Record<string, string>, cwd = root) =>
  spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

const CHEAP = ['changes', 'cheap-tier', 'dependency-audit', 'executed-receipts', 'gitleaks', 'security-regressions', 'stress-changed-tests', 'typecheck', 'verify'];
const FULL_ONLY = ['serial-tests', 'slow-brainbench-e2e', 'brainbench', 'slow-entity-resolve-perf', 'test', 'admin-browser',
  'shared-skills-compatibility', 'coverage-report', 'test-status', 'full-suite'];

describe('full CI on pull requests', () => {
  test('a pull request runs exactly the cheap tier, plus the persistence and native lanes its diff selects', () => {
    expect(runs(unit, { event: 'pull_request', outputs: { 'native-scope': 'smoke', convergence: 'skip' } })).toEqual(CHEAP);
    expect(runs(unit, { event: 'pull_request', outputs: { 'native-scope': 'primary', convergence: 'run' } }))
      .toEqual([...CHEAP, 'native-locks', 'persistence-validation'].sort());
    for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
      const full = runs(unit, { event });
      for (const job of [...FULL_ONLY, 'native-locks', 'persistence-validation']) expect(full, `${event}: ${job}`).toContain(job);
      expect(full).not.toContain('cheap-tier');
    }
  });

  test('a pull-request run never reports test-status or full-suite under any name', () => {
    for (const job of ['test-status', 'full-suite']) {
      expect(template(unit.jobs[job]!.name!, { event: 'pull_request' })).toBe('full-suite-not-run');
      for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
        expect(template(unit.jobs[job]!.name!, { event, inputs: event === 'workflow_dispatch' ? { native_only: false, race_hunt: false, stress_files: '', stress_base: '' } : {} })).toBe(job);
      }
    }
    expect(unit.jobs['cheap-tier']!.name).toBe('cheap-tier (full suite not run)');
    expect(unit.jobs['full-suite']!.needs).toContain('test-status');
    expect(e2e.jobs['e2e-full-suite']!.needs).toContain('e2e-status');
  });

  test.each([['test.yml', 'full-suite', 'TEST_STATUS', 'Require test-status'], ['e2e.yml', 'e2e-full-suite', 'E2E_STATUS', 'Require e2e-status']])(
    '%s %s succeeds only when its aggregate succeeded on the same run', (file, job, variable, name) => {
      const require = step(workflow(file).jobs[job]!, name);
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        expect(bash(require.run!, { [variable]: result }).status, result).toBe(result === 'success' ? 0 : 1);
      }
    });

  test('the full-suite artifact records the tree the run checked out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-full-suite-tree-'));
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-qm', 'a');
      const out = join(dir, 'out');
      const result = bash(`bash ${join(root, 'scripts/ci-full-suite-tree.sh')}`,
        { ARTIFACT_DIR: out, RUN_ID: '42', RUN_ATTEMPT: '2', WORKFLOW: 'Test', EVENT: 'workflow_dispatch', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') }, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(out, 'tree.json'), 'utf8'))).toEqual({
        tree: git('rev-parse', 'HEAD^{tree}').stdout.trim(), sha: git('rev-parse', 'HEAD').stdout.trim(),
        workflow: 'Test', event: 'workflow_dispatch', run_id: 42, run_attempt: 2, profile: 'full',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const [w, job, artifact] of [[unit, 'full-suite', 'full-suite-tree'], [e2e, 'e2e-full-suite', 'e2e-full-suite-tree']] as const) {
      const upload = w.jobs[job]!.steps!.find(s => s.uses?.startsWith('actions/upload-artifact@'))!;
      expect(upload.with).toMatchObject({ name: artifact, overwrite: true });
      expect(step(w.jobs[job]!, 'Record the tested tree').run).toBe('bash scripts/ci-full-suite-tree.sh');
    }
  });

  test('E2E never runs on pull_request events; the full-ci label dispatches Test and E2E on a same-repository head', () => {
    expect(e2e.on.pull_request).toBeUndefined();
    expect(dispatcher.on.pull_request).toEqual({ branches: ['master'], types: ['labeled', 'synchronize', 'reopened'] });
    expect(dispatcher.permissions).toEqual({});
    const job = dispatcher.jobs.dispatch!;
    expect(job.permissions).toEqual({ actions: 'write', contents: 'read' });
    const own = { head: { repo: { full_name: 'acme-example/gbrain' } } };
    const fork = { head: { repo: { full_name: 'fork-a/gbrain' } } };
    const labels = (...names: string[]) => names.map(name => ({ name }));
    const cases: Array<[Context, boolean]> = [
      [{ event: 'pull_request', action: 'labeled', label: 'full-ci', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'labeled', label: 'docs', pr: { ...own, labels: labels('docs', 'full-ci') } }, false],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'reopened', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...own, labels: labels('docs') } }, false],
      [{ event: 'pull_request', action: 'labeled', label: 'full-ci', pr: { ...fork, labels: labels('full-ci') } }, false],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...fork, labels: labels('full-ci') } }, false],
    ];
    for (const [context, expected] of cases) expect(Boolean(evaluate(job.if!, context)), JSON.stringify(context)).toBe(expected);
    const run = job.steps![0]!.run!;
    expect(run).toContain('gh workflow run test.yml -R "$REPO" --ref "$BRANCH"');
    expect(run).toContain('gh workflow run e2e.yml -R "$REPO" --ref "$BRANCH"');
    expect(run.indexOf('"$current" != "$HEAD_SHA"')).toBeLessThan(run.indexOf('gh workflow run'));
  });

  describe('cheap-tier aggregator', () => {
    const green = { GITLEAKS: 'success', SECURITY: 'success', AUDIT: 'success', VERIFY: 'success', TYPECHECK: 'success', STRESS: 'success',
      NATIVE: 'skipped', NATIVE_SCOPE: 'smoke', PERSISTENCE: 'skipped', CONVERGENCE: 'skip' };
    const aggregate = (env: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-cheap-tier-'));
      try {
        const summary = join(dir, 'summary.md');
        const result = bash(`bash ${join(root, 'scripts/ci-cheap-tier.sh')}`, { ...env, GITHUB_STEP_SUMMARY: summary });
        return { status: result.status, summary: readFileSync(summary, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('green when every cheap lane passed; the summary always says the full suite did not run', () => {
      const result = aggregate(green);
      expect(result.status).toBe(0);
      expect(result.summary).toContain('## Full suite not run');
      expect(result.summary).toContain('`full-suite` and `e2e-full-suite`');
      expect(aggregate({ ...green, NATIVE: 'success', NATIVE_SCOPE: 'primary', PERSISTENCE: 'success', CONVERGENCE: 'run' }).status).toBe(0);
    });

    test.each(['GITLEAKS', 'SECURITY', 'AUDIT', 'VERIFY', 'TYPECHECK', 'STRESS'])('%s not succeeding fails the tier', lane => {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        expect(aggregate({ ...green, [lane]: result }).status, `${lane}=${result}`).toBe(1);
      }
    });

    test('a selected persistence or native lane must succeed; only an unselected one may skip', () => {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(aggregate({ ...green, NATIVE: result, NATIVE_SCOPE: 'primary' }).status).toBe(1);
        expect(aggregate({ ...green, PERSISTENCE: result, CONVERGENCE: 'run' }).status).toBe(1);
      }
      expect(aggregate({ ...green, NATIVE: 'failure' }).status).toBe(1);
      expect(aggregate({ ...green, PERSISTENCE: 'cancelled' }).status).toBe(1);
    });
  });
});

describe('master-push reuse of a passed full-suite run', () => {
  test('only a push computes reuse, and a crash leaves it unset (a full run)', () => {
    for (const [w, job] of [[unit, 'changes'], [e2e, 'prepare-e2e']] as const) {
      const reuse = w.jobs[job]!.steps!.find(s => s.id === 'reuse')!;
      expect(reuse.if).toBe("github.event_name == 'push'");
      expect(reuse['continue-on-error']).toBe(true);
      expect(reuse.run).toContain(`--workflow ${w === unit ? 'test' : 'e2e'}`);
      expect(w.jobs[job]!.permissions).toMatchObject({ actions: 'read', contents: 'read' });
    }
  });

  test('a reusing push skips every full lane and both aggregates, and runs the marker the release gate reads', () => {
    const reused = runs(unit, { event: 'push', outputs: { reuse: 'true' } });
    expect(reused).toContain('reused-full-suite');
    for (const job of [...FULL_ONLY, 'native-locks', 'persistence-validation', 'executed-receipts']) expect(reused, job).not.toContain(job);
    const full = runs(unit, { event: 'push' });
    expect(full).not.toContain('reused-full-suite');
    for (const job of [...FULL_ONLY, 'native-locks', 'persistence-validation']) expect(full, job).toContain(job);

    const e2eReused = runs(e2e, { event: 'push', outputs: { reuse: 'true' } });
    expect(e2eReused).toContain('reused-full-suite');
    for (const job of ['jsonb-parity', 'tier1', 'tier1-graduation', 'tier1-backend-matrix', 'selected-e2e', 'executed-receipts', 'e2e-status', 'e2e-full-suite']) {
      expect(e2eReused, job).not.toContain(job);
      expect(runs(e2e, { event: 'push' }), job).toContain(job);
    }
    expect(e2e.jobs.tier2!.needs).toBe('jsonb-parity');
  });
});
