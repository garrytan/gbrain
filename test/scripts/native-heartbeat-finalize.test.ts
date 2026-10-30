/**
 * scripts/native/heartbeat-finalize.ts: the Linux watcher that ends a darwin-x64 heartbeat its cell left pending. A fake
 * GitHub API (Bun.serve) answers the run's jobs and the commit's statuses and records every status post; the end-to-end
 * case drives scripts/native/heartbeat.sh with the real curl against the same fake, which refuses the cell's (curl's)
 * terminal post the way an unreachable API does, and only that one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const FINALIZE = resolve(import.meta.dir, '../../scripts/native/heartbeat-finalize.ts');
const HEARTBEAT = resolve(import.meta.dir, '../../scripts/native/heartbeat.sh');
const TOKEN = 'ghs_fake_token_example';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

type Status = { state: string; context: string; description: string; target_url?: string; created_at: string };
type Job = { name: string; status: string; conclusion: string | null; html_url: string };

function fakeGitHub(jobs: Job[], seed: Status[] = [], opts: { failPosts?: (body: Status, agent: string) => number | null } = {}) {
  const statuses: Status[] = [...seed];
  const posts: Status[] = [];
  const auth: string[] = [];
  let clock = Date.parse('2026-10-24T21:46:48Z');
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    auth.push(request.headers.get('authorization') ?? '');
    if (url.pathname === '/repos/owner-example/repo-example/actions/runs/42/jobs') {
      expect(url.searchParams.get('filter')).toBe('latest');
      return Response.json({ total_count: jobs.length, jobs });
    }
    if (url.pathname === '/repos/owner-example/repo-example/commits/abc123/statuses') {
      const page = Number(url.searchParams.get('page') ?? 1), per = Number(url.searchParams.get('per_page') ?? 30);
      return Response.json([...statuses].reverse().slice((page - 1) * per, page * per));
    }
    if (url.pathname === '/repos/owner-example/repo-example/statuses/abc123' && request.method === 'POST') {
      const body = await request.json() as Status;
      const code = opts.failPosts?.(body, request.headers.get('user-agent') ?? '') ?? null;
      if (code) return new Response('unavailable', { status: code });
      const status = { ...body, created_at: new Date(clock += 1000).toISOString() };
      statuses.push(status); posts.push(status);
      return Response.json(status, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  } });
  return { server, posts, statuses, auth, api: `http://127.0.0.1:${server.port}`, latest: (context: string) => [...statuses].reverse().find(s => s.context === context) };
}

const env = (api: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: tmpdir(), GH_TOKEN: TOKEN,
  GITHUB_REPOSITORY: 'owner-example/repo-example', GITHUB_RUN_ID: '42', GITHUB_API_URL: api, GBRAIN_HEARTBEAT_SHA: 'abc123',
  GBRAIN_HEARTBEAT_ENABLED: '1', GBRAIN_HEARTBEAT_FINALIZE_BACKOFF_MS: '10', ...extra });
// Async spawns: the fake API answers on this process's event loop, which a spawnSync would block.
async function spawn(argv: string[], vars: Record<string, string>) {
  const child = Bun.spawn(argv, { env: vars, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr, out: stdout + stderr };
}
const finalize = (api: string, extra?: Record<string, string>) => spawn(['bun', FINALIZE], env(api, extra));
const cellJob = (bun: string, conclusion = 'success', status = 'completed'): Job =>
  ({ name: `native-locks / darwin-x64 / Bun ${bun}`, status, conclusion, html_url: `https://github.com/owner-example/repo-example/actions/runs/42/job/${bun}` });
const pending = (bun: string, at: string): Status =>
  ({ state: 'pending', context: `diag/native-heartbeat/darwin-x64/${bun}`, description: `darwin-x64/${bun} backup-portability-native.serial.test.ts 32s`, created_at: at });

describe('darwin-x64 heartbeat finalize (the Linux watcher)', () => {
  test('a cell whose terminal post never landed is finalized success, naming its real conclusion and last heartbeat', async () => {
    const gh = fakeGitHub([cellJob('1.4.4'), cellJob('1.4.0', 'failure'), { name: 'native-locks / linux-x64-glibc / Bun 1.4.4', status: 'completed', conclusion: 'success', html_url: 'x' }],
      [pending('1.4.4', '2026-10-24T21:46:48Z'), pending('1.4.0', '2026-10-24T21:50:01Z')]);
    try {
      const run = await finalize(gh.api);
      expect(run.exitCode).toBe(0);
      expect(gh.posts).toHaveLength(2);
      expect(gh.latest('diag/native-heartbeat/darwin-x64/1.4.4')).toMatchObject({ state: 'success',
        description: 'darwin-x64/1.4.4 finished success | finalized by the watcher job; last heartbeat 21:46:48Z',
        target_url: 'https://github.com/owner-example/repo-example/actions/runs/42/job/1.4.4' });
      expect(gh.latest('diag/native-heartbeat/darwin-x64/1.4.0')!.description).toStartWith('darwin-x64/1.4.0 finished failure | ');
      for (const post of gh.posts) { expect(post.description.length).toBeLessThanOrEqual(140); expect(post.description).not.toContain(TOKEN); }
      expect(gh.auth.every(header => header === `Bearer ${TOKEN}`)).toBe(true);
      expect(run.out).not.toContain(TOKEN);
    } finally { gh.server.stop(true); }
  });

  test('a context the cell finished itself, one it never posted, and a cell still running are left alone', async () => {
    const done: Status = { state: 'success', context: 'diag/native-heartbeat/darwin-x64/1.4.4', description: 'darwin-x64/1.4.4 finished success | free 89%', created_at: '2026-10-24T21:47:30Z' };
    const gh = fakeGitHub([cellJob('1.4.4'), cellJob('1.4.0'), cellJob('1.4.9', null as never, 'in_progress')],
      [pending('1.4.4', '2026-10-24T21:46:48Z'), done, pending('1.4.9', '2026-10-24T21:47:00Z')]);
    try {
      expect((await finalize(gh.api)).exitCode).toBe(0);
      expect(gh.posts).toEqual([]);
    } finally { gh.server.stop(true); }
  });

  test('finds the cell context past the first page of statuses', async () => {
    const noise = Array.from({ length: 150 }, (_, i): Status => ({ state: 'success', context: `ci/other-${i}`, description: 'x', created_at: '2026-10-24T21:00:00Z' }));
    const gh = fakeGitHub([cellJob('1.4.4')], [pending('1.4.4', '2026-10-24T21:46:48Z'), ...noise]);
    try {
      expect((await finalize(gh.api)).exitCode).toBe(0);
      expect(gh.latest('diag/native-heartbeat/darwin-x64/1.4.4')!.state).toBe('success');
    } finally { gh.server.stop(true); }
  });

  test('a post the API keeps refusing is retried three times, then warns without failing the job', async () => {
    let tries = 0;
    const gh = fakeGitHub([cellJob('1.4.4')], [pending('1.4.4', '2026-10-24T21:46:48Z')], { failPosts: () => { tries++; return 503; } });
    try {
      const run = await finalize(gh.api);
      expect(run.exitCode).toBe(0);
      expect(tries).toBe(3);
      expect(run.out).toContain('::warning::darwin-x64 heartbeat finalize: POST /repos/owner-example/repo-example/statuses/abc123 failed: HTTP 503');
    } finally { gh.server.stop(true); }
  });

  test('does nothing when disabled (a fork pull request)', async () => {
    const gh = fakeGitHub([cellJob('1.4.4')], [pending('1.4.4', '2026-10-24T21:46:48Z')]);
    try {
      expect((await finalize(gh.api, { GBRAIN_HEARTBEAT_ENABLED: '0' })).exitCode).toBe(0);
      expect(gh.auth).toEqual([]);
    } finally { gh.server.stop(true); }
  });

  test('end to end: the cell terminal post fails every attempt and stays pending, then the watcher ends it on the real conclusion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-heartbeat-finalize-'));
    roots.push(root);
    const gh = fakeGitHub([cellJob('1.4.4')], [], { failPosts: (body, agent) => body.state === 'success' && agent.startsWith('curl/') ? 503 : null });
    const cellEnv = env(gh.api, { GBRAIN_HEARTBEAT_CELL: 'darwin-x64/1.4.4', GBRAIN_HEARTBEAT_DIR: join(root, 'state'), GBRAIN_HEARTBEAT_INTERVAL_S: '1' });
    const heartbeat = (args: string[]) => spawn(['bash', HEARTBEAT, ...args], cellEnv);
    try {
      expect((await heartbeat(['start'])).exitCode).toBe(0);
      await Bun.sleep(1500);
      const stop = await heartbeat(['stop', 'success']);
      expect(stop.exitCode).toBe(0);
      expect(stop.stderr.match(/heartbeat: success post failed \(curl exit 0, HTTP 503\)/g)).toHaveLength(3);
      expect(gh.latest('diag/native-heartbeat/darwin-x64/1.4.4')!.state).toBe('pending');
      expect((await finalize(gh.api)).exitCode).toBe(0);
      const final = gh.latest('diag/native-heartbeat/darwin-x64/1.4.4')!;
      expect(final.state).toBe('success');
      expect(final.description).toMatch(/^darwin-x64\/1\.4\.4 finished success \| finalized by the watcher job; last heartbeat \d\d:\d\d:\d\dZ$/);
    } finally { await heartbeat(['stop', 'success']); gh.server.stop(true); }
  }, 30_000);
});
