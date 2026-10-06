/**
 * scripts/stress/gate.ts: the PR stress gate and race-hunt planner and
 * reporter (docs/TESTING.md#stress-gate, docs/TESTING.md#race-hunt).
 * GitHub calls go through a recorded fake client.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubClient } from '../../scripts/lib/gh-issue.ts';
import {
  RACE_MAX_SHARDS, RACE_MIN_ITERATIONS, RACE_SHARD_BUDGET_MS, buildReport, loadExemptions, matchExemption, missingWork,
  parseExemptionBlocks, planGate, planRaceHunt, shardTimings, type GhIssue, type Plan, type StressFailure,
} from '../../scripts/stress/gate.ts';
import type { Weights } from '../../scripts/stress/plan.ts';

const REPO = join(import.meta.dir, '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(files: Record<string, string>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-stress-gate-'));
  dirs.push(root);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 's@example.invalid'); git('config', 'user.name', 's'); git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  git('add', '-A'); git('commit', '-qm', 'base');
  return { root, base: git('rev-parse', 'HEAD') };
}
const commit = (root: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  spawnSync('git', ['add', '-A'], { cwd: root }); spawnSync('git', ['commit', '-qm', 'pr'], { cwd: root });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
};
const weights = (arms: Record<string, number> = {}): Weights => ({ unit: new Map(), serialSeconds: new Map(), e2e: new Map(), arms: new Map(Object.entries(arms)) });
const isPlan = (p: Plan | { error: string }): Plan => { if ('error' in p) throw new Error(p.error); return p; };

describe('gate plan', () => {
  test('outside pull_request and merge_group the gate succeeds with "not a PR event"', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const plan = isPlan(planGate(REPO, { event }, weights()));
      expect(plan).toMatchObject({ run: false, reason: 'not a PR event' });
      const report = buildReport({ plan, planResult: 'success', shardsResult: 'skipped', manifests: [], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: '' });
      expect(report.exit).toBe(0);
      expect(report.summary).toContain('**Passed:** not a PR event.');
    }
  });

  test('a pull request plans every changed test file at 10 iterations, and lists paid-provider files as not stressed', () => {
    const { root, base } = repo({ 'test/a.test.ts': "test('a', () => {});\n", 'test/b.test.ts': "test('b', () => {});\n" });
    const head = commit(root, { 'test/a.test.ts': "test('a2', () => {});\n", 'test/e2e/x.live.test.ts': "test('paid', () => {});\n", 'test/c.serial.test.ts': "test('c', () => {});\n" });
    const plan = isPlan(planGate(root, { event: 'pull_request', baseSha: base, headSha: head }, weights()));
    expect(plan.run).toBe(true);
    expect(plan.files.map(f => [f.file, f.profile, f.iterations])).toEqual([['test/a.test.ts', 'unit', 10], ['test/c.serial.test.ts', 'serial', 10]]);
    expect(plan.notStressed).toEqual([{ file: 'test/e2e/x.live.test.ts', reason: expect.stringContaining('paid-provider') }]);
    expect(plan.shards.flatMap(s => s.items).reduce((n, i) => n + i.count, 0)).toBe(20);
  });

  test('a missing merge base fails the plan with the fetch next step', () => {
    const { root } = repo({ 'test/a.test.ts': '' });
    const result = planGate(root, { event: 'merge_group', baseSha: 'f'.repeat(40), headSha: 'HEAD' }, weights());
    expect('error' in result && result.error).toContain('Next: git fetch');
    const report = buildReport({ plan: undefined, planResult: 'failure', shardsResult: 'skipped', manifests: [], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(report.exit).toBe(1);
    expect(report.summary).toContain('fetch it (`git fetch --no-tags origin master`)');
  });

  test('dispatch inputs are validated before use and the run is labeled diagnostic', () => {
    expect(planGate(REPO, { event: 'workflow_dispatch', stressFiles: 'test/a.test.ts $(curl x)' }, weights())).toMatchObject({ error: expect.stringContaining('not repo-relative test files') });
    expect(planGate(REPO, { event: 'workflow_dispatch', stressBase: 'master;id' }, weights())).toMatchObject({ error: expect.stringContaining('must be 40-hex SHAs or valid ref names') });
    const plan = isPlan(planGate(REPO, { event: 'workflow_dispatch', stressFiles: 'test/scripts/stress-plan.test.ts' }, weights()));
    expect(plan).toMatchObject({ run: true, diagnostic: true });
    const workflow = readFileSync(join(REPO, '.github/workflows/stress.yml'), 'utf8');
    expect(workflow).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\./);
  });
});

describe('PostgreSQL arm routing', () => {
  // A wrapper-laned arm (registerPostgresTests) never runs with DATABASE_URL
  // alone; the #5927 replay flagged it "never connected" 10 of 10 times.
  test('a file whose arm runs through a test/e2e wrapper is stressed with that wrapper', () => {
    const plan = isPlan(planGate(REPO, { event: 'workflow_dispatch', stressFiles: 'test/autopilot-auto-drain-dispatch.test.ts' }, weights()));
    expect(plan.files.map(f => [f.file, f.profile])).toEqual([['test/autopilot-auto-drain-dispatch.test.ts', 'unit'], ['test/e2e/autopilot-auto-drain-dispatch.test.ts', 'e2e']]);
  });

  test('a listed unit-lane arm runs both arms against a fresh database', () => {
    const plan = isPlan(planGate(REPO, { event: 'workflow_dispatch', stressFiles: 'test/managed-lint.test.ts' }, weights()));
    expect(plan.files.map(f => [f.file, f.profile])).toEqual([['test/managed-lint.test.ts', 'postgres-arm']]);
  });
});

describe('race hunt plan', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `test/arm-${String(i).padStart(2, '0')}.test.ts`);
  function armsRepo(n: number) {
    const files: Record<string, string> = { 'test/postgres-unit-arms.txt': `${list(n).join('\n')}\n` };
    for (const f of list(n)) files[f] = "for (const b of testBackends()) describe(b, () => { test('x', () => {}); });\n";
    return repo(files).root;
  }

  test('every listed file runs 10 iterations when the set fits 12 shards of 55 minutes', () => {
    const root = armsRepo(20);
    const plan = planRaceHunt(root, { day: 3 }, weights(Object.fromEntries(list(20).map(f => [f, 60_000]))));
    expect(plan.files.every(f => f.iterations === 10 && f.profile === 'postgres-arm')).toBe(true);
    expect(plan.unrun).toEqual([]);
    expect(plan.shards.length).toBeLessThanOrEqual(RACE_MAX_SHARDS);
    expect(plan.shards.every(s => s.estimateMs <= RACE_SHARD_BUDGET_MS)).toBe(true);
  });

  test('past 12 shards depth drops to no fewer than 3 nightly and the spare capacity rotates by day', () => {
    const root = armsRepo(30);
    const w = weights(Object.fromEntries(list(30).map(f => [f, 4 * 60_000])));
    const monday = planRaceHunt(root, { day: 1 }, w);
    const tuesday = planRaceHunt(root, { day: 2 }, w);
    expect(monday.unrun).toEqual([]);
    expect(monday.files.every(f => f.iterations >= RACE_MIN_ITERATIONS && f.iterations <= 10)).toBe(true);
    expect(monday.files.length).toBe(30);
    const deep = (p: Plan) => p.files.filter(f => f.iterations > Math.min(...p.files.map(x => x.iterations))).map(f => f.file);
    expect(deep(monday)).not.toEqual(deep(tuesday));
    expect(monday.shards.every(s => s.estimateMs <= RACE_SHARD_BUDGET_MS)).toBe(true);
  });

  test('a set that does not fit at 3 iterations fails "race hunt over budget" naming the unrun files', () => {
    const root = armsRepo(10);
    const plan = planRaceHunt(root, { day: 0 }, weights(Object.fromEntries(list(10).map(f => [f, 40 * 60_000]))));
    expect(plan.unrun.length).toBeGreaterThan(0);
    const report = buildReport({ plan, planResult: 'success', shardsResult: 'success', manifests: [], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(report.exit).toBe(1);
    expect(report.summary).toContain('### Race hunt over budget');
    expect(report.errors.join('\n')).toContain('race hunt over budget');
    for (const f of plan.unrun) expect(report.summary).toContain(f);
  });
});

const failure = (over: Partial<StressFailure> = {}): StressFailure => ({
  file: 'test/a.test.ts', iteration: 3, seed: 12, test: 'suite > counts', backend: 'pglite+postgres', signature: 'expect(received).toBe(expected) Expected: N Received: N',
  message: 'expect(received).toBe(expected)\n\nExpected: 7\nReceived: 6', reproduce: 'bun run test:stress test/a.test.ts --iterations 10 --first-iteration 3 --seed 10 --postgres',
  context: 'sha abc, Bun 1.4.2, backend pglite+postgres, profile postgres-arm (database), iteration 3, seed 12', ...over,
});
const gatePlan = (files: string[]): Plan => ({
  version: 1, mode: 'gate', run: true, reason: 'x', diagnostic: false, head: 'h', base: 'b', notStressed: [], helpers: [], unrun: [], iterations: 10, budgetMs: 1, estimateMs: 1,
  files: files.map(file => ({ file, profile: 'postgres-arm', iterations: 10, estimateMs: 1 })),
  shards: [{ index: 1, estimateMs: 1, items: files.map(file => ({ file, first: 1, count: 10, estimateMs: 1 })) }],
});
const manifest = (files: string[], failures: StressFailure[]) => ({
  sha: 'abc', bun: '1.4.2', run_id: '1', artifact: '', setup_ms: 0, run_ms: 0, failures,
  files: files.map(file => ({ file, status: failures.some(f => f.file === file) ? 'fail' : 'pass', firstIteration: 1, iterations: Array.from({ length: 10 }, (_, i) => ({ index: i + 1 })) })),
});

describe('report', () => {
  test('a failure fails the check with file, iteration, reproduce line and the root-cause rule; credentials never print', () => {
    const plan = gatePlan(['test/a.test.ts']);
    const report = buildReport({ plan, planResult: 'success', shardsResult: 'success', manifests: [manifest(['test/a.test.ts'], [failure({ message: 'connect postgres://gbrain_test:hunter2@127.0.0.1/gbrain_test refused' })])], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: 'https://example.invalid/run/1' });
    expect(report.exit).toBe(1);
    expect(report.summary).toContain('A flaky touched file must be root-caused in this PR');
    expect(report.summary).toContain('bun run test:stress test/a.test.ts --iterations 10 --first-iteration 3 --seed 10 --postgres');
    expect(report.summary).not.toContain('hunter2');
    expect(report.errors[0]).toMatch(/^file=test\/a\.test\.ts::stress gate: failed 1 of 10 iterations \(first: iteration 3\)/);
    expect(report.errors[0]).toContain('Docs: docs/TESTING.md#stress-gate');
  });

  test('more than three failing files are each listed', () => {
    const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'test/e.test.ts'];
    const report = buildReport({ plan: gatePlan(files), planResult: 'success', shardsResult: 'success', manifests: [manifest(files, files.map(file => failure({ file })))], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(report.errors).toHaveLength(5);
    for (const f of files) expect(report.summary).toContain(`\`${f}\``);
  });

  test('a matching unexpired exemption passes that failure only; a new signature still fails', () => {
    const plan = gatePlan(['test/a.test.ts']);
    const ex = { file: 'test/a.test.ts', test: 'suite > counts', backend: 'pglite+postgres', signature: failure().signature, owner: '@release-duty', expires: '2026-10-20', issue: 7, url: 'https://example.invalid/issues/7' };
    const known = buildReport({ plan, planResult: 'success', shardsResult: 'success', manifests: [manifest(['test/a.test.ts'], [failure()])], exemptions: { exemptions: [ex], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(known.exit).toBe(0);
    expect(known.summary).toContain('matches the open issue https://example.invalid/issues/7');
    const fresh = buildReport({ plan, planResult: 'success', shardsResult: 'success', manifests: [manifest(['test/a.test.ts'], [failure(), failure({ signature: 'TypeError: x is undefined', iteration: 5 })])], exemptions: { exemptions: [ex], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(fresh.exit).toBe(1);
    expect(matchExemption(failure(), [{ ...ex, expires: '2026-10-04' }], '2026-10-05')).toBeUndefined();
    expect(matchExemption(failure({ backend: 'pglite' }), [ex], '2026-10-05')).toBeUndefined();
  });

  test('an iteration without a receipt is incomplete and fails, never a pass', () => {
    const plan = gatePlan(['test/a.test.ts', 'test/b.test.ts']);
    const m = manifest(['test/a.test.ts'], []);
    expect(missingWork(plan, [m])).toEqual(['test/b.test.ts iterations 1-10 (shard 1)']);
    const report = buildReport({ plan, planResult: 'success', shardsResult: 'failure', manifests: [m], exemptions: { exemptions: [], openIssues: [] }, today: '2026-10-05', artifact: '' });
    expect(report.exit).toBe(1);
    expect(report.summary).toContain('### Incomplete');
  });

  test('p95 queue and completion come from the shard jobs only', () => {
    const t = (name: string, c: number, s: number, e: number) => ({ name, created_at: new Date(c * 60_000).toISOString(), started_at: new Date(s * 60_000).toISOString(), completed_at: new Date(e * 60_000).toISOString() });
    const timings = shardTimings([t('stress-changed-tests / Stress shard 1', 0, 1, 11), t('stress-changed-tests / Stress shard 2', 0, 3, 23), t('test (1)', 0, 0, 99), { ...t('race-hunt / Race hunt shard ${{ matrix.shard }}', 0, 0, 0), conclusion: 'skipped' }]);
    expect(timings).toEqual({ shards: 2, p95QueueMin: 3, p95CompletionMin: 23, runnerMin: 30 });
  });
});

describe('exemption trust', () => {
  const block = (row: Record<string, string>) => `<!-- gbrain-stress-exemption -->\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\``;
  const row = { file: 'test/a.test.ts', test: 'suite > counts', backend: 'pglite+postgres', signature: 'sig', owner: '@duty', expires: '2026-10-20' };
  function client(issues: Record<string, GhIssue[]>, extras: Record<string, unknown> = {}): GitHubClient {
    return { async request<T>(_m: string, path: string): Promise<T> {
      const label = /labels=([^&]+)/.exec(path)?.[1];
      if (label) return (issues[decodeURIComponent(label)] ?? []) as T;
      for (const [k, v] of Object.entries(extras)) if (path.includes(k)) { if (v instanceof Error) throw v; return v as T; }
      return [] as T;
    } };
  }

  test('blocks parse from issue bodies; malformed or incomplete rows grant nothing', () => {
    expect(parseExemptionBlocks(`x\n${block(row)}\n${block({ ...row, expires: 'soon' })}\n<!-- gbrain-stress-exemption -->\n\`\`\`json\n{oops\n\`\`\``)).toEqual([row]);
  });

  test('bot- or maintainer-opened issues that predate the PR exempt; a forged flake issue from a non-maintainer does not', async () => {
    const issues: Record<string, GhIssue[]> = {
      flake: [
        { number: 1, created_at: '2026-10-01T00:00:00Z', user: { login: 'github-actions[bot]' }, author_association: 'NONE', body: block(row) },
        { number: 2, created_at: '2026-10-01T00:00:00Z', user: { login: 'drive-by' }, author_association: 'NONE', body: block({ ...row, test: 'forged' }) },
        { number: 3, created_at: '2026-10-09T00:00:00Z', user: { login: 'maintainer' }, author_association: 'MEMBER', body: block({ ...row, test: 'too new' }) },
      ],
    };
    const r = await loadExemptions(client(issues, { 'issues/2/events': [{ event: 'labeled', label: { name: 'flake' }, actor: { login: 'drive-by' } }], 'collaborators/drive-by/permission': { permission: 'read' } }), '2026-10-05T00:00:00Z');
    expect(r.incomplete).toBeUndefined();
    expect(r.exemptions.map(e => [e.issue, e.test])).toEqual([[1, 'suite > counts']]);
  });

  test('a maintainer label makes a contributor-opened issue count; a non-maintainer comment block is ignored', async () => {
    const issues: Record<string, GhIssue[]> = { 'master-red': [{ number: 4, created_at: '2026-10-01T00:00:00Z', user: { login: 'contrib' }, author_association: 'CONTRIBUTOR', body: '' }] };
    const r = await loadExemptions(client(issues, {
      'issues/4/events': [{ event: 'labeled', label: { name: 'master-red' }, actor: { login: 'lead' } }],
      'collaborators/lead/permission': { permission: 'admin' },
      'issues/4/comments': [{ user: { login: 'lead' }, author_association: 'OWNER', body: block(row) }, { user: { login: 'contrib' }, author_association: 'CONTRIBUTOR', body: block({ ...row, test: 'forged' }) }],
    }), '2026-10-05T00:00:00Z');
    expect(r.exemptions.map(e => e.test)).toEqual(['suite > counts']);
  });

  test('an API failure is incomplete evidence and grants no exemption', async () => {
    const failing: GitHubClient = { async request() { throw new Error('HTTP 502'); } };
    const r = await loadExemptions(failing, '2026-10-05T00:00:00Z');
    expect(r).toMatchObject({ exemptions: [], incomplete: 'HTTP 502' });
    const report = buildReport({ plan: gatePlan(['test/a.test.ts']), planResult: 'success', shardsResult: 'success', manifests: [manifest(['test/a.test.ts'], [failure()])], exemptions: r, today: '2026-10-05', artifact: '' });
    expect(report.exit).toBe(1);
    expect(report.summary).toContain('Exemption lookup incomplete');
  });
});

describe('docs anchors', () => {
  test('every anchor the runner and the gate print resolves', () => {
    const testing = readFileSync(join(REPO, 'docs/TESTING.md'), 'utf8');
    expect(testing).toContain('### Stress gate');
    expect(testing).toContain('### Race hunt');
    expect(testing).toContain('#### Postgres-arm lanes');
    expect(readFileSync(join(REPO, 'scripts/stress/README.md'), 'utf8')).toContain('## Race hunt');
  });
});
