/**
 * scripts/ci-health-report.ts (GBRA-47 V-6, ENG-14; green master wave E6):
 * same-repo runs only, first-attempt pass rate for PR and push-to-master runs,
 * full-window paging (split over the search cap, indeterminate when it cannot
 * be read in full), stress-gate failures and failure classes, master-red time
 * to first response, the nightly-watch residual, shard spread with the miner
 * command and failing test files from annotations (inert).
 */
import { describe, expect, test } from 'bun:test';
import type { GitHubClient } from '../../scripts/lib/gh-issue.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPS, collectHealth, firstAttempt, parseWindow, renderHealth, shardRatio, topFailingFiles, type Annotation, type Job, type Run } from '../../scripts/ci-health-report.ts';

const repo = { full_name: 'garrytan/gbrain' };
const run = (id: number, conclusion: string, attempt = 1, fork = false): Run => ({
  id, event: 'pull_request', status: 'completed', conclusion, run_attempt: attempt, created_at: '2026-10-01T00:00:00Z',
  repository: repo, head_repository: fork ? { full_name: 'someone/gbrain' } : repo,
});
const shard = (id: number, name: string, secs: number, conclusion = 'success'): Job => ({
  id, name, conclusion, started_at: '2026-10-01T00:00:00Z', completed_at: new Date(Date.parse('2026-10-01T00:00:00Z') + secs * 1000).toISOString(),
});

describe('ci-health-report', () => {
  test('first-attempt pass counts only runs that passed without a re-run; cancelled runs are ignored', () => {
    expect(firstAttempt([run(1, 'success'), run(2, 'success', 2), run(3, 'failure'), run(4, 'cancelled')])).toEqual({ runs: 3, pass: 1, rate: 1 / 3 });
  });

  test('shard ratio is slowest over mean among matching jobs', () => {
    const jobs = [shard(1, 'test (1)', 100), shard(2, 'test (2)', 200), shard(3, 'verify', 900)];
    expect(shardRatio(jobs, /^test \(\d+\)$/)).toBeCloseTo(200 / 150);
    expect(shardRatio([shard(1, 'test (1)', 100)], /^test \(\d+\)$/)).toBeNull();
  });

  test('failing test files are counted from failure annotations and rendered inert', () => {
    const anns: Annotation[] = [
      { annotation_level: 'failure', path: 'test/a.test.ts', title: 'error: boom @someone https://evil.example', message: 'x' },
      { annotation_level: 'failure', path: 'test/a.test.ts', title: 'error: boom', message: 'x' },
      { annotation_level: 'failure', path: 'test/b.test.ts', message: 'Process completed with exit code 1.' },
      { annotation_level: 'warning', path: 'test/c.test.ts', message: 'Node.js 20 is deprecated' },
      { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    ];
    const top = topFailingFiles(anns);
    expect(top.map(t => [t.file, t.count])).toEqual([['test/a.test.ts', 2], ['test/b.test.ts', 1]]);
    expect(top[0]!.sample).not.toMatch(/@someone|https:\/\/evil/);
  });

  const W = { since: '2026-09-27T00:00:00.000Z', until: '2026-10-04T00:00:00.000Z' };
  const decoded = (path: string) => decodeURIComponent(path);

  function fakeApi(opts: { pr?: (page: number, path: string) => { workflow_runs: Run[]; total_count: number }; push?: Run[]; issues?: unknown[]; comments?: Record<number, unknown[]>; timeline?: Record<number, unknown[]>; failJobs?: boolean }) {
    const calls: string[] = [];
    const client: GitHubClient = {
      async request<T>(_m: string, path: string): Promise<T> {
        calls.push(path);
        if (path.includes('/workflows/nightly-watch.yml/runs?status=skipped')) return { total_count: 9, workflow_runs: [] } as T;
        if (path.includes('/workflows/nightly-watch.yml/runs')) return { workflow_runs: [{ conclusion: 'success', status: 'completed' }] } as T;
        if (path.includes('&branch=master&created=') && /per_page=1$/.test(path)) return { total_count: path.includes('event=workflow_dispatch') ? 1 : 0, workflow_runs: [] } as T;
        if (path.includes('event=push&status=success')) return { workflow_runs: [{ id: 555 }] } as T;
        if (path.includes('event=push&branch=master')) return { workflow_runs: opts.push ?? [], total_count: (opts.push ?? []).length } as T;
        if (path.includes('event=pull_request')) {
          const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
          return (opts.pr ? opts.pr(page, path) : { workflow_runs: page === 1 ? [run(1, 'success')] : [], total_count: 1 }) as T;
        }
        if (path.includes('/jobs')) {
          if (opts.failJobs) throw new Error('502');
          const id = Number(/runs\/(\d+)\//.exec(path)![1]);
          if (id % 7 === 0) return { jobs: [{ id: 9, name: 'stress-changed-tests', conclusion: 'failure' }, { id: 10, name: 'test-status', conclusion: 'failure' }] } as T;
          if (id % 7 === 1) return { jobs: [{ id: 11, name: 'verify', conclusion: 'timed_out' }] } as T;
          return { jobs: [shard(1, 'test (1)', 100), shard(2, 'test (2)', 300, 'failure'), shard(3, 'Selected E2E (diff-relevant) 1', 50)] } as T;
        }
        if (path.includes('/annotations')) return [{ annotation_level: 'failure', path: 'test/flaky.test.ts', title: 'error: timeout', message: '' }] as T;
        if (path.includes('issues?labels=master-red')) return (opts.issues ?? []) as T;
        const c = /issues\/(\d+)\/comments/.exec(path);
        if (c) return (opts.comments?.[Number(c[1])] ?? []) as T;
        const t = /issues\/(\d+)\/timeline/.exec(path);
        if (t) return (opts.timeline?.[Number(t[1])] ?? []) as T;
        throw new Error(`unexpected ${path}`);
      },
    };
    return { client, calls };
  }

  test('collect pages the whole window of same-repo runs, samples annotations, names the miner command and states truncation', async () => {
    const page = (n: number, offset: number) => Array.from({ length: n }, (_, i) => run(1000 + offset + i, i % 4 === 0 ? 'failure' : 'success', 1, i % 10 === 9));
    const { client, calls } = fakeApi({ pr: (p, path) => (path.includes('test.yml') ? { workflow_runs: p <= 3 ? page(100, p * 100) : [], total_count: 300 } : { workflow_runs: p === 1 ? page(3, 0) : [], total_count: 3 }) });
    const data = await collectHealth(client, W);
    const unit = data.workflows.find(w => w.workflow === 'test.yml')!;
    expect(unit.complete).toBe(true);
    expect(unit.fork_runs_excluded).toBe(30);
    expect(unit.runs).toBe(270);
    expect(unit.miner).toBe('bun run weights:mine --lane unit --run 555');
    expect(unit.spread.mean_ratio).toBeCloseTo(1.5);
    expect(data.truncated.join(' ')).toContain(`annotations from ${CAPS.failedRunsSampled} of`);
    expect(data.failing_files[0]!.file).toBe('test/flaky.test.ts');
    expect(calls.every(c => !c.includes('/logs'))).toBe(true);
    expect(calls.some(c => decoded(c).includes('created=2026-09-27T00:00:00Z..2026-10-04T00:00:00Z'))).toBe(true);
    const body = renderHealth(data);
    expect(body).toContain('`bun run weights:mine --lane unit --run 555`');
    expect(body).toContain('**Truncated:**');
    expect(body).toContain('### Next step for the agent');
    expect(body).toContain('Docs: docs/ci-red-runbook.md#ci-health-report');
  });

  test('a window over the 1000-result search cap is split in halves until every slice fits; a slice that cannot fit is indeterminate, never satisfied', async () => {
    const big = fakeApi({ pr: (p, path) => {
      const [from, to] = decoded(path).match(/created=([^&]+)/)![1]!.split('..').map(Date.parse);
      const days = (to! - from!) / 86_400_000;
      const n = days > 2 ? 1500 : 40;
      return { workflow_runs: p === 1 ? Array.from({ length: Math.min(n, 40) }, (_, i) => run(from! / 1000 + i, 'success')) : [], total_count: n };
    } });
    const data = await collectHealth(big.client, W);
    expect(data.workflows[0]!.complete).toBe(true);
    expect(big.calls.filter(c => c.includes('test.yml/runs?event=pull_request')).length).toBeGreaterThan(4);
    expect(data.criteria.find(c => c.name === 'PR test.yml first attempt')!.verdict).toBe('met');

    const capped = fakeApi({ pr: p => ({ workflow_runs: p === 1 ? [run(1, 'success')] : [], total_count: 5000 }) });
    const worst = await collectHealth(capped.client, { since: '2026-10-01T00:00:00.000Z', until: '2026-10-01T00:30:00.000Z' });
    const c = worst.criteria.find(x => x.name === 'PR test.yml first attempt')!;
    expect(c.verdict).toBe('indeterminate');
    expect(renderHealth(worst)).toContain('Exit criterion indeterminate: PR test.yml first attempt');

    const short = fakeApi({ pr: p => ({ workflow_runs: p === 1 ? [run(1, 'success')] : [], total_count: 2 }) });
    expect((await collectHealth(short.client, W)).criteria.find(x => x.name === 'PR test.yml first attempt')!.verdict).toBe('indeterminate');
  });

  test('push-to-master pass rate per workflow with exit criteria; stress-gate failures and failure classes are reported separately; cancellation coverage is counted', async () => {
    const push = [run(14, 'failure'), run(15, 'failure'), run(16, 'success'), run(17, 'success', 2), run(18, 'cancelled'), ...Array.from({ length: 15 }, (_, i) => run(100 + i, 'success'))].map(r => ({ ...r, event: 'push', head_branch: 'master' }));
    const { client } = fakeApi({ push, pr: p => ({ workflow_runs: p === 1 ? [run(21, 'failure'), run(22, 'success')] : [], total_count: 2 }) });
    const data = await collectHealth(client, W);
    const masterTest = data.master.find(s => s.workflow === 'test.yml')!;
    expect(masterTest).toMatchObject({ event: 'push', runs: 19, first_attempt_pass: 16 });
    expect(masterTest.coverage).toEqual({ total: 20, completed: 20, cancelled: 1, skipped: 0 });
    expect(masterTest.classification).toEqual({ stress_gate: 1, test: 1, infrastructure: 1, unread: 0 });
    expect(data.criteria.find(c => c.name === 'master Test push runs')).toMatchObject({ verdict: 'missed', target: 0.95 });
    const prTest = data.workflows.find(w => w.workflow === 'test.yml')!;
    expect(prTest.stress_gate_failures).toBe(1);
    expect(prTest.classification.stress_gate).toBe(1);
    const body = renderHealth(data);
    expect(body).toContain('| test.yml | push to master | 19 | 16 (84%) | 1 | 1 / 1 / 1 | 1 of 20 cancelled; 20 of 20 completed |');
    expect(body).toContain('Exit criterion missed: master Test push runs at 84% (target 95%)');
    expect(body).toContain('**Nightly-watch residual:** 9 skipped watch runs; 8 watched-workflow runs on master outside the schedule and push allowlist');
  });

  test('master-red first response: an allowlisted comment or the first linked PR from anyone; bot comments never count', async () => {
    const issues = [
      { number: 1, title: 'Master red: Test', state: 'closed', labels: [{ name: 'master-red' }], created_at: '2026-10-01T10:00:00Z' },
      { number: 2, title: 'Master red: E2E Tests', state: 'open', labels: [{ name: 'master-red' }], created_at: '2026-10-02T10:00:00Z' },
      { number: 3, title: 'Master red: Test', state: 'closed', labels: [{ name: 'master-red' }], created_at: '2026-09-01T10:00:00Z' },
    ];
    const comments = {
      1: [{ created_at: '2026-10-01T10:05:00Z', user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' }, { created_at: '2026-10-01T10:40:00Z', user: { login: 'agent-example' }, author_association: 'NONE' }],
      2: [{ created_at: '2026-10-02T13:00:00Z', user: { login: 'maintainer-example' }, author_association: 'OWNER' }],
    };
    const timeline = { 2: [{ event: 'cross-referenced', created_at: '2026-10-02T11:30:00Z', source: { issue: { number: 77, state: 'open', pull_request: { merged_at: null } } } }] };
    const { client } = fakeApi({ issues, comments, timeline });
    const data = await collectHealth(client, W, { responders: ['agent-example'] });
    expect(data.master_red.issues.map(r => [r.issue, r.via, r.hours])).toEqual([[1, 'comment', 40 / 60], [2, 'pull_request', 1.5]]);
    expect(data.master_red.within_hour).toBe(1);
    expect(renderHealth(data)).toContain('got no first response within 1 hour (#2)');
    const none = await collectHealth(fakeApi({ issues, comments }).client, W);
    expect(none.master_red.issues[0]!.via).toBeNull();
  });

  test('--since/--until set an explicit window; bad values are refused with what to pass', () => {
    expect(parseWindow({ since: '2026-10-06', until: '2026-10-13' })).toEqual({ window: { since: '2026-10-06T00:00:00.000Z', until: '2026-10-13T23:59:59.000Z' }, explicit: true });
    expect(parseWindow({ days: '7' }, Date.parse('2026-10-08T00:00:00Z'))).toEqual({ window: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z' }, explicit: false });
    expect(parseWindow({ since: '10/06/2026' })).toEqual({ error: '--since and --until take YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (UTC)' });
    expect(parseWindow({ since: '2026-10-13', until: '2026-10-06' })).toEqual({ error: '--since must be a valid date before --until' });
    expect(parseWindow({ days: '90' })).toEqual({ error: '--days takes 1-31' });
  });

  test('ci-health.yml passes since/until through env only', () => {
    const wf = readFileSync(join(import.meta.dir, '../../.github/workflows/ci-health.yml'), 'utf8');
    expect(wf).toContain('since:');
    expect(wf).toContain('until:');
    expect(wf).toContain('SINCE: ${{ inputs.since }}');
    expect(wf).not.toMatch(/run: \|[\s\S]*\$\{\{ inputs\.(since|until)/);
  });
});
