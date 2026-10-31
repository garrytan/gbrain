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
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { apiDeps, attemptJobs, checkRecord, decide, decideGate, gateDeps, PROFILES, runGate, writeDecision, type Commit, type GateDeps, type JobRow, type FullRun, type ReuseDeps } from '../../scripts/ci-reuse.ts';
import { GET_RETRY_DELAYS_MS, restClient, type GitHubClient } from '../../scripts/lib/gh-issue.ts';

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

  test('a job listing that 502s at 100 per page after the client retries is read again at 30 per page (Release run 39712021085)', async () => {
    const all = Array.from({ length: 109 }, (_, i) => ({ name: `job ${i}`, conclusion: 'success' }));
    const urls: string[] = []; const slept: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); urls.push(url.pathname + url.search);
      const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
      if (per === 100) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      return Response.json({ total_count: all.length, jobs: all.slice((page - 1) * per, page * per) });
    }) as typeof fetch;
    try {
      const jobs = await attemptJobs(restClient('acme-example/repo', 'token-example', async ms => { slept.push(ms); }), 500, 2);
      expect(jobs.map(j => j.name)).toEqual(all.map(j => j.name));
    } finally { globalThis.fetch = realFetch; }
    expect(slept).toEqual(GET_RETRY_DELAYS_MS);
    expect(urls).toEqual([
      ...Array(GET_RETRY_DELAYS_MS.length + 1).fill('/repos/acme-example/repo/actions/runs/500/attempts/2/jobs?per_page=100&page=1'),
      ...[1, 2, 3, 4].map(page => `/repos/acme-example/repo/actions/runs/500/attempts/2/jobs?per_page=30&page=${page}`),
    ]);
  });

  test('a job listing still refused at 30 per page, or refused with a client error, surfaces the error', async () => {
    const refusing = (status: (per: number) => number): GitHubClient => ({
      async request<T>(_m: string, path: string): Promise<T> {
        const code = status(Number(new URL(path, 'https://x.invalid/').searchParams.get('per_page')));
        throw Object.assign(new Error(`GitHub API GET ${path} -> ${code}`), { status: code });
      },
    });
    await expect(attemptJobs(refusing(() => 502), 500, 2)).rejects.toThrow('per_page=30&page=1 -> 502');
    await expect(attemptJobs(refusing(() => 404), 500, 2)).rejects.toThrow('per_page=100&page=1 -> 404');
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

// Remote-gate reuse (scripts/pregate-remote-gate.sh): the Ubicloud gate's receipt comes from GitHub's complete
// full runs of Test and E2E on the identical tree, or the gate runs. A code change after full-ci never reuses.
describe('ci-reuse remote-gate decision', () => {
  const A = '5'.repeat(40);
  const B = '6'.repeat(40);
  const T2 = 'c'.repeat(40);
  const files = { 'test.yml': PROFILES.test, 'e2e.yml': PROFILES.e2e } as const;
  type File = keyof typeof files;
  const run = (file: File, over: Partial<FullRun> = {}): FullRun & { file: File } => ({ ...prRun({ id: file === 'test.yml' ? 600 : 700, head_sha: A, ...over }), file });
  const tree = (r: FullRun & { file: File }, over: Record<string, unknown> = {}) => ({ ...treeJson(r, { workflow: files[r.file].workflow }), ...over });

  function gate(o: { commits?: Record<string, Commit>; runs: Array<FullRun & { file: File }>; artifacts?: Record<number, unknown>; jobs?: Record<string, JobRow[]>; executed?: Record<number, { tests: number; failed: number } | { reason: string }> }): GateDeps {
    const commits = o.commits ?? { [A]: { tree: T, parents: [BASE] } };
    const art = o.artifacts ?? Object.fromEntries(o.runs.map(r => [r.id, tree(r)]));
    return {
      async commit(sha) { if (!commits[sha]) throw new Error(`GitHub API GET git/commits/${sha} -> 404`); return commits[sha]!; },
      async runsForHead(file, sha) { return o.runs.filter(r => r.file === file && r.head_sha === sha); },
      async recentSuccessfulRuns(file) { return o.runs.filter(r => r.file === file && r.conclusion === 'success'); },
      async recentRuns(file) { return o.runs.filter(r => r.file === file); },
      async jobs(runId, attempt) {
        const r = o.runs.find(x => x.id === runId)!;
        return o.jobs?.[`${runId}/${attempt}`] ?? [{ name: files[r.file].job, status: 'completed', conclusion: 'success' }];
      },
      async artifact(runId, name) {
        const r = o.runs.find(x => x.id === runId)!;
        expect(name).toBe(files[r.file].artifact);
        return art[runId] === undefined ? { reason: `run ${runId} has no '${name}' artifact` } : { value: art[runId] };
      },
      async executed(runId) { return o.executed?.[runId] ?? { tests: runId, failed: 0 }; },
    };
  }
  const go = async (deps: GateDeps, head = A, t0 = T, waitMs = 0) => {
    const lines: string[] = [];
    let clock = 0;
    const code = await runGate(deps, { head, tree: t0, repo: REPO, waitMs, pollMs: 60_000, log: l => lines.push(l), sleep: async ms => { clock += ms; }, now: () => clock });
    return { code, lines, last: lines.at(-1) };
  };

  test('Test and E2E full runs that passed on this exact tree are the receipt: summed executed tests, no gate', async () => {
    const r = await go(gate({ runs: [run('test.yml'), run('e2e.yml')] }));
    expect(r.code).toBe(0);
    expect(r.last).toBe('GBRAIN_REUSE_RESULT tests=1300 failed=0');
    expect(r.lines.join('\n')).toContain(`https://github.com/${REPO}/actions/runs/600/attempts/1`);
  });

  test('a code change after full-ci is refused: the new head has its own tree and no full run of it, so the gate runs', async () => {
    const deps = gate({ commits: { [A]: { tree: T, parents: [BASE] }, [B]: { tree: T2, parents: [A] } }, runs: [run('test.yml'), run('e2e.yml')] });
    expect(await decideGate(deps, PROFILES.test, B, T2, REPO)).toMatchObject({ state: 'none' });
    const r = await go(deps, B, T2);
    expect(r.code).toBe(4);
    expect(r.lines.join('\n')).not.toContain('GBRAIN_REUSE_RESULT');
    // An unpushed code change: GitHub has no such commit, so nothing reuses either.
    expect((await go(gate({ runs: [run('test.yml'), run('e2e.yml')] }), B, T2)).code).toBe(4);
  });

  test('a working tree that is not the head commit tree on GitHub never reuses', async () => {
    expect(await decideGate(gate({ runs: [run('test.yml')] }), PROFILES.test, A, T2, REPO)).toMatchObject({ state: 'none' });
  });

  test('a failed newest full run on the head refuses (exit 3) even when an older run on it passed', async () => {
    const deps = gate({ runs: [run('test.yml', { id: 610, conclusion: 'failure' }), run('test.yml'), run('e2e.yml')] });
    const r = await go(deps);
    expect(r.code).toBe(3);
    expect(r.last).toContain('runs/610/attempts/1');
  });

  test('a full run in progress on the head is waited for, and a timeout falls back to the gate', async () => {
    let polls = 0;
    const live = run('test.yml', { status: 'in_progress', conclusion: null });
    const deps = gate({ runs: [live, run('e2e.yml')] });
    const slow = { ...deps, async runsForHead(file: string, sha: string) { if (file === 'test.yml' && ++polls >= 3) Object.assign(live, { status: 'completed', conclusion: 'success' }); return deps.runsForHead(file, sha); } };
    const r = await go(slow, A, T, 10 * 60_000);
    expect(r.code).toBe(0);
    expect(r.lines.filter(l => l.includes('waiting for')).length).toBe(2);
    const stuck = await go(gate({ runs: [run('test.yml', { status: 'queued', conclusion: null }), run('e2e.yml')] }), A, T, 2 * 60_000);
    expect(stuck.code).toBe(4);
  });

  test('both workflows are required: a missing E2E full run, a cheap artifact or an unreadable executed list falls back', async () => {
    expect((await go(gate({ runs: [run('test.yml')] }))).code).toBe(4);
    const t1 = run('test.yml'), e1 = run('e2e.yml');
    expect((await go(gate({ runs: [t1, e1], artifacts: { 600: tree(t1), 700: tree(e1, { profile: 'cheap' }) } }))).code).toBe(4);
    expect((await go(gate({ runs: [t1, e1], executed: { 700: { reason: 'no executed-identities artifact' } } }))).code).toBe(4);
    expect((await go(gate({ runs: [t1, e1], executed: { 700: { tests: 0, failed: 0 } } }))).code).toBe(4);
  });

  test('a full run that concluded success with a failed full-suite job refuses (exit 3)', async () => {
    const r = await go(gate({ runs: [run('test.yml'), run('e2e.yml')], jobs: { '600/1': [{ name: PROFILES.test.job, status: 'completed', conclusion: 'failure' }] } }));
    expect(r.code).toBe(3);
    expect(r.last).toContain('runs/600/attempts/1');
  });

  test('a failed full run refuses at once even while the other workflow is still running', async () => {
    const r = await go(gate({ runs: [run('test.yml', { status: 'in_progress', conclusion: null }), run('e2e.yml', { conclusion: 'failure' })] }), A, T, 10 * 60_000);
    expect(r.code).toBe(3);
    expect(r.lines.some(l => l.includes('waiting for'))).toBe(false);
  });

  test('the executed-identities artifact counts pass and fail identities, and an unreadable one says why', async () => {
    const zipOf = (name: string, content: string): Uint8Array => {
      const data = Buffer.from(content), body = deflateRawSync(data), file = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + body.length, 16);
      return new Uint8Array(Buffer.concat([local, file, body, central, file, end]));
    };
    const client = (doc: unknown, listed = true): GitHubClient => ({
      async request<T>(_m: string, path: string): Promise<T> {
        if (path === 'repos/{repo}/actions/runs/600/artifacts?name=executed-identities&per_page=10') return { artifacts: listed ? [{ id: 9, name: 'executed-identities', expired: false }] : [] } as T;
        throw new Error(`unexpected ${path}`);
      },
      async download() { return zipOf('executed-identities.json', JSON.stringify(doc)); },
    });
    const ids = [{ status: 'pass' }, { status: 'pass' }, { status: 'fail' }, { status: 'skip' }, {}];
    expect(await gateDeps(client({ head: { identities: ids } })).executed(600)).toEqual({ tests: 3, failed: 1 });
    expect(await gateDeps(client({ head: {} })).executed(600)).toEqual({ reason: "run 600's executed-identities.json has no head.identities list" });
    expect(await gateDeps(client(null, false)).executed(600)).toEqual({ reason: "run 600 has no 'executed-identities' artifact" });
  });

  test('--gate with a malformed sha, tree or repository is a usage error (exit 2) and reads nothing', () => {
    const script = resolve(import.meta.dir, '..', '..', 'scripts', 'ci-reuse.ts');
    for (const args of [['--sha', 'abc', '--tree', T, '--repo', REPO], ['--sha', A, '--tree', T, '--repo', 'no-slash'], ['--sha', A, '--tree', T, '--repo', REPO, '--poll-seconds', '0']]) {
      const r = Bun.spawnSync(['bun', script, '--gate', ...args], { env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' } });
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString()).toStartWith('Usage: bun scripts/ci-reuse.ts --gate');
    }
  });

  test('a newer run on the head that did not run the full job (a diagnostic dispatch, a reusing push) is skipped, never a failed full run', async () => {
    const skipped = (id: number) => ({ [`${id}/1`]: [{ name: PROFILES.test.job, status: 'completed', conclusion: 'skipped' }, { name: 'reused-full-suite', status: 'completed', conclusion: 'success' }] });
    // A diagnostic dispatch that passed, a push that reused (full-suite skipped), and a diagnostic dispatch that failed.
    for (const over of [{ id: 630 }, { id: 630, event: 'push' }, { id: 630, conclusion: 'failure' }]) {
      const deps = gate({ runs: [run('test.yml', over), run('test.yml'), run('e2e.yml')], jobs: skipped(630) });
      expect(await decideGate(deps, PROFILES.test, A, T, REPO)).toMatchObject({ state: 'reuse' });
      expect((await go(deps)).code).toBe(0);
    }
    // One still in progress whose full job is already skipped does not hold the gate.
    const live = gate({ runs: [run('test.yml', { id: 630, status: 'in_progress', conclusion: null }), run('test.yml'), run('e2e.yml')], jobs: skipped(630) });
    expect(await decideGate(live, PROFILES.test, A, T, REPO)).toMatchObject({ state: 'reuse' });
  });

  test('another commit with the same tree inherits that head\'s newest full run: a newer failure there still refuses', async () => {
    const C2 = '8'.repeat(40);
    const commits = { [A]: { tree: T, parents: [BASE] }, [C2]: { tree: T, parents: [A] } };
    const deps = gate({ commits, runs: [run('test.yml', { id: 610, conclusion: 'failure' }), run('test.yml'), run('e2e.yml')] });
    expect(await decideGate(deps, PROFILES.test, C2, T, REPO)).toMatchObject({ state: 'failed' });
    expect((await go(deps, C2)).code).toBe(3);
    const busy = gate({ commits, runs: [run('test.yml', { id: 610, status: 'in_progress', conclusion: null }), run('test.yml'), run('e2e.yml')] });
    expect(await decideGate(busy, PROFILES.test, C2, T, REPO)).toMatchObject({ state: 'pending' });
    // A same-tree commit whose only full run failed is seen too, though it has no passed run to be listed by.
    const C3 = '9'.repeat(40);
    const failedElsewhere = gate({ commits: { ...commits, [C3]: { tree: T, parents: [C2] } }, runs: [run('test.yml', { id: 640, head_sha: C2, conclusion: 'failure' }), run('test.yml'), run('e2e.yml')] });
    expect(await decideGate(failedElsewhere, PROFILES.test, C3, T, REPO)).toMatchObject({ state: 'failed' });
    // The newest full run across every head with the tree decides, whichever head has the newest run of any kind:
    // a diagnostic dispatch on A (full job skipped) does not let A's old pass outrank B's newer failure, and the
    // requested head's own older pass does not either.
    const ordered = gate({
      commits: { ...commits, [C3]: { tree: T, parents: [C2] } },
      runs: [run('test.yml', { id: 650 }), run('test.yml', { id: 640, head_sha: C2, conclusion: 'failure' }), run('test.yml'), run('e2e.yml')],
      jobs: { '650/1': [{ name: PROFILES.test.job, status: 'completed', conclusion: 'skipped' }] },
    });
    expect(await decideGate(ordered, PROFILES.test, C3, T, REPO)).toMatchObject({ state: 'failed' });
    expect(await decideGate(ordered, PROFILES.test, A, T, REPO)).toMatchObject({ state: 'failed' });
  });

  test('a cancelled newest run looks further back; a passed run of the same tree on another head (a merge commit) reuses', async () => {
    expect((await go(gate({ runs: [run('test.yml', { id: 620, conclusion: 'cancelled' }), run('test.yml'), run('e2e.yml')] }))).code).toBe(0);
    const M2 = '7'.repeat(40);
    const deps = gate({ commits: { [A]: { tree: T, parents: [BASE] }, [M2]: { tree: T, parents: [BASE, A] } }, runs: [run('test.yml'), run('e2e.yml')] });
    expect(await decideGate(deps, PROFILES.test, M2, T, REPO)).toMatchObject({ state: 'reuse', tests: 600 });
  });
});
