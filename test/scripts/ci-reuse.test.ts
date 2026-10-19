/**
 * scripts/ci-reuse.ts: a push to master reuses the complete full run of the
 * same workflow (a workflow_dispatch on the PR head, or an earlier push) only
 * when that run's latest attempt and its full-suite job succeeded and its
 * tested-tree artifact (profile full) records the push commit's tree.
 * Pull-request runs (the cheap tier) are never candidates, and a diagnostic
 * dispatch skips full-suite. Every other case (API error, cancelled, partial,
 * re-run in progress, artifact missing or cheap, tree mismatch, non-merge
 * push) falls back to a full run with a reason code. Fixtures only; no network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiDeps, checkRecord, decide, PROFILES, writeDecision, type Commit, type JobRow, type FullRun, type ReuseDeps } from '../../scripts/ci-reuse.ts';
import type { GitHubClient } from '../../scripts/lib/gh-issue.ts';

const REPO = 'owner-example/repo-example';
const M = '1'.repeat(40);
const BASE = '2'.repeat(40);
const H = '3'.repeat(40);
const H2 = '4'.repeat(40);
const T = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const prRun = (over: Partial<FullRun> = {}): FullRun => ({
  id: 500, run_number: 50, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: H, event: 'workflow_dispatch',
  head_repository: { full_name: REPO }, ...over,
});
const treeJson = (run: FullRun, over: Record<string, unknown> = {}) => ({ tree: T, sha: run.head_sha, head_sha: run.head_sha, workflow: 'Test', event: run.event, run_id: run.id, run_attempt: run.run_attempt, profile: 'full', ...over });

interface Fixture {
  commits?: Record<string, Commit>;
  runs?: FullRun[];
  jobs?: Record<string, JobRow[]>;
  artifacts?: Record<number, { value?: unknown; reason?: string }>;
  fail?: 'runs' | 'jobs' | 'commit';
}

function fixture(f: Fixture): ReuseDeps & { jobCalls: string[] } {
  const commits = f.commits ?? { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] } };
  const runs = f.runs ?? [];
  const jobCalls: string[] = [];
  return {
    jobCalls,
    async commit(sha) {
      if (f.fail === 'commit' || !commits[sha]) throw new Error(`GitHub API GET git/commits/${sha} -> 404`);
      return commits[sha]!;
    },
    async runsForHead(file, sha) {
      if (f.fail === 'runs') throw new Error('GitHub API GET actions/runs -> 502: bad gateway');
      expect(file).toBe('test.yml');
      return runs.filter(r => r.head_sha === sha);
    },
    async recentSuccessfulRuns() { return runs.filter(r => r.conclusion === 'success'); },
    async jobs(runId, attempt) {
      if (f.fail === 'jobs') throw new Error('GitHub API GET jobs -> 500');
      jobCalls.push(`${runId}/${attempt}`);
      return f.jobs?.[`${runId}/${attempt}`] ?? [{ name: 'full-suite', status: 'completed', conclusion: 'success' }];
    },
    async artifact(runId, name) {
      expect(name).toBe('full-suite-tree');
      return f.artifacts?.[runId] ?? { reason: `run ${runId} has no '${name}' artifact` };
    },
  };
}

const green = (run = prRun()) => fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });

describe('ci-reuse decision', () => {
  test('reuses the complete full-suite dispatch run on the merged PR head when its tested tree equals the push tree', async () => {
    const d = await decide(green(), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: true, reason: 'identical_tree_full_run', tree: T, source: { run_id: 500, run_attempt: 1, sha: H } });
  });

  test('a pull_request run (the cheap tier) on the merged head is never a candidate', async () => {
    const run = prRun({ event: 'pull_request' });
    const d = await decide(green(run), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'no_candidate', rejected: [] });
    expect(d.detail).toContain('workflow_dispatch or push');
  });

  test('a recorded tree that differs from the push tree falls back', async () => {
    const run = prRun();
    const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run, { tree: OTHER }) } } }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'tree_mismatch' });
  });

  test('a recorded tree equal to the push tree but not the tree of the run head commit falls back', async () => {
    const run = prRun();
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: OTHER, parents: [BASE] } }, runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'tree_mismatch' });
  });

  test('a cancelled run falls back', async () => {
    const run = prRun({ conclusion: 'cancelled' });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_cancelled' });
  });

  test('a failed latest attempt falls back even when an earlier attempt was green', async () => {
    const run = prRun({ run_attempt: 2, conclusion: 'failure' });
    const deps = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'success' }] }, artifacts: { [run.id]: { value: treeJson(run, { run_attempt: 1 }) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_failed' });
    expect(deps.jobCalls).toEqual([]);
  });

  test('a re-run in progress falls back', async () => {
    const run = prRun({ run_attempt: 2, status: 'in_progress', conclusion: null });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_in_progress' });
  });

  test('a missing or unreadable artifact falls back', async () => {
    const d = await decide(fixture({ runs: [prRun()] }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'artifact_missing' });
    expect(d.detail).toContain("no 'full-suite-tree' artifact");
    const junk = await decide(fixture({ runs: [prRun()], artifacts: { 500: { value: 'not a json object' } } }), PROFILES.test, M, REPO);
    expect(junk).toMatchObject({ reuse: false, reason: 'artifact_mismatch' });
  });

  test('an artifact with profile cheap falls back', async () => {
    const run = prRun();
    const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run, { profile: 'cheap' }) } } }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'artifact_not_full' });
  });

  test('an artifact recorded by another attempt, run, head or workflow falls back', async () => {
    const run = prRun({ run_attempt: 2 });
    for (const over of [{ run_attempt: 1 }, { run_id: 499 }, { sha: H2 }, { head_sha: H2 }, { event: 'pull_request' }, { workflow: 'E2E Tests' }]) {
      const deps = fixture({ runs: [run], jobs: { '500/2': [{ name: 'full-suite', conclusion: 'success' }] }, artifacts: { [run.id]: { value: treeJson(run, over) } } });
      expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'artifact_mismatch' });
    }
  });

  test('a skipped full-suite job (a partial run or a diagnostic dispatch) falls back; a run without the job falls back', async () => {
    const run = prRun();
    const artifacts = { [run.id]: { value: treeJson(run) } };
    const skipped = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'skipped' }] }, artifacts });
    expect(await decide(skipped, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_not_success' });
    const cheap = fixture({ runs: [run], jobs: { '500/1': [{ name: 'test-status', conclusion: 'success' }] }, artifacts });
    expect(await decide(cheap, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_missing' });
    const twice = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'success' }, { name: 'full-suite', conclusion: 'success' }] }, artifacts });
    expect(await decide(twice, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_ambiguous' });
  });

  test('an API error falls back', async () => {
    for (const fail of ['runs', 'jobs', 'commit'] as const) {
      const run = prRun();
      const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run) } }, fail }), PROFILES.test, M, REPO);
      expect(d).toMatchObject({ reuse: false, reason: 'api_error' });
    }
  });

  test('a push that is not a merge commit falls back', async () => {
    const run = prRun();
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE] }, [H]: { tree: T, parents: [BASE] } }, runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'not_merge_commit' });
  });

  test('a run from a fork falls back', async () => {
    const run = prRun({ head_repository: { full_name: 'someone-example/repo-example' } });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'fork_run' });
  });

  test('no full run on the push tree falls back', async () => {
    expect(await decide(fixture({}), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'no_candidate' });
  });

  test('prefers runs on the merged head (newest first), then any dispatch or push run whose head tree equals the push tree', async () => {
    const cheapNewer = prRun({ id: 600, run_number: 60 });
    const fullOlder = prRun({ id: 550, run_number: 55 });
    const deps = fixture({ runs: [fullOlder, cheapNewer], jobs: { '600/1': [{ name: 'test-status', conclusion: 'success' }] }, artifacts: { 550: { value: treeJson(fullOlder) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 550 } });
    expect(deps.jobCalls).toEqual(['600/1', '550/1']);

    const elsewhere = prRun({ id: 700, head_sha: H2 });
    const unrelated = prRun({ id: 710, head_sha: BASE });
    const fallback = fixture({
      commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] }, [BASE]: { tree: OTHER, parents: [] } },
      runs: [unrelated, elsewhere], artifacts: { 700: { value: treeJson(elsewhere) }, 710: { value: treeJson(unrelated, { tree: T }) } },
    });
    expect(await decide(fallback, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 700, sha: H2 } });

    const onlyUnrelated = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [BASE]: { tree: OTHER, parents: [] } }, runs: [unrelated], artifacts: { 710: { value: treeJson(unrelated, { tree: T }) } } });
    expect(await decide(onlyUnrelated, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'no_candidate' });

    const earlierPush = prRun({ id: 720, head_sha: H2, event: 'push' });
    const cheapElsewhere = prRun({ id: 730, head_sha: H2, event: 'pull_request' });
    const viaPush = fixture({
      commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] } },
      runs: [cheapElsewhere, earlierPush], artifacts: { 720: { value: treeJson(earlierPush) }, 730: { value: treeJson(cheapElsewhere) } },
    });
    expect(await decide(viaPush, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 720, sha: H2 } });
    expect(viaPush.jobCalls).toEqual(['720/1']);
  });

  test('the reported reason is the merged-head candidate when every candidate fails', async () => {
    const run = prRun({ conclusion: 'cancelled' });
    const other = prRun({ id: 700, head_sha: H2 });
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] } }, runs: [run, other] });
    const d = await decide(deps, PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'run_cancelled' });
    expect(d.rejected.map(r => r.reason)).toEqual(['run_cancelled', 'artifact_missing']);
  });

  test('e2e uses its own job and artifact names', () => {
    expect(PROFILES.e2e).toMatchObject({ file: 'e2e.yml', workflow: 'E2E Tests', job: 'e2e-full-suite', artifact: 'e2e-full-suite-tree' });
    expect(PROFILES.test).toMatchObject({ file: 'test.yml', workflow: 'Test', job: 'full-suite', artifact: 'full-suite-tree' });
  });
});

describe('ci-reuse API layer', () => {
  test('reads commits, pull request runs by head, and every page of the latest attempt jobs', async () => {
    const paths: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `job ${i}`, conclusion: 'success' }));
    const client: GitHubClient = {
      async request<T>(_m: string, path: string): Promise<T> {
        paths.push(path);
        if (path === `repos/{repo}/git/commits/${M}`) return { tree: { sha: T }, parents: [{ sha: BASE }, { sha: H }] } as T;
        if (path.includes('/jobs?per_page=100&page=1')) return { total_count: 101, jobs: page1 } as T;
        if (path.includes('/jobs?per_page=100&page=2')) return { total_count: 101, jobs: [{ name: 'full-suite', conclusion: 'success' }] } as T;
        if (path.includes('/runs?')) return { workflow_runs: [prRun({ id: paths.length })] } as T;
        throw new Error(`unexpected ${path}`);
      },
    };
    const api = apiDeps(client);
    expect(await api.commit(M)).toEqual({ tree: T, parents: [BASE, H] });
    expect(await api.runsForHead('test.yml', H)).toHaveLength(1);
    expect(paths).toContain(`repos/{repo}/actions/workflows/test.yml/runs?head_sha=${H}&per_page=100`);
    expect(await api.recentSuccessfulRuns('test.yml')).toHaveLength(2);
    expect(paths).toContain('repos/{repo}/actions/workflows/test.yml/runs?event=workflow_dispatch&status=success&per_page=100');
    expect(paths).toContain('repos/{repo}/actions/workflows/test.yml/runs?event=push&status=success&per_page=100');
    const jobs = await api.jobs(500, 2);
    expect(jobs).toHaveLength(101);
    expect(jobs.at(-1)!.name).toBe('full-suite');
    expect(paths.filter(p => p.startsWith('repos/{repo}/actions/runs/500/attempts/2/jobs'))).toHaveLength(2);
    expect((await api.artifact(500, 'full-suite-tree')).reason).toContain('cannot download');
  });
});

describe('ci-reuse outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-reuse-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const paths = (prefix: string) => ({ output: join(dir, `${prefix}-out`), summary: join(dir, `${prefix}-summary`), record: join(dir, `${prefix}-record.json`) });

  test('writes the outputs, a summary line naming the reused run URL, and the reuse record', async () => {
    const d = await decide(green(), PROFILES.test, M, REPO);
    const p = paths('ok');
    writeDecision(d, PROFILES.test, { repo: REPO, sha: M, ...p });
    expect(readFileSync(p.output, 'utf8')).toBe(`reuse=true\nsource_run_id=500\nsource_run_attempt=1\nsource_sha=${H}\ntree=${T}\nreason=identical_tree_full_run\n`);
    expect(readFileSync(p.summary, 'utf8')).toContain(`https://github.com/${REPO}/actions/runs/500/attempts/1`);
    const rec = JSON.parse(readFileSync(p.record, 'utf8'));
    expect(rec).toMatchObject({ reuse: true, workflow: 'Test', push_sha: M, tree: T, source_run_id: 500, source_run_attempt: 1, source_sha: H });
    expect(checkRecord(rec, 'Test', M)).toEqual({ run_id: 500, run_attempt: 1, sha: H });
  });

  test('a fallback writes reuse=false with empty source fields and the reason in the summary', async () => {
    const d = await decide(fixture({ runs: [prRun({ conclusion: 'cancelled' })] }), PROFILES.test, M, REPO);
    const p = paths('no');
    writeDecision(d, PROFILES.test, { repo: REPO, sha: M, ...p });
    expect(readFileSync(p.output, 'utf8')).toBe(`reuse=false\nsource_run_id=\nsource_run_attempt=\nsource_sha=\ntree=${T}\nreason=run_cancelled\n`);
    const summary = readFileSync(p.summary, 'utf8');
    expect(summary).toContain('full run');
    expect(summary).toContain('run_cancelled');
    expect(checkRecord(JSON.parse(readFileSync(p.record, 'utf8')), 'Test', M)).toContain('reuse is not true');
  });

  test('checkRecord refuses a record for another workflow or push, or without a source run', () => {
    const rec = { reuse: true, workflow: 'Test', push_sha: M, tree: T, source_run_id: 500, source_run_attempt: 1, source_sha: H };
    expect(typeof checkRecord({ ...rec, workflow: 'E2E Tests' }, 'Test', M)).toBe('string');
    expect(typeof checkRecord({ ...rec, push_sha: H2 }, 'Test', M)).toBe('string');
    expect(typeof checkRecord({ ...rec, source_run_id: 0 }, 'Test', M)).toBe('string');
    expect(typeof checkRecord(undefined, 'Test', M)).toBe('string');
  });
});
