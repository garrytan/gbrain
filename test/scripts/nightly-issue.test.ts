/**
 * scripts/nightly-issue.ts + scripts/lib/gh-issue.ts over recorded GitHub API
 * JSON (Heavy Tests scheduled run 37195155240, red; macOS 26 validation
 * scheduled run 37197810506, green): open, update, flap-reopen, skip-green
 * stays open, close, known-red signatures, review-by, injection, TSV
 * validation and the "every scheduled workflow is watched" ratchet.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { load as loadYaml } from 'js-yaml';
import { loadReceiptDir } from '../../scripts/ci-executed-counts.ts';
import { buildManifest, checkManifest, failureSignature, junitMessages, MANIFEST_ARTIFACT, MANIFEST_SCHEMA, type CiManifest } from '../../scripts/ci-manifest.ts';
import { failureSignature as gateSignature, parseExemptionBlocks } from '../fixtures/nightly-watch/stress-exemption-contract.ts';
import { inert, jsonBlock, labelNames, readJsonBlock, readZipEntry, type GitHubClient, type Issue } from '../../scripts/lib/gh-issue.ts';
import { FLAKE_MARKER, MR_MARKER, PUSH_ALLOWLIST, type FlakeRecord, type MasterRedState } from '../../scripts/lib/master-red.ts';
import {
  JSON_MARKER, parseKnownRed, resolveTarget, routeRun, validateKnownRed, watch, watchRun, type IncidentRecord, type JobInfo, type KnownRow, type RunInfo,
} from '../../scripts/nightly-issue.ts';

const ROOT = join(import.meta.dir, '../..');
const FIX = join(ROOT, 'test/fixtures/nightly-watch');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;
const REPO = 'garrytan/gbrain';
const TODAY = '2026-10-05';

interface Call { method: string; path: string; body?: Record<string, unknown> }

function fakeClient(opts: { run: RunInfo; jobs: { jobs: JobInfo[]; total_count: number }; annotations?: Record<number, unknown[]>; issues?: Issue[] }) {
  const calls: Call[] = [];
  const client: GitHubClient = {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body: body as Record<string, unknown> });
      if (method !== 'GET') {
        if (path === 'repos/{repo}/issues') return { number: 101, title: (body as { title: string }).title, state: 'open' } as T;
        return {} as T;
      }
      if (/actions\/runs\/\d+$/.test(path)) return opts.run as T;
      if (path.includes('/jobs?')) return opts.jobs as T;
      const ann = /check-runs\/(\d+)\/annotations/.exec(path);
      if (ann) return (opts.annotations?.[Number(ann[1])] ?? []) as T;
      if (path.includes('/runs?event=schedule&status=success')) return { workflow_runs: [{ head_sha: 'a'.repeat(40) }] } as T;
      if (path.includes('/issues?labels=')) return (opts.issues ?? []) as T;
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { client, calls };
}

const heavy = () => ({
  run: load<RunInfo>('run-heavy.json'),
  jobs: load<{ jobs: JobInfo[]; total_count: number }>('jobs-heavy.json'),
  annotations: Object.fromEntries([111415376248, 111415376292, 111415376359].map(id => [id, load<unknown[]>(`annotations-${id}.json`)])),
});
const realRows = parseKnownRed(readFileSync(join(ROOT, '.github/nightly-known-red.tsv'), 'utf8')).rows;
const hermesRow: KnownRow = { workflow: 'Heavy Tests', job: 'Hermes door e2e (credentialed, real binary, loud-fail)', signature: 'Run hermes door tests', kind: 'known-skipped', todo: 'PR time to green', review_by: '2026-10-25' };
const scaleRow: KnownRow = { workflow: 'Scale tier', job: 'scale pglite 20000', signature: 'phase watchdog: vectors', kind: 'known-red', todo: 'PGLite bulk-embedding cost at 20k+ chunks', review_by: '2026-10-25' };
const scaleRows = [...realRows, scaleRow];
const recordOf = (body: unknown) => readJsonBlock<IncidentRecord>(String(body), JSON_MARKER)!;
const issueWith = (state: 'open' | 'closed', record: Partial<IncidentRecord>, labels = ['nightly-red']): Issue => ({
  number: 7, title: 'Nightly red: Heavy Tests', state, labels: labels.map(name => ({ name })),
  body: `old\n<!-- ${JSON_MARKER} -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``,
});

describe('nightly-watch incidents', () => {
  test('a red scheduled run with no issue opens one with job/step pairs, the next step and a JSON block', async () => {
    const { client, calls } = fakeClient(heavy());
    const { plan, assessment } = await watchRun({ client, repo: REPO, runId: 37195155240, rows: realRows, today: TODAY, dryRun: false });
    expect(assessment.state).toBe('red');
    expect(plan.action).toBe('create');
    const create = calls.find(c => c.method === 'POST' && c.path === 'repos/{repo}/issues')!;
    expect(create.body!.title).toBe('Nightly red: Heavy Tests');
    expect(create.body!.labels).toEqual(['nightly-red']);
    const body = String(create.body!.body);
    expect(body).toContain('| `Heavy tests` | `Bootstrap offline Docker e2e (placeholder)` | failure | no |');
    expect(body).toContain('### Next step for the agent');
    expect(body).toContain('owner action');
    expect(body).toContain('https://github.com/garrytan/gbrain/compare/');
    const record = recordOf(body);
    expect(record.failing.map(f => f.job).sort()).toEqual(['Heavy tests', 'Hermes door e2e (credentialed, real binary, loud-fail)', 'Plugin doors (codex + claude, install tier)']);
    expect(record.first_red).toEqual({ run_id: 37195155240, sha: record.head_sha });
    expect(record.dispatch_argv).toEqual(['gh', 'workflow', 'run', 'heavy-tests.yml', '--ref', 'master']);
    expect(record.next_step).toBe('code_fix');
    expect(calls.filter(c => c.path === 'repos/{repo}/labels').map(c => c.body!.name)).toEqual(['nightly-red']);
  });

  test('an open incident with the same failing set is updated without a comment; a changed set comments; first red is kept', async () => {
    const first = fakeClient(heavy());
    const created = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true });
    const same = issueWith('open', { ...created.plan.record!, first_red: { run_id: 42, sha: 'f'.repeat(40) } });
    const again = fakeClient({ ...heavy(), issues: [same] });
    const updated = await watchRun({ client: again.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(updated.plan.action).toBe('update');
    expect(again.calls.some(c => c.path.endsWith('/comments'))).toBe(false);
    const patch = again.calls.find(c => c.method === 'PATCH')!;
    expect(recordOf(patch.body!.body).first_red.run_id).toBe(42);

    const changed = fakeClient({ ...heavy(), issues: [issueWith('open', { ...created.plan.record!, failing: [] })] });
    await watchRun({ client: changed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(String(changed.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('Failing set changed');
  });

  test('a closed incident that goes red again reopens with the run attempt (flap)', async () => {
    const { client, calls } = fakeClient({ ...heavy(), issues: [issueWith('closed', { failing: [] })] });
    const { plan } = await watchRun({ client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(plan.action).toBe('reopen');
    expect(calls.find(c => c.method === 'PATCH')!.body!.state).toBe('open');
    const comment = String(calls.find(c => c.path.endsWith('/comments'))!.body!.body);
    expect(comment).toContain('flap');
    expect(comment).toContain('attempt 1');
    expect(recordOf(calls.find(c => c.method === 'PATCH')!.body!.body).first_red.run_id).toBe(37195155240);
  });

  test('a green run closes only when the previously failing jobs executed; a skipped job keeps it open', async () => {
    const green = { run: load<RunInfo>('run-macos-green.json'), jobs: load<{ jobs: JobInfo[]; total_count: number }>('jobs-macos-green.json') };
    const fixed = fakeClient({ ...green, issues: [{ ...issueWith('open', { failing: [{ job: 'macOS 26 validation', job_id: 1, step: 's', errors: [] }] }), title: 'Nightly red: macOS 26 validation' }] });
    const closed = await watchRun({ client: fixed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(closed.plan.action).toBe('close');
    expect(fixed.calls.find(c => c.method === 'PATCH')!.body!.state).toBe('closed');

    const skipped = fakeClient({ ...green, issues: [{ ...issueWith('open', { failing: [{ job: 'macOS codesign', job_id: 1, step: 's', errors: [] }] }), title: 'Nightly red: macOS 26 validation' }] });
    const kept = await watchRun({ client: skipped.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(kept.plan.action).toBe('none');
    expect(skipped.calls.some(c => c.method === 'PATCH')).toBe(false);
    expect(String(skipped.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('did not execute and pass');
  });

  const scaleRun = (message: string) => ({
    run: { ...load<RunInfo>('run-heavy.json'), name: 'Scale tier', path: '.github/workflows/scale-tier.yml' },
    jobs: { total_count: 2, jobs: [
      { id: 1, name: 'scale pglite 20000', conclusion: 'failure', steps: [{ number: 7, name: 'Scale tier (pglite, 20000 pages, enforce)', conclusion: 'failure' }] },
      { id: 2, name: 'scale postgres 20000', conclusion: 'success', steps: [] },
    ] },
    annotations: { 1: [{ annotation_level: 'failure', title: 'Scale phase watchdog', message }] },
  });

  test('a failure matching a known-red row is tracked (known-red label, no comment when unchanged); new error text in the same job is a new incident', async () => {
    const watchdog = '[scale] FAIL phase watchdog: vectors ran 676 s, limit 675 s; the harness was killed (exit 1).';
    const first = fakeClient(scaleRun(watchdog));
    const known = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(known.assessment.state).toBe('known-red');
    expect(known.plan.labels).toEqual(['nightly-red', 'known-red']);
    expect(known.plan.record!.next_step).toBe('known_red_wait');
    expect(known.plan.record!.dispatch_argv).toEqual(['gh', 'workflow', 'run', 'scale-tier.yml', '--ref', 'master', '-f', 'pages=20000']);

    const unchanged = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', known.plan.record!, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    await watchRun({ client: unchanged.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(unchanged.calls.some(c => c.path.endsWith('/comments'))).toBe(false);

    const other = fakeClient(scaleRun('[scale] FAIL find_orphans: an island page is missing'));
    const fresh = await watchRun({ client: other.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(fresh.assessment.state).toBe('red');
    expect(fresh.plan.labels).toEqual(['nightly-red']);
  });

  test('a passed review-by date asks for a fix once, then stays quiet', async () => {
    const watchdog = '[scale] FAIL phase watchdog: vectors ran 676 s';
    const late = '2026-11-01';
    const first = fakeClient(scaleRun(watchdog));
    const created = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(created.plan.record!.next_step).toBe('review_by_passed');
    const before = { ...created.plan.record!, review_by_notified: [] };
    const open = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', before, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    const notified = await watchRun({ client: open.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(String(open.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('Review-by date passed');
    const quiet = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', notified.plan.record!, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    await watchRun({ client: quiet.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(quiet.calls.some(c => c.path.endsWith('/comments'))).toBe(false);
  });

  test('a known-skipped row (the keyless Hermes leg) keeps the run from reading green: the run is not green and the issue stays open with an owner action', async () => {
    const h = heavy();
    const jobs = h.jobs.jobs.map(j => j.name.startsWith('Hermes') ? { ...j, conclusion: 'success', steps: j.steps!.map(s => ({ ...s, conclusion: s.name === 'Run hermes door tests' ? 'skipped' : 'success' })) }
      : { ...j, conclusion: j.conclusion === 'failure' ? 'success' : j.conclusion });
    const { client } = fakeClient({ ...h, jobs: { ...h.jobs, jobs } });
    const { assessment, plan } = await watchRun({ client, repo: REPO, runId: 1, rows: [...realRows, hermesRow], today: TODAY, dryRun: true });
    expect(assessment.state).toBe('known-skipped');
    expect(plan.action).toBe('create');
    expect(plan.record!.next_step).toBe('owner_action');
    expect(plan.body).toContain('This run is not green coverage.');
  });

  test('run-derived text is inert: no mention, no link, no fence break', async () => {
    const hostile = 'shard @attacker see https://evil.example/x ```\n</details> | `rm -rf ~`';
    const h = heavy();
    const jobs = h.jobs.jobs.map(j => (j.id === 111415376248 ? { ...j, name: hostile } : j));
    const annotations = { ...h.annotations, 111415376248: [{ annotation_level: 'failure', message: `boom @maintainer [click](https://evil.example)\n~~~\n\`\`\`` }] };
    const { client } = fakeClient({ ...h, jobs: { ...h.jobs, jobs }, annotations });
    const { plan } = await watchRun({ client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true });
    const body = plan.body!;
    expect(body).not.toMatch(/@attacker|@maintainer/);
    expect(body).not.toContain('https://evil');
    expect(body).not.toContain('`rm -rf ~`');
    expect(body).not.toContain('</details>');
    expect((body.match(/^~~~/gm) ?? []).length % 2).toBe(0);
    expect((body.match(/^```/gm) ?? []).length).toBe(2);
    expect(recordOf(body).failing.some(f => f.job.includes(`@\u200battacker`))).toBe(true);
    expect(inert('a'.repeat(500), 50)).toHaveLength(50);
  });

  test('fork runs are never read; non-scheduled runs are refused unless previewed', async () => {
    const forked = fakeClient({ ...heavy(), run: { ...load<RunInfo>('run-heavy.json'), head_repository: { full_name: 'someone/fork' } } });
    await expect(watchRun({ client: forked.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true })).rejects.toThrow('fork');
    const pushed = fakeClient({ ...heavy(), run: { ...load<RunInfo>('run-heavy.json'), event: 'push' } });
    await expect(watchRun({ client: pushed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false })).rejects.toThrow('only tracks scheduled runs');
  });
});

describe('.github/nightly-known-red.tsv', () => {
  const todos = readFileSync(join(ROOT, 'TODOS.md'), 'utf8');
  const header = '# Columns: workflow, job, signature, kind, todo, review_by\n';
  const row = (r: Partial<KnownRow> = {}) => [r.workflow ?? 'W', r.job ?? 'j', r.signature ?? 's', r.kind ?? 'known-red', r.todo ?? 'Set the ANTHROPIC_API_KEY and OPENAI_API_KEY repo secrets', r.review_by ?? '2026-10-25'].join('\t');

  test('the committed file is valid: at most 3 rows, ISO review-by dates, each TODO present in TODOS.md', () => {
    expect(validateKnownRed(readFileSync(join(ROOT, '.github/nightly-known-red.tsv'), 'utf8'), todos)).toEqual([]);
    expect(readFileSync(join(ROOT, 'docs/RELEASING.md'), 'utf8')).toContain('\n## Nightly-red issues\n');
  });

  test('a fourth row, a bad date, an unknown kind or a missing TODO is refused with the fix', () => {
    const four = header + [row(), row({ job: 'a' }), row({ job: 'b' }), row({ job: 'c' })].join('\n');
    expect(validateKnownRed(four, todos).join('\n')).toContain('at most 3 cells');
    expect(validateKnownRed(header + row({ review_by: '10/25/2026' }), todos).join('\n')).toContain('ISO date');
    expect(validateKnownRed(header + row({ kind: 'flaky' as KnownRow['kind'] }), todos).join('\n')).toContain('known-red or known-skipped');
    const missing = validateKnownRed(header + row({ todo: 'No such TODO' }), todos);
    expect(missing.join('\n')).toContain('is not in TODOS.md');
    expect(missing[0]).toContain('Fix: ');
    expect(missing[0]).toContain('Docs: docs/RELEASING.md#nightly-red-issues');
  });
});

describe('nightly-watch coverage ratchet', () => {
  test('every workflow with a schedule trigger is watched', () => {
    const dir = join(ROOT, '.github/workflows');
    const watch = loadYaml(readFileSync(join(dir, 'nightly-watch.yml'), 'utf8')) as { on: { workflow_run: { workflows: string[] } } };
    const scheduled = readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => loadYaml(readFileSync(join(dir, f), 'utf8')) as { name: string; on?: { schedule?: unknown } })
      .filter(w => w.on && typeof w.on === 'object' && 'schedule' in w.on).map(w => w.name);
    expect(scheduled.length).toBeGreaterThan(5);
    const missing = scheduled.filter(name => !watch.on.workflow_run.workflows.includes(name));
    expect(missing, `Add ${missing.join(', ')} to .github/workflows/nightly-watch.yml on.workflow_run.workflows`).toEqual([]);
  });
});

// ── master-red (push-to-master runs of Test and E2E Tests) ────────────────
// Recorded API JSON from master runs on 2026-10-05: Test runs 8315 (green,
// cab092f5cd) → 8320 red (persistence-history-fixture) → 8331 cancelled →
// 8336 red (managed-lint) → 8343 red (pack-relation-direction-engine) → 8352
// green; E2E Tests run 8486 red (fact-embedding-backfill-parity, a killed
// shard makes its manifest incomplete) → 8493 green.

const MR = join(FIX, 'master-red');
const mr = <T>(name: string): T => JSON.parse(readFileSync(join(MR, name), 'utf8')) as T;
const testRuns = mr<{ workflow_runs: RunInfo[] }>('runs-test-push.json').workflow_runs;
const e2eRuns = mr<{ workflow_runs: RunInfo[] }>('runs-e2e-push.json').workflow_runs;
const byNumber = (runs: RunInfo[], n: number) => runs.find(r => r.run_number === n)!;
const T = { g8315: byNumber(testRuns, 8315), r8320: byNumber(testRuns, 8320), c8331: byNumber(testRuns, 8331), r8336: byNumber(testRuns, 8336), r8343: byNumber(testRuns, 8343), g8352: byNumber(testRuns, 8352) };
const E = { g8470: byNumber(e2eRuns, 8470), r8486: byNumber(e2eRuns, 8486), g8493: byNumber(e2eRuns, 8493) };

/** A stored-method zip (or deflated), enough for readZipEntry. */
function zipOf(name: string, content: string, deflate = true): Uint8Array {
  const data = Buffer.from(content);
  const body = deflate ? deflateRawSync(data) : data;
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + body.length, 16);
  return new Uint8Array(Buffer.concat([local, file, body, central, file, end]));
}

const completeManifest = (run: RunInfo, extra: Partial<CiManifest> = {}): CiManifest => ({
  schema: MANIFEST_SCHEMA, workflow: run.name, event: run.event, sha: run.head_sha, run_id: run.id, run_attempt: run.run_attempt,
  complete: true, problems: [], files: [{ file: 'test/unit-only.test.ts', lane: 'unit', arm: '', executed: 3, failed: 0, skipped: 0 }], failures: [], ...extra,
});

interface WorldIssue extends Issue { created: number; comments: string[] }
class World {
  runs = new Map<number, RunInfo>();
  jobs = new Map<string, { jobs: JobInfo[]; total_count: number }>();
  annotations = new Map<number, unknown[]>();
  manifests = new Map<string, unknown>();
  issues: WorldIssue[] = [];
  timeline = new Map<number, unknown[]>();
  compares = new Map<string, unknown>();
  pulls = mr<Record<string, unknown[]>>('commit-pulls.json');
  calls: Call[] = [];
  clock = 1;
  failGet?: (path: string) => boolean;
  onGet?: (path: string, world: World) => void;

  addRun(run: RunInfo, jobsFile?: string, manifest: unknown | null = completeManifest(run)) {
    this.runs.set(run.id, run);
    const jobs = jobsFile ? mr<{ jobs: JobInfo[]; total_count: number }>(jobsFile) : { total_count: 1, jobs: [{ id: run.id + 1, name: 'test (1)', conclusion: run.conclusion === 'success' ? 'success' : 'failure', steps: [] }] };
    this.jobs.set(`${run.id}/${run.run_attempt}`, jobs);
    for (const j of jobs.jobs) {
      if (j.conclusion === 'failure' && !this.annotations.has(j.id)) {
        try { this.annotations.set(j.id, mr<unknown[]>(`annotations-${j.id}.json`)); } catch { this.annotations.set(j.id, []); }
      }
    }
    if (manifest !== null) this.manifests.set(`${run.id}/${run.run_attempt}`, manifest);
    return this;
  }
  issue(n: number) { return this.issues.find(i => i.number === n)!; }
  labeled(label: string) { return this.issues.filter(i => labelNames(i).includes(label)); }

  client(): GitHubClient {
    const world = this;
    const touch = (i: WorldIssue) => { i.updated_at = `t${world.clock++}`; };
    return {
      async request<R>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<R> {
        world.calls.push({ method, path, body: body as Record<string, unknown> });
        const b = body as Record<string, unknown>;
        if (method === 'GET') {
          world.onGet?.(path, world);
          if (world.failGet?.(path)) throw Object.assign(new Error(`HTTP 502 on ${path}`), { status: 502 });
        }
        let m: RegExpExecArray | null;
        if (method === 'POST' && path === 'repos/{repo}/labels') return {} as R;
        if (method === 'POST' && path === 'repos/{repo}/issues') {
          const issue: WorldIssue = { number: 100 + world.issues.length, title: String(b.title), state: 'open', body: String(b.body), labels: (b.labels as string[]).map(name => ({ name })), created: world.clock, comments: [] };
          touch(issue);
          world.issues.push(issue);
          return issue as R;
        }
        if ((m = /^repos\/\{repo\}\/issues\/(\d+)\/comments$/.exec(path)) && method === 'POST') { const i = world.issue(Number(m[1])); i.comments.push(String(b.body)); touch(i); return {} as R; }
        if ((m = /^repos\/\{repo\}\/issues\/(\d+)$/.exec(path))) {
          const i = world.issue(Number(m[1]));
          if (method === 'PATCH') { Object.assign(i, b.labels ? { ...b, labels: (b.labels as string[]).map(name => ({ name })) } : b); touch(i); }
          return { ...i } as R;
        }
        if ((m = /^repos\/\{repo\}\/issues\/(\d+)\/timeline/.exec(path))) return (world.timeline.get(Number(m[1])) ?? []) as R;
        if ((m = /^repos\/\{repo\}\/issues\?labels=([^&]+)&state=(\w+)/.exec(path))) {
          const label = decodeURIComponent(m[1]!);
          return world.issues.filter(i => labelNames(i).includes(label) && (m![2] === 'all' || i.state === m![2])).sort((x, y) => y.number - x.number).map(i => ({ ...i })) as R;
        }
        if ((m = /^repos\/\{repo\}\/actions\/runs\/(\d+)$/.exec(path))) { const r = world.runs.get(Number(m[1])); if (!r) throw Object.assign(new Error('404'), { status: 404 }); return r as R; }
        if ((m = /^repos\/\{repo\}\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path))) return (world.jobs.get(`${m[1]}/${m[2]}`) ?? { jobs: [], total_count: 0 }) as R;
        if ((m = /^repos\/\{repo\}\/check-runs\/(\d+)\/annotations/.exec(path))) return (world.annotations.get(Number(m[1])) ?? []) as R;
        if ((m = /^repos\/\{repo\}\/actions\/runs\/(\d+)\/artifacts\?name=ci-manifest/.exec(path))) {
          const run = world.runs.get(Number(m[1]))!;
          return { artifacts: world.manifests.has(`${run.id}/${run.run_attempt}`) ? [{ id: run.id * 10 + run.run_attempt, name: 'ci-manifest', expired: false }] : [] } as R;
        }
        if ((m = /^repos\/\{repo\}\/actions\/workflows\/(\d+)\/runs\?event=(\w+)/.exec(path))) {
          const runs = [...world.runs.values()].filter(r => r.workflow_id === Number(m![1]) && r.event === m![2] && (m![2] !== 'push' || r.head_branch === 'master'))
            .filter(r => !path.includes('status=success') || r.conclusion === 'success').sort((x, y) => y.run_number - x.run_number);
          return { workflow_runs: runs } as R;
        }
        if ((m = /^repos\/\{repo\}\/compare\/(\w+)\.\.\.(\w+)$/.exec(path))) {
          const key = `${m[1]}...${m[2]}`;
          const known = [...world.compares.entries()].find(([k]) => { const [a, c] = k.split('...'); return m![1]!.startsWith(a!) && m![2]!.startsWith(c!); });
          return (known?.[1] ?? { status: 'ahead', total_commits: 1, commits: [{ sha: m[2] }], key }) as R;
        }
        if ((m = /^repos\/\{repo\}\/commits\/(\w+)\/pulls$/.exec(path))) return (world.pulls[m[1]!] ?? []) as R;
        throw new Error(`unexpected ${method} ${path}`);
      },
      async download(path: string): Promise<Uint8Array> {
        world.calls.push({ method: 'DOWNLOAD', path });
        const id = Number(/artifacts\/(\d+)\/zip/.exec(path)![1]);
        const run = world.runs.get(Math.floor(id / 10))!;
        return zipOf('ci-manifest.json', JSON.stringify(world.manifests.get(`${run.id}/${id % 10}`)));
      },
    };
  }
}

const testWorld = (...runs: RunInfo[]) => {
  const w = new World();
  w.compares.set('cab092f5cd...df34c67af6', mr('compare-cab092f5cd...df34c67af6.json'));
  for (const r of runs) w.addRun(r, existsSync(join(MR, `jobs-${r.id}.json`)) ? `jobs-${r.id}.json` : undefined);
  return w;
};
const mrState = (issue: Issue) => readJsonBlock<MasterRedState>(issue.body, MR_MARKER)!;
const go = (w: World, run: RunInfo, extra: { dryRun?: boolean; replayIssue?: number } = {}) =>
  watch({ client: w.client(), repo: REPO, runId: run.id, rows: realRows, today: TODAY, dryRun: extra.dryRun ?? false, replayIssue: extra.replayIssue });
const masterIssue = (w: World, workflow = 'Test') => w.labeled('master-red').filter(i => i.title === `Master red: ${workflow}`).sort((a, b) => b.number - a.number)[0];

describe('master-red: push-to-master runs', () => {
  test('a red push-to-master run opens one master-red issue with the suspect range, every failing file and its reproduce line', async () => {
    const w = testWorld(T.g8315, T.r8320);
    const r = await go(w, T.r8320);
    expect(r.track).toBe('push');
    expect(r.masterRed!.action).toBe('create');
    const issue = masterIssue(w)!;
    expect(labelNames(issue)).toEqual(['master-red']);
    const state = mrState(issue);
    expect(state.status).toBe('red');
    expect(state.first_red).toMatchObject({ run_id: T.r8320.id, sha: T.r8320.head_sha });
    expect(state.suspect).toMatchObject({ from_sha: T.g8315.head_sha, to_sha: T.r8320.head_sha, prs: [6067], complete: true });
    expect(state.open_jobs.map(j => j.job)).toEqual(['persistence-validation / Unit-lane PostgreSQL arms 2/2 / Bun 1.4.0']);
    const body = issue.body!;
    expect(body).toContain(`https://github.com/${REPO}/compare/${T.g8315.head_sha}...${T.r8320.head_sha}`);
    expect(body).toContain('PRs merged in range: #6067');
    expect(body).toContain('`bun run test:stress test/persistence-history-fixture.test.ts --iterations 10 --postgres`');
    expect(body).toContain(`Fixes #${issue.number}`);
    expect(body).toContain('known-red rows never apply to push runs');
    expect(body).toContain('within 1 hour');
    expect(body).not.toMatch(/nightly-known-red\.tsv` row \(at most/);
  });

  test('a run cancelled by a newer push changes no state', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const before = JSON.stringify(w.issues);
    w.addRun(T.c8331);
    const r = await go(w, T.c8331);
    expect(r.masterRed!.action).toBe('none');
    expect(r.masterRed!.evaluated).toEqual([]);
    expect(JSON.stringify(w.issues)).toBe(before);
  });

  test('a dropped pending watch is recovered: later watches evaluate every unevaluated run in order and close on green with flake follow-ups', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    for (const r of [T.c8331, T.r8336, T.r8343, T.g8352]) w.addRun(r, existsSync(join(MR, `jobs-${r.id}.json`)) ? `jobs-${r.id}.json` : undefined);
    const r = await go(w, T.g8352);
    expect(r.masterRed!.evaluated).toEqual([T.r8336.id, T.r8343.id, T.g8352.id]);
    expect(r.masterRed!.action).toBe('close');
    const issue = masterIssue(w)!;
    expect(issue.state).toBe('closed');
    const state = mrState(issue);
    expect(state.evaluated).toMatchObject({ run_id: T.g8352.id, run_number: 8352 });
    expect([...new Set(state.tests.map(t => t.file))].sort()).toEqual(['test/managed-lint.test.ts', 'test/pack-relation-direction-engine.test.ts', 'test/persistence-history-fixture.test.ts']);
    expect(issue.comments.at(-1)).toContain('Green:');
    expect(issue.comments.at(-1)).toContain('No merged repair PR is linked');
    const flakes = w.labeled('flake');
    expect(flakes.map(f => f.title).sort()).toEqual(['Flake: test/managed-lint.test.ts', 'Flake: test/pack-relation-direction-engine.test.ts', 'Flake: test/persistence-history-fixture.test.ts']);
    const rec = readJsonBlock<FlakeRecord>(flakes[0]!.body, FLAKE_MARKER)!;
    expect(rec).toMatchObject({ schema: 'flake/v1', master_red_issue: issue.number, owner: 'agent on release duty', platform: 'linux' });
    expect(rec.reproduce).toMatch(/^bun run test:stress test\/[\w./-]+\.test\.ts --iterations 10 --postgres$/);
    expect(rec.expires).toBe('2026-10-19');
    expect(flakes[0]!.body).toContain(`master-red #${issue.number}`);
  });

  test('red then green with the red run\'s watch dropped still records the incident, its suspect range and flake follow-ups', async () => {
    const w = testWorld(T.g8315);
    await go(w, T.g8315);
    expect(w.issues).toHaveLength(0);
    const g = { run_id: T.g8315.id, run_number: 8315, run_attempt: 1, sha: T.g8315.head_sha };
    const prior = { schema: 'master-red/v1', workflow: 'Test', workflow_file: 'test.yml', evaluated: g, status: 'green', first_red: null, latest_red: null, last_green: g, suspect: null, open_jobs: [], open_files: [], failed_jobs: [], tests: [], evidence: null, blocked: [] };
    w.issues.push({ number: 90, title: 'Master red: Test', state: 'closed', labels: [{ name: 'master-red' }], body: jsonBlock(MR_MARKER, prior), created: 0, comments: [] });
    w.addRun(T.r8320, `jobs-${T.r8320.id}.json`).addRun(T.g8352, `jobs-${T.g8352.id}.json`);
    const r = await go(w, T.g8352);
    expect(r.masterRed!.action).toBe('record-closed');
    const issue = masterIssue(w)!;
    expect(issue.state).toBe('closed');
    expect(mrState(issue).suspect!.prs).toEqual([6067]);
    expect(issue.comments.at(-1)).toContain('started and ended between two watches');
    expect(w.labeled('flake').map(f => f.title)).toEqual(['Flake: test/persistence-history-fixture.test.ts']);
  });

  test('the first watch ever (no master-red issue yet) opens only a still-red incident, never one that already ended green', async () => {
    const w = testWorld(T.g8315, T.r8320, T.g8352);
    const r = await go(w, T.g8352);
    expect(r.masterRed!.action).toBe('none');
    expect(w.issues).toHaveLength(0);
  });

  test('an out-of-order red (completing after a newer run was evaluated) is ignored', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    w.addRun(T.g8352, `jobs-${T.g8352.id}.json`);
    await go(w, T.g8352);
    expect(mrState(masterIssue(w)!).evaluated!.run_number).toBe(8352);
    const before = JSON.stringify(w.issues);
    w.addRun(T.r8343, `jobs-${T.r8343.id}.json`);
    const r = await go(w, T.r8343);
    expect(r.masterRed!.action).toBe('none');
    expect(JSON.stringify(w.issues)).toBe(before);
  });

  test('a failure and then a successful rerun of the same run: the newer attempt is evaluated and closes; the older attempt never reverses it', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const rerun: RunInfo = { ...T.r8320, run_attempt: 2, conclusion: 'success' };
    const greenJobs = mr<{ jobs: JobInfo[]; total_count: number }>(`jobs-${T.r8320.id}.json`);
    w.runs.set(rerun.id, rerun);
    w.jobs.set(`${rerun.id}/2`, { ...greenJobs, jobs: greenJobs.jobs.map(j => ({ ...j, conclusion: j.conclusion === 'failure' ? 'success' : j.conclusion })) });
    w.manifests.set(`${rerun.id}/2`, completeManifest(rerun));
    const r = await go(w, rerun);
    expect(r.masterRed!.action).toBe('close');
    expect(mrState(masterIssue(w)!).evaluated).toMatchObject({ run_number: 8320, run_attempt: 2 });
    w.runs.set(rerun.id, T.r8320);
    const again = await go(w, T.r8320);
    expect(again.masterRed!.action).toBe('none');
    expect(masterIssue(w)!.state).toBe('closed');
  });

  test('a green run where a previously failing job did not run keeps the issue open and names the manual-close step', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const green: RunInfo = { ...T.g8352 };
    w.addRun(green, `jobs-${green.id}.json`);
    const jobs = w.jobs.get(`${green.id}/1`)!;
    w.jobs.set(`${green.id}/1`, { ...jobs, jobs: jobs.jobs.filter(j => j.name !== 'persistence-validation / Unit-lane PostgreSQL arms 2/2 / Bun 1.4.0') });
    const r = await go(w, green);
    expect(r.masterRed!.action).toBe('update');
    const issue = masterIssue(w)!;
    expect(issue.state).toBe('open');
    expect(issue.body).toContain('**Not run since:**');
    expect(issue.body).toContain('close #');
    expect(issue.comments.at(-1)).toContain('has not run and passed since it failed');
  });

  test('cancelled jobs are not run: a concurrency or user cancel changes no state and never clears a failure; a timed-out cancel is a failure', async () => {
    const cancelNote = (id: number, message: string) => [{ annotation_level: 'failure', message }].map(a => ({ ...a, id }));
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const failing = 'persistence-validation / Unit-lane PostgreSQL arms 2/2 / Bun 1.4.0';

    const onlyCancelled: RunInfo = { ...T.r8320, id: 999101, run_number: 8321, head_sha: 'd'.repeat(40) };
    w.runs.set(onlyCancelled.id, onlyCancelled);
    w.jobs.set(`${onlyCancelled.id}/1`, { total_count: 3, jobs: [
      { id: 7001, name: failing, conclusion: 'cancelled', steps: [] },
      { id: 7002, name: 'coverage-full-e2e (1)', conclusion: 'cancelled', steps: [] },
      { id: 7003, name: 'test-status', conclusion: 'failure', steps: [] },
    ] });
    w.annotations.set(7001, cancelNote(7001, 'Canceling since a higher priority waiting request for Test-refs/heads/master exists'));
    w.annotations.set(7002, cancelNote(7002, 'The run was canceled by @someone.'));
    w.manifests.set(`${onlyCancelled.id}/1`, completeManifest(onlyCancelled));
    const before = mrState(masterIssue(w)!);
    const r1 = await go(w, onlyCancelled);
    const after = mrState(masterIssue(w)!);
    expect(r1.masterRed!.evidence!.verdict).toBe('ignored');
    expect(r1.masterRed!.evidence!.cancelled).toEqual([failing, 'coverage-full-e2e (1)']);
    expect(after.open_jobs).toEqual(before.open_jobs);
    expect(after.latest_red).toEqual(before.latest_red);
    expect(after.evaluated!.run_id).toBe(onlyCancelled.id);
    expect(masterIssue(w)!.comments).toEqual([]);

    const green: RunInfo = { ...T.g8352 };
    w.addRun(green, `jobs-${green.id}.json`);
    const jobs = w.jobs.get(`${green.id}/1`)!;
    const cancelledId = jobs.jobs.find(j => j.name === failing)!.id;
    w.jobs.set(`${green.id}/1`, { ...jobs, jobs: jobs.jobs.map(j => (j.name === failing ? { ...j, conclusion: 'cancelled' } : j)) });
    w.annotations.set(cancelledId, cancelNote(cancelledId, 'The run was canceled by @someone.'));
    const r2 = await go(w, green);
    expect(r2.masterRed!.action).toBe('update');
    expect(masterIssue(w)!.state).toBe('open');
    expect(mrState(masterIssue(w)!).blocked).toEqual([failing]);

    const timedOut: RunInfo = { ...T.r8320, id: 999102, run_number: 8360, head_sha: 'e'.repeat(40) };
    w.runs.set(timedOut.id, timedOut);
    w.jobs.set(`${timedOut.id}/1`, { total_count: 2, jobs: [{ id: 7101, name: 'test (4)', conclusion: 'cancelled', steps: [] }, { id: 7102, name: 'test-status', conclusion: 'failure', steps: [] }] });
    w.annotations.set(7101, cancelNote(7101, 'The job running on runner ubicloud-x has exceeded the maximum execution time of 30 minutes.'));
    w.manifests.set(`${timedOut.id}/1`, completeManifest(timedOut));
    const r3 = await go(w, timedOut);
    expect(r3.masterRed!.evidence!.verdict).toBe('red');
    expect(mrState(masterIssue(w)!).open_jobs.find(j => j.job === 'test (4)')!.conclusion).toBe('timed_out');
  });

  test('nightly-red: a cancelled job is not a failure, and a previously failing job that was cancelled keeps the incident open', async () => {
    const h = heavy();
    const cancelledAll = h.jobs.jobs.map(j => (j.conclusion === 'failure' ? { ...j, conclusion: 'cancelled' } : j));
    const notes = Object.fromEntries(cancelledAll.filter(j => j.conclusion === 'cancelled').map(j => [j.id, [{ annotation_level: 'failure', message: 'Canceling since a higher priority waiting request for Heavy Tests-refs/heads/master exists' }]]));
    const quiet = fakeClient({ ...h, jobs: { ...h.jobs, jobs: cancelledAll }, annotations: notes });
    const r = await watchRun({ client: quiet.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(r.assessment.failures).toEqual([]);
    expect(r.evidence.cancelled.length).toBeGreaterThan(0);
    expect(quiet.calls.some(c => c.method === 'POST' && c.path === 'repos/{repo}/issues')).toBe(false);

    const green = { run: load<RunInfo>('run-macos-green.json'), jobs: load<{ jobs: JobInfo[]; total_count: number }>('jobs-macos-green.json') };
    const target = green.jobs.jobs[0]!;
    const open = fakeClient({ ...green, jobs: { ...green.jobs, jobs: green.jobs.jobs.map(j => (j.id === target.id ? { ...j, conclusion: 'cancelled' } : j)) },
      annotations: { [target.id]: [{ annotation_level: 'failure', message: 'The run was canceled by @someone.' }] },
      issues: [{ ...issueWith('open', { failing: [{ job: target.name, job_id: 1, step: 's', errors: [] }] }), title: 'Nightly red: macOS 26 validation' }] });
    const kept = await watchRun({ client: open.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(kept.plan.action).toBe('none');
    expect(open.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  test('incomplete evidence (unreadable manifest or annotations) never closes and is reported, never read as zero failures', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    w.addRun(T.g8352, `jobs-${T.g8352.id}.json`, null);
    const r = await go(w, T.g8352);
    expect(r.masterRed!.action).toBe('update');
    const issue = masterIssue(w)!;
    expect(issue.state).toBe('open');
    expect(issue.body).toContain('**Incomplete evidence**');
    expect(issue.body).toContain("has no 'ci-manifest' artifact");

    const red = testWorld(T.g8315, T.r8320);
    red.failGet = p => p.includes('/annotations');
    await go(red, T.r8320);
    const opened = masterIssue(red)!;
    expect(mrState(opened).evidence!.complete).toBe(false);
    expect(opened.body).toContain('could not be read');
  });

  test('a corrupted JSON block is rebuilt from the actions API; an unreadable API never opens or closes on a guess', async () => {
    const w = testWorld(T.g8315, T.r8320, T.r8336);
    await go(w, T.r8320);
    const issue = masterIssue(w)!;
    issue.body = `${issue.body!.split('<!-- master-red:json -->')[0]}<!-- master-red:json -->\n\`\`\`json\n{"schema": "master-red/v1", "broken\n\`\`\``;
    const r = await go(w, T.r8336);
    expect(r.masterRed!.action).toBe('update');
    expect(w.labeled('master-red')).toHaveLength(1);
    const state = mrState(masterIssue(w)!);
    expect(state.rebuilt).toContain('missing or malformed');
    expect(state.first_red!.run_id).toBe(T.r8320.id);
    expect(state.evaluated!.run_id).toBe(T.r8336.id);

    const blind = testWorld(T.g8315, T.r8320);
    await go(blind, T.r8320);
    blind.addRun(T.g8352, `jobs-${T.g8352.id}.json`);
    masterIssue(blind)!.body = 'no block';
    blind.failGet = p => p.includes('/actions/workflows/');
    const writes = () => blind.calls.filter(c => c.method !== 'GET' && c.method !== 'DOWNLOAD').length;
    const before = writes();
    await expect(go(blind, T.g8352)).rejects.toThrow('HTTP 502');
    expect(writes()).toBe(before);
    expect(masterIssue(blind)!.state).toBe('open');
  });

  test('more than three failures are all listed; a database URL in run text is redacted and never reaches a reproduce command', async () => {
    const run: RunInfo = { ...T.r8320, id: 999001, run_number: 8321, head_sha: 'b'.repeat(40) };
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const files = ['a', 'b', 'c', 'd', 'e'].map(x => `test/many-${x}.test.ts`);
    w.runs.set(run.id, run);
    w.jobs.set(`${run.id}/1`, { total_count: 1, jobs: [{ id: 555, name: 'test (3)', conclusion: 'failure', steps: [{ number: 4, name: 'Run test shard 3/8', conclusion: 'failure' }] }] });
    w.annotations.set(555, files.map(f => ({ annotation_level: 'failure', path: f, title: 'error: boom', message: 'DATABASE_URL=postgresql://postgres:hunter2@127.0.0.1:5432/gbrain_test bun test failed' })));
    w.manifests.set(`${run.id}/1`, completeManifest(run));
    await go(w, run);
    const body = masterIssue(w)!.body!;
    for (const f of files) expect(body).toContain(`\`bun run test:stress ${f} --iterations 10 --postgres\``);
    expect(body).not.toContain('hunter2');
    expect(body).toContain('postgresql:\u200b//‹redacted›@');
    expect(body).not.toMatch(/test:stress[^`]*postgres(ql)?:/);
  });

  test('a push watch and a scheduled watch of the same workflow are both evaluated, each on its own issue', async () => {
    const w = testWorld(T.g8315, T.r8320);
    const scheduled: RunInfo = { ...T.r8320, id: 999002, event: 'schedule', run_number: 8322 };
    w.addRun(scheduled, `jobs-${T.r8320.id}.json`);
    const [push, nightly] = await Promise.all([go(w, T.r8320), go(w, scheduled)]);
    expect(push.track).toBe('push');
    expect(nightly.track).toBe('schedule');
    expect(w.labeled('master-red').map(i => i.title)).toEqual(['Master red: Test']);
    expect(w.labeled('nightly-red').map(i => i.title)).toEqual(['Nightly red: Test']);
  });

  test('a dispatch and an automatic watch of the same target resolve to one serialization key; a write that moved the issue makes the watch re-plan', async () => {
    const w = testWorld(T.g8315, T.r8320);
    w.addRun(T.r8336, `jobs-${T.r8336.id}.json`);
    const auto = await resolveTarget(w.client(), REPO, T.r8336.id);
    const dispatched = await resolveTarget(w.client(), REPO, T.r8336.id);
    expect(auto).toEqual({ workflow_id: T.r8336.workflow_id, track: 'push' });
    expect(dispatched).toEqual(auto);
    expect(await resolveTarget(w.client(), REPO, T.r8336.id, undefined)).toEqual(auto);

    w.runs.delete(T.r8336.id);
    await go(w, T.r8320);
    w.addRun(T.r8336, `jobs-${T.r8336.id}.json`);
    const issue = masterIssue(w)!;
    let interfered = false;
    w.onGet = (path, world) => {
      if (!interfered && path === `repos/{repo}/issues/${issue.number}`) {
        interfered = true;
        const i = world.issue(issue.number);
        i.updated_at = `t${world.clock++}`;
      }
    };
    const r = await go(w, T.r8336);
    expect(interfered).toBe(true);
    const plans = w.calls.filter(c => c.path.startsWith('repos/{repo}/issues?labels=master-red')).length;
    expect(plans).toBeGreaterThanOrEqual(3);
    expect(r.masterRed!.action).toBe('update');
    expect(mrState(masterIssue(w)!).evaluated!.run_id).toBe(T.r8336.id);
    expect(w.labeled('master-red')).toHaveLength(1);

    const both = testWorld(T.g8315, T.r8320);
    await Promise.all([go(both, T.r8320), go(both, T.r8320)]);
    const open = both.issues.filter(i => i.title === 'Master red: Test' && i.state === 'open');
    expect(open).toHaveLength(1);
    expect(both.labeled('master-red')).toHaveLength(1);
    for (const twin of both.issues.filter(i => i.title === 'Master red: Test' && i.state === 'closed')) expect(twin.body).toContain(`Duplicate of #${open[0]!.number}`);
  });

  test('E2E Tests closes only when every previously failing test file was among the files a run executed and passed', async () => {
    const w = new World();
    w.addRun(E.g8470).addRun(E.r8486, `jobs-${E.r8486.id}.json`, mr('ci-manifest-37351182593.json'));
    await go(w, E.r8486);
    const issue = masterIssue(w, 'E2E Tests')!;
    const opened = mrState(issue);
    expect(opened.open_files).toContain('test/e2e/fact-embedding-backfill-parity.test.ts');
    expect(opened.tests.filter(t => t.file === 'test/e2e/fact-embedding-backfill-parity.test.ts')).toHaveLength(17);
    expect(opened.evidence!.complete).toBe(false);

    const skippedSelection = { ...mr<CiManifest>('ci-manifest-37354832141.json') };
    skippedSelection.files = skippedSelection.files.filter(f => !f.file.includes('fact-embedding-backfill'));
    w.addRun(E.g8493, `jobs-${E.g8493.id}.json`, skippedSelection);
    const kept = await go(w, E.g8493);
    expect(kept.masterRed!.action).toBe('update');
    expect(masterIssue(w, 'E2E Tests')!.body).toContain('**Not run since:**');
    expect(masterIssue(w, 'E2E Tests')!.body).toContain('replay_issue=');

    const scheduled: RunInfo = { ...E.g8493, id: 999003, event: 'schedule', run_number: 8499 };
    w.addRun(scheduled, `jobs-${E.g8493.id}.json`, { ...mr<CiManifest>('ci-manifest-37354832141.json'), run_id: scheduled.id, event: 'schedule' });
    const nightly = await go(w, scheduled);
    expect(nightly.masterRed!.action).toBe('close');
    expect(masterIssue(w, 'E2E Tests')!.state).toBe('closed');
    expect(masterIssue(w, 'E2E Tests')!.comments.join('\n')).toContain('scheduled full run');
  });

  test('an issue-bound E2E replay dispatch on master clears the files it passed; the green push run with the full selection closes directly', async () => {
    const w = new World();
    w.addRun(E.g8470).addRun(E.r8486, `jobs-${E.r8486.id}.json`, mr('ci-manifest-37351182593.json'));
    await go(w, E.r8486);
    const n = masterIssue(w, 'E2E Tests')!.number;
    const replay: RunInfo = { ...E.g8493, id: 999004, event: 'workflow_dispatch', run_number: 8500 };
    w.addRun(replay, `jobs-${E.g8493.id}.json`, { ...mr<CiManifest>('ci-manifest-37354832141.json'), run_id: replay.id, event: 'workflow_dispatch' });
    const r = await go(w, replay, { replayIssue: n });
    expect(r.track).toBe('replay');
    expect(r.masterRed!.action).toBe('close');
    expect(w.issue(n).comments.at(-1)).toContain('issue-bound replay');

    const direct = new World();
    direct.addRun(E.g8470).addRun(E.r8486, `jobs-${E.r8486.id}.json`, mr('ci-manifest-37351182593.json'));
    await go(direct, E.r8486);
    direct.addRun(E.g8493, `jobs-${E.g8493.id}.json`, mr('ci-manifest-37354832141.json'));
    expect((await go(direct, E.g8493)).masterRed!.action).toBe('close');
  });

  test('a merged repair PR linked to the issue means no flake follow-up', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    const n = masterIssue(w)!.number;
    w.timeline.set(n, [{ event: 'cross-referenced', created_at: '2026-10-05T17:00:00Z', source: { issue: { number: 6079, state: 'closed', pull_request: { merged_at: '2026-10-05T17:30:00Z' } } } }]);
    w.addRun(T.g8352, `jobs-${T.g8352.id}.json`);
    await go(w, T.g8352);
    expect(w.issue(n).state).toBe('closed');
    expect(w.issue(n).comments.at(-1)).toContain('Repair PR(s) #6079 merged; no flake follow-up.');
    expect(w.labeled('flake')).toHaveLength(0);
  });

  test('a flake outside the Postgres arms closes after its repair PR merged and a later complete run passed its file and arm', async () => {
    const w = testWorld(T.g8352);
    const rec: FlakeRecord = {
      schema: 'flake/v1', workflow: 'Test', file: 'test/unit-only.test.ts', test: 'ordering', lane: 'unit', arm: '', platform: 'linux', backend: 'pglite', job: 'test (2)', signature: 'expected 7',
      first_seen: { run_id: 1, run_number: 1, run_attempt: 1, sha: 'c'.repeat(40) }, master_red_issue: 1, owner: 'agent on release duty', opened: TODAY, expires: '2026-10-19', reproduce: null,
    };
    const flake: WorldIssue = { number: 50, title: 'Flake: test/unit-only.test.ts › ordering', state: 'open', labels: [{ name: 'flake' }], body: jsonBlock(FLAKE_MARKER, rec), created: 0, comments: [] };
    w.issues.push(flake);
    const unmerged = await go(w, T.g8352);
    expect(unmerged.flakesClosed).toEqual([]);
    w.timeline.set(50, [{ event: 'cross-referenced', created_at: '2026-10-05T12:00:00Z', source: { issue: { number: 6090, state: 'closed', pull_request: { merged_at: '2026-10-05T12:30:00Z' } } } }]);
    const closed = await go(w, T.g8352);
    expect(closed.flakesClosed).toEqual([50]);
    expect(w.issue(50).state).toBe('closed');
    expect(w.issue(50).comments.at(-1)).toContain('Repair PR #6090 merged');
  });
});

describe('nightly-watch routing and guard', () => {
  const pr = { ...load<RunInfo>('run-heavy.json'), event: 'pull_request', head_branch: 'capy/x' };
  const refuse = async (run: RunInfo, msg: string, replayIssue?: number) => {
    const w = new World();
    w.runs.set(run.id, run);
    await expect(watch({ client: w.client(), repo: REPO, runId: run.id, rows: realRows, today: TODAY, dryRun: false, replayIssue })).rejects.toThrow(msg);
    expect(w.calls.filter(c => c.method !== 'GET')).toEqual([]);
  };
  test('schedule accepted; push-to-master of Test and E2E Tests accepted, including by dispatch with a push-to-master run id', () => {
    expect(routeRun(load<RunInfo>('run-heavy.json'), REPO)).toEqual({ track: 'schedule' });
    expect(routeRun(T.r8320, REPO)).toEqual({ track: 'push' });
    expect(routeRun(E.r8486, REPO)).toEqual({ track: 'push' });
  });
  test('PR run refused', () => refuse(pr, 'pull-request and other runs are refused'));
  test('fork run refused', () => refuse({ ...T.r8320, head_repository: { full_name: 'someone/fork' } }, 'fork'));
  test('push to another branch refused', () => refuse({ ...T.r8320, head_branch: 'capy/topic' }, "push to 'capy/topic'"));
  test('push run of a non-allowlisted workflow refused', () => refuse({ ...T.r8320, name: 'Heavy Tests', path: '.github/workflows/heavy-tests.yml' }, 'which master-red does not watch'));
  test('a replay must be an E2E Tests dispatch on master', () => refuse({ ...T.r8320, event: 'workflow_dispatch' }, 'issue-bound replay must be an E2E Tests dispatch', 7));

  const yaml = (f: string) => loadYaml(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as Record<string, any>;
  test('nightly-watch.yml: master-only workflow_run, guard for schedule + allowlisted push-to-master from this repo, one queue per repo + workflow + track', () => {
    const w = yaml('nightly-watch.yml');
    expect(w.on.workflow_run.branches).toEqual(['master']);
    expect(w.on.workflow_dispatch.inputs.run_id.description).toBe('Scheduled or push-to-master run id to evaluate');
    expect(w.on.workflow_dispatch.inputs.replay_issue).toBeDefined();
    const guard: string = w.jobs.resolve.if;
    for (const part of ["github.event_name == 'workflow_dispatch'", 'head_repository.full_name == github.repository', "workflow_run.event == 'schedule'", "workflow_run.event == 'push'", "head_branch == 'master'", '["Test","E2E Tests"]']) expect(guard).toContain(part);
    expect(Object.keys(PUSH_ALLOWLIST).sort()).toEqual(['E2E Tests', 'Test']);
    expect(w.concurrency).toBeUndefined();
    expect(w.jobs.watch.needs).toBe('resolve');
    expect(w.jobs.watch.concurrency).toEqual({ group: 'nightly-watch-${{ github.repository }}-${{ needs.resolve.outputs.workflow_id }}-${{ needs.resolve.outputs.track }}', 'cancel-in-progress': false });
    expect(w.jobs.watch.permissions).toEqual({ issues: 'write', actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' });
    for (const job of Object.values(w.jobs) as Array<{ steps: Array<{ run?: string }> }>) for (const s of job.steps) expect(s.run ?? '').not.toContain('${{');
  });
  test('test.yml and e2e.yml upload the versioned ci-manifest from executed-receipts', () => {
    for (const f of ['test.yml', 'e2e.yml']) {
      const steps = yaml(f).jobs['executed-receipts'].steps as Array<{ run?: string; with?: { name?: string } }>;
      expect(steps.some(s => s.run?.includes('bun scripts/ci-manifest.ts --receipts-dir'))).toBe(true);
      expect(steps.some(s => s.with?.name === MANIFEST_ARTIFACT)).toBe(true);
    }
  });
  test('a known-red row for the race-hunt job is refused', () => {
    const row = ['Test', 'race-hunt (1)', 'x', 'known-red', 'Set the ANTHROPIC_API_KEY and OPENAI_API_KEY repo secrets', '2026-10-25'].join('\t');
    expect(validateKnownRed(`# h\n${row}`, readFileSync(join(ROOT, 'TODOS.md'), 'utf8')).join('\n')).toContain('race-hunt failures cannot be known-red');
  });
});

describe('ci-manifest', () => {
  test('a manifest is bound to its run: schema, SHA, run id and attempt mismatches are problems', () => {
    const m = completeManifest(T.g8352);
    const bind = { sha: T.g8352.head_sha, run_id: T.g8352.id, run_attempt: 1 };
    expect(checkManifest(m, bind).manifest).toBeDefined();
    expect(checkManifest({ ...m, schema: 'v0' }, bind).problem).toContain('schema');
    expect(checkManifest({ ...m, sha: 'f'.repeat(40) }, bind).problem).toContain('describes run');
    expect(checkManifest(m, { ...bind, run_attempt: 2 }).problem).toContain('re-run all jobs');
  });
  test('readZipEntry reads deflated and stored entries', () => {
    expect(new TextDecoder().decode(readZipEntry(zipOf('ci-manifest.json', '{"a":1}'), 'ci-manifest.json'))).toBe('{"a":1}');
    expect(new TextDecoder().decode(readZipEntry(zipOf('x.json', 'plain', false), 'x.json'))).toBe('plain');
    expect(readZipEntry(zipOf('x.json', 'plain'), 'missing.json')).toBeUndefined();
  });
  test('buildManifest lists failing identities, counts executed files and flags missing receipts as incomplete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-manifest-'));
    writeFileSync(join(dir, 'unit--s1--primary.receipt'), `version=1\nlane=unit\nkind=primary\nshard=1\nof=1\narm=\nsha=${'a'.repeat(40)}\nroot=\nrun_id=5\nrun_attempt=1\nstarted=1\nexit=1\n`);
    writeFileSync(join(dir, 'unit--s1--primary.files'), 'test/a.test.ts\n');
    writeFileSync(join(dir, 'unit--s1--primary.junit.xml'), '<?xml version="1.0"?><testsuites tests="2"><testsuite name="test/a.test.ts" file="test/a.test.ts" tests="2"><testcase name="ok" file="test/a.test.ts"/><testcase name="bad" file="test/a.test.ts"><failure message="x"/></testcase></testsuite></testsuites>');
    const bind = { workflow: 'Test', event: 'push', sha: 'a'.repeat(40), run_id: 5, run_attempt: 1 };
    const m = buildManifest(loadReceiptDir(dir), bind);
    expect(m.complete).toBe(true);
    expect(m.failures).toEqual([{ lane: 'unit', file: 'test/a.test.ts', test: 'bad', arm: '' }]);
    expect(m.files).toEqual([{ file: 'test/a.test.ts', lane: 'unit', arm: '', executed: 2, failed: 1, skipped: 0 }]);
    expect(buildManifest([], bind).complete).toBe(false);
  });
});

describe('operator messages carry docs anchors that resolve', () => {
  const slug = (h: string) => h.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
  const anchors = (doc: string) => new Set(readFileSync(join(ROOT, doc), 'utf8').split('\n').filter(l => /^#{1,6} /.test(l)).map(l => slug(l.replace(/^#+ /, ''))));
  test('every docs/*.md#anchor named by the CI watchers exists', () => {
    const files = ['scripts/nightly-issue.ts', 'scripts/lib/master-red.ts', 'scripts/lib/ci-run.ts', 'scripts/ci-manifest.ts', 'scripts/ci-health-report.ts', 'scripts/release-gate.ts', '.github/workflows/nightly-watch.yml', '.github/workflows/release.yml'];
    const cache = new Map<string, Set<string>>();
    const refs = files.flatMap(f => [...readFileSync(join(ROOT, f), 'utf8').matchAll(/(docs\/[\w./-]+\.md)#([\w-]+)/g)].map(m => [f, m[1]!, m[2]!] as const));
    expect(refs.length).toBeGreaterThan(5);
    const missing = refs.filter(([, doc, anchor]) => {
      if (!cache.has(doc)) cache.set(doc, anchors(doc));
      return !cache.get(doc)!.has(anchor);
    });
    expect(missing).toEqual([]);
  });
});

describe('stress-gate exemption records (lane D contract: scripts/stress/README.md)', () => {
  const e2eRed = async () => {
    const w = new World();
    w.addRun(E.g8470).addRun(E.r8486, `jobs-${E.r8486.id}.json`, mr('ci-manifest-37351182593.json'));
    await go(w, E.r8486);
    return w;
  };
  const manifestFailures = mr<CiManifest>('ci-manifest-37351182593.json').failures;

  test('the master-red body carries one record per failing test identity that the stress gate parser accepts', async () => {
    const w = await e2eRed();
    const rows = parseExemptionBlocks(masterIssue(w, 'E2E Tests')!.body!);
    expect(rows).toHaveLength(new Set(manifestFailures.map(f => `${f.test}|${f.signature}`)).size);
    for (const row of rows) {
      expect(row).toMatchObject({ file: 'test/e2e/fact-embedding-backfill-parity.test.ts', backend: 'postgres', owner: 'agent on release duty', expires: '2026-10-19' });
      const source = manifestFailures.find(f => f.test === row.test)!;
      expect(row.signature).toBe(gateSignature(source.message!));
    }
    expect(rows.map(r => r.test)).toContain('postgres explicit fact embedding backfill > preview is read-only and scoped; null active facts only, with zero provider calls');
  });

  test('the manifest signature is the gate\'s failureSignature of the JUnit message (numbers, temp paths, UUIDs, ANSI masked)', () => {
    for (const msg of [
      'expected 8 dimensions, not 1536',
      '\x1b[31merror\x1b[0m: ENOENT /tmp/gbrain-abc123/x.md\n  at foo (src/a.ts:12:3)\n\n  at bar\n  at baz\n  at qux',
      'job 3f2b8c1a-1111-2222-3333-444455556666 took 12.5s, limit 10s',
      'x'.repeat(400),
    ]) expect(failureSignature(msg)).toBe(gateSignature(msg));
    const dir = mkdtempSync(join(tmpdir(), 'junit-msg-'));
    writeFileSync(join(dir, 'a.junit.xml'), '<?xml version="1.0"?><testsuites tests="2"><testsuite name="s" file="test/a.test.ts" tests="2"><testcase name="ok" classname="s" file="test/a.test.ts"/><testcase name="bad" classname="s" file="test/a.test.ts"><failure type="Error" message="expected 7 &amp; got 6">trace</failure></testcase></testsuite></testsuites>');
    const messages = junitMessages(dir);
    expect([...messages.values()]).toEqual(['expected 7 & got 6']);
  });

  test('flake issues carry their own record; a nightly-red body fed by a scheduled run carries records too', async () => {
    const w = await e2eRed();
    const n = masterIssue(w, 'E2E Tests')!.number;
    w.addRun(E.g8493, `jobs-${E.g8493.id}.json`, mr('ci-manifest-37354832141.json'));
    await go(w, E.g8493);
    expect(w.issue(n).state).toBe('closed');
    const flakes = w.labeled('flake');
    expect(flakes.length).toBeGreaterThan(0);
    for (const f of flakes) {
      const rows = parseExemptionBlocks(f.body!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ backend: 'postgres', owner: 'agent on release duty', expires: '2026-10-19' });
      expect(readJsonBlock<FlakeRecord>(f.body, FLAKE_MARKER)!.signature).toBe(rows[0]!.signature);
    }
    expect(parseExemptionBlocks(w.issue(n).body!)).toEqual([]);

    const nightly = new World();
    const scheduled: RunInfo = { ...E.r8486, id: 999201, event: 'schedule', run_number: 8490 };
    nightly.addRun(scheduled, `jobs-${E.r8486.id}.json`, { ...mr<CiManifest>('ci-manifest-37351182593.json'), run_id: scheduled.id, event: 'schedule' });
    await go(nightly, scheduled);
    const rows = parseExemptionBlocks(nightly.labeled('nightly-red')[0]!.body!);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.owner === 'agent on release duty' && r.expires === '2026-10-19')).toBe(true);
  });

  test('a failure without an exact test name or whose message carries a credential gets no record', async () => {
    const w = testWorld(T.g8315, T.r8320);
    await go(w, T.r8320);
    expect(parseExemptionBlocks(masterIssue(w)!.body!)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'ci-manifest-cred-'));
    writeFileSync(join(dir, 'unit--s1--primary.receipt'), `version=1\nlane=unit\nkind=primary\nshard=1\nof=1\narm=\nsha=${'a'.repeat(40)}\nroot=\nrun_id=5\nrun_attempt=1\nstarted=1\nexit=1\n`);
    writeFileSync(join(dir, 'unit--s1--primary.files'), 'test/a.test.ts\n');
    writeFileSync(join(dir, 'unit--s1--primary.junit.xml'), '<?xml version="1.0"?><testsuites tests="1"><testsuite name="test/a.test.ts" file="test/a.test.ts" tests="1"><testcase name="bad" file="test/a.test.ts"><failure message="connect postgresql://postgres:hunter2@db:5432/x failed"/></testcase></testsuite></testsuites>');
    const m = buildManifest(loadReceiptDir(dir), { workflow: 'Test', event: 'push', sha: 'a'.repeat(40), run_id: 5, run_attempt: 1 }, undefined, junitMessages(dir));
    expect(m.failures[0]!.signature).toBeUndefined();
    expect(m.failures[0]!.message).toContain('postgres:***@');
    expect(JSON.stringify(m)).not.toContain('hunter2');
  });
});
