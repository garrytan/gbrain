/**
 * The serve's on-commit watcher (src/core/serve-head-watcher.ts), now the serve adapter over the commit notifier
 * (src/core/commit-notifier.ts, GBRA-133 PR 2a), driven through its seams with a fake clock: no timers fire on their own,
 * each test calls `tick()` and asserts the recorded decisions, never wall-clock time. What it protects:
 *   - `sync.on_commit` off: no git call and no sync, and flipping it on takes effect at the next flag read;
 *   - an idle poll is one git call and no write; a quiet HEAD move starts on the leading edge;
 *   - a commit during the notifier's own sync starts exactly one follow-up, at the last HEAD, after the quiet window;
 *   - while another sync runs or another process holds the drain lease, the move waits and fires afterwards;
 *   - lost wakes are gone: a refused or failed start, an error run and a resumable stop without progress keep the source
 *     due with capped backoff (5 s, 15 s, 1 min, 5 min, then notifier_stalled); a resumable stop with progress resumes;
 *   - a blocked run waits for the operator until HEAD moves; a checkout mid-rebase or with index.lock is not started;
 *   - a source whose drain lease is held does not starve another due source; fair order under the host cap;
 *   - errors never leave the loop and are logged once per distinct message; stop() halts polling, and a stop that lands
 *     while discovery is awaiting leaves no watcher open and no git call behind; its promise settles the in-flight step.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { HEAD_FLAG_EVERY_MS, startServeHeadWatcher, type OnCommitJobStatus, type ServeHeadWatcherOptions, type WatchedSource } from '../src/core/serve-head-watcher.ts';
import { RETRY_BACKOFF_MS } from '../src/core/commit-notifier.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';

const sha = (c: string) => c.repeat(40);
const A = sha('a'), B = sha('b'), C = sha('c'), D = sha('d');
const QUIET = 400;

function harness(over: Partial<ServeHeadWatcherOptions> = {}, init: { head?: string; dbCommit?: string | null; flag?: boolean } = {}) {
  const s = { t: 1_000_000, head: init.head ?? A, dbCommit: init.dbCommit === undefined ? A : init.dbCommit, flag: init.flag ?? true, running: false, held: false,
    git: 0, flagReads: 0, starts: [] as Array<{ id: string; jobId: string; intent: string }>, jobs: new Map<string, OnCommitJobStatus>(), lines: [] as string[], intervalCleared: false };
  const store = memoryNotifierStore({ lastCommit: () => s.dbCommit });
  const w = startServeHeadWatcher({} as BrainEngine, {
    log: line => s.lines.push(line), pollMs: 3000, debounceMs: QUIET, hostId: 'host-example', store,
    now: () => s.t,
    setInterval: () => 'interval', clearInterval: () => { s.intervalCleared = true; },
    setTimeout: () => 'timer', clearTimeout: () => {},
    readFlag: async () => { s.flagReads++; return s.flag; },
    listSources: async () => [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: null, lastCommit: s.dbCommit }],
    lastCommit: async () => s.dbCommit,
    revParse: async () => { s.git++; return s.head; },
    syncRunning: () => s.running,
    drainHeld: async () => s.held,
    startSync: async (id, req) => { const jobId = `job-${s.starts.length + 1}`; s.starts.push({ id, jobId, intent: req.intent }); s.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: (jobId) => s.jobs.get(jobId) ?? null,
    ...over,
  });
  const finish = (jobId: string, status: OnCommitJobStatus = { state: 'done', outcome: 'synced' }, synced?: string) => { s.jobs.set(jobId, status); if (synced) s.dbCommit = synced; };
  const decisions = (kind?: string) => w.decisions.filter(d => !kind || d.decision === kind);
  return { w, s, store, finish, decisions, advance: (ms: number) => { s.t += ms; } };
}

describe('serve HEAD watcher (commit notifier)', () => {
  test('flag off: no git call and no sync; flipping it on takes effect at the next flag read without a restart', async () => {
    const h = harness({}, { flag: false, head: B });
    for (let i = 0; i < 5; i++) { await h.w.tick(); h.advance(10_000); }
    expect(h.s.git).toBe(0);
    expect(h.s.starts).toEqual([]);
    expect(h.s.flagReads).toBeGreaterThan(0);
    expect(h.w.enabled).toBe(false);
    h.s.flag = true;
    h.advance(HEAD_FLAG_EVERY_MS);
    await h.w.tick();
    expect(h.w.enabled).toBe(true);
    expect(h.s.git).toBe(1);
    expect(h.s.lines.some(l => l.includes('on-commit: enabled'))).toBe(true);
    h.s.flag = false;
    h.advance(HEAD_FLAG_EVERY_MS);
    await h.w.tick();
    expect(h.w.enabled).toBe(false);
    const git = h.s.git;
    h.advance(10_000);
    await h.w.tick();
    expect(h.s.git).toBe(git);
  });

  test('a HEAD equal to the last synced commit starts nothing; an idle poll is one git call and writes nothing after the first observation', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) { await h.w.tick(); h.advance(3000); }
    expect(h.s.git).toBe(4);
    expect(h.s.starts).toEqual([]);
    expect(h.store.writes.map(w => w.kind)).toEqual(['coverage']);
  });

  test('leading edge: a quiet HEAD move starts at once, with no fixed debounce', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    expect(h.s.starts.map(x => x.id)).toEqual(['acme-example']);
    expect(h.decisions('start')).toHaveLength(1);
    expect(h.decisions('defer_window')).toEqual([]);
    expect(h.s.lines.some(l => l.includes(`HEAD moved to ${B.slice(0, 8)}`))).toBe(true);
  });

  test('a burst of commits during the running sync starts exactly one follow-up, at the last HEAD, after the trailing window', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
    h.s.head = C; h.advance(100); await h.w.tick();
    h.s.head = D; h.advance(100); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
    h.finish('job-1', { state: 'done', outcome: 'synced' }, B);
    h.advance(100); await h.w.tick();
    expect(h.decisions('follow_up')).toHaveLength(1);
    expect(h.decisions('defer_window').at(-1)?.waitMs).toBe(QUIET - 300);
    expect(h.s.starts).toHaveLength(1);
    h.advance(QUIET); await h.w.tick();
    expect(h.s.starts).toHaveLength(2);
    expect(h.s.lines.some(l => l.includes(`HEAD moved to ${D.slice(0, 8)}`))).toBe(true);
    h.finish('job-2', { state: 'done', outcome: 'synced' }, D);
    for (let i = 0; i < 5; i++) { h.advance(3000); await h.w.tick(); }
    expect(h.s.starts).toHaveLength(2);
    expect(h.decisions('converged')).toHaveLength(1);
    expect(h.store.states.get('acme-example')).toMatchObject({ state: 'idle', first_due_at: null });
  });

  test('while another sync runs or another process holds the drain lease, the move waits and fires afterwards', async () => {
    const h = harness();
    await h.w.tick();
    h.s.running = true; h.s.head = B; await h.w.tick();
    h.advance(10_000); await h.w.tick();
    expect(h.s.starts).toEqual([]);
    h.s.running = false; h.s.held = true;
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toEqual([]);
    expect(h.decisions('defer_drain_lease').length).toBeGreaterThan(0);
    h.s.held = false;
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
  });

  test('a sync that already covered HEAD (cron, or the CLI) is not repeated', async () => {
    const h = harness();
    await h.w.tick();
    h.s.running = true; h.s.head = B; await h.w.tick();
    h.s.dbCommit = B; h.s.running = false;
    h.advance(3000); await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toEqual([]);
  });

  test('a resumable stop that advanced is resumed, without a cap; one that did not advance backs off like a failure', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = D; await h.w.tick();
    for (const synced of [B, C]) {
      h.finish(h.s.starts.at(-1)!.jobId, { state: 'done', outcome: 'resumable', reason: 'deadline' }, synced);
      h.advance(QUIET); await h.w.tick();
      h.advance(QUIET); await h.w.tick();
    }
    expect(h.decisions('resume')).toHaveLength(2);
    expect(h.s.starts).toHaveLength(3);
    h.finish(h.s.starts.at(-1)!.jobId, { state: 'done', outcome: 'resumable', reason: 'deadline' });
    h.advance(QUIET); await h.w.tick();
    expect(h.decisions('retry').map(d => d.waitMs)).toEqual([RETRY_BACKOFF_MS[0]]);
    expect(h.store.states.get('acme-example')?.state).toBe('retry');
    h.advance(RETRY_BACKOFF_MS[0]); await h.w.tick();
    expect(h.s.starts).toHaveLength(4);
  });

  test('lost wake: a refused start keeps the source due and retries at 5 s, 15 s, 1 min and 5 min, then reports notifier_stalled', async () => {
    let starts = 0;
    const h = harness({ startSync: async () => { starts++; return { refused: 'permission_denied' }; } });
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    for (const wait of [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!]) { h.advance(wait); await h.w.tick(); }
    expect(starts).toBe(6);
    expect([...h.decisions('retry'), ...h.decisions('stalled')].map(d => d.waitMs)).toEqual([...RETRY_BACKOFF_MS, ...RETRY_BACKOFF_MS.slice(-1), ...RETRY_BACKOFF_MS.slice(-1)]);
    expect(h.decisions('stalled').length).toBeGreaterThan(0);
    const row = h.store.states.get('acme-example')!;
    expect(row).toMatchObject({ state: 'retry', reason: 'notifier_stalled', last_error_code: 'notifier_stalled' });
    expect(row.first_due_at).not.toBeNull();
    expect(h.s.lines.filter(l => l.includes('notifier_stalled'))).toHaveLength(1);
    expect(h.s.lines.some(l => l.includes('gbrain sync --source acme-example --no-pull'))).toBe(true);
  });

  test('lost wake: a failed or blocked run keeps the source; failed retries, blocked waits for the operator until HEAD moves', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    h.finish('job-1', { state: 'error', error: 'connection reset' });
    h.advance(1); await h.w.tick();
    expect(h.decisions('retry').map(d => d.detail)).toEqual(['sync_failed']);
    h.advance(RETRY_BACKOFF_MS[0]); await h.w.tick();
    expect(h.s.starts).toHaveLength(2);
    h.finish('job-2', { state: 'done', outcome: 'blocked', reason: 'needs_human' });
    h.advance(1); await h.w.tick();
    expect(h.store.states.get('acme-example')).toMatchObject({ state: 'operator_blocked', reason: 'needs_human' });
    for (let i = 0; i < 3; i++) { h.advance(300_000); await h.w.tick(); }
    expect(h.s.starts).toHaveLength(2);
    h.s.head = C; h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(3);
  });

  test('quiet predicate: a checkout mid-rebase or holding index.lock is not started until it is quiet', async () => {
    let quiet = false;
    const h = harness({ quiet: () => quiet });
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toEqual([]);
    expect(h.decisions('defer_git_busy').length).toBeGreaterThan(0);
    quiet = true;
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
  });

  test('errors never leave the loop and are logged once per distinct message; a failed start is retried', async () => {
    let failGit = true;
    let failStart = true;
    let listFails = 1;
    const h = harness({
      revParse: async () => { if (failGit) throw new Error('fatal: not a git repository'); return h.s.head; },
      listSources: async () => { if (listFails-- > 0) throw new Error('connection refused'); return [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: null, lastCommit: A }]; },
      startSync: async () => { if (failStart) throw new Error('writer_lock_unavailable'); return { jobId: 'job-ok' }; },
      jobStatus: () => ({ state: 'running' }),
    });
    await h.w.tick();
    expect(h.s.lines.filter(l => l.includes('connection refused'))).toHaveLength(1);
    h.advance(60_000); await h.w.tick();
    for (let i = 0; i < 3; i++) { h.advance(3000); await expect(h.w.tick()).resolves.toBeUndefined(); }
    expect(h.s.lines.filter(l => l.includes('not a git repository'))).toHaveLength(1);
    failGit = false;
    h.s.head = B; await h.w.tick();
    expect(h.s.lines.filter(l => l.includes('writer_lock_unavailable'))).toHaveLength(1);
    failStart = false;
    h.advance(RETRY_BACKOFF_MS[0]); await h.w.tick();
    expect(h.s.lines.some(l => l.includes('job-ok'))).toBe(true);
  });

  test('stop() halts polling', async () => {
    const h = harness();
    await h.w.tick();
    const git = h.s.git;
    await h.w.stop();
    expect(h.s.intervalCleared).toBe(true);
    h.s.head = B; h.advance(10_000);
    await h.w.tick();
    expect(h.s.git).toBe(git);
    expect(h.s.starts).toEqual([]);
  });

  test('a source whose drain lease is held does not starve another due source; it starts once its lease is free', async () => {
    const held = new Set(['acme-example']);
    const starts: string[] = [];
    const h = harness({
      listSources: async () => ['acme-example', 'alice-example'].map(sourceId => ({ sourceId, root: `/brains/${sourceId}`, gitDir: null, lastCommit: A })),
      drainHeld: async (id) => held.has(id),
      startSync: async (id) => { starts.push(id); h.s.jobs.set(`job-${id}`, { state: 'running' }); return { jobId: `job-${id}` }; },
    }, { head: B });
    for (let i = 0; i < 3; i++) { await h.w.tick(); h.advance(3000); }
    expect(starts).toEqual(['alice-example']);
    held.delete('acme-example');
    h.finish('job-alice-example', { state: 'done', outcome: 'synced' });
    await h.w.tick();
    expect(starts).toEqual(['alice-example', 'acme-example']);
  });

  test('fair order under the host cap: the source started least recently goes first, so a busy source never starves another', async () => {
    const starts: string[] = [];
    const commits = new Map<string, string>([['acme-example', A], ['alice-example', A]]);
    const h = harness({
      listSources: async () => ['acme-example', 'alice-example'].map(sourceId => ({ sourceId, root: `/brains/${sourceId}`, gitDir: null, lastCommit: A })),
      revParse: async (root) => root.endsWith('acme-example') ? h.s.head : C,
      lastCommit: async (id) => commits.get(id) ?? null,
      startSync: async (id) => { starts.push(id); h.s.jobs.set(`job-${starts.length}`, { state: 'running' }); return { jobId: `job-${starts.length}` }; },
    }, { head: B });
    await h.w.tick();
    expect(starts).toEqual(['acme-example']);
    expect(h.decisions('defer_cap').map(d => d.source)).toEqual(['alice-example']);
    h.s.head = D;
    h.finish('job-1', { state: 'done', outcome: 'synced' }); commits.set('acme-example', B);
    h.advance(QUIET); await h.w.tick();
    expect(starts).toEqual(['acme-example', 'alice-example']);
  });

  test('a source whose last_commit already covers HEAD is skipped for the next due one', async () => {
    const starts: string[] = [];
    const h = harness({
      listSources: async () => ['acme-example', 'alice-example'].map(sourceId => ({ sourceId, root: `/brains/${sourceId}`, gitDir: null, lastCommit: A })),
      lastCommit: async (id) => id === 'acme-example' ? B : A,
      startSync: async (id) => { starts.push(id); return { jobId: `job-${id}` }; },
      jobStatus: () => ({ state: 'running' }),
    }, { head: B });
    await h.w.tick();
    h.advance(3000);
    await h.w.tick();
    expect(starts).toEqual(['alice-example']);
  });

  test('stop() while discovery awaits: no watcher stays open, no git call runs, and stop() settles the in-flight step', async () => {
    let release!: (rows: WatchedSource[]) => void;
    let entered!: () => void;
    const listed = new Promise<WatchedSource[]>(resolve => { release = resolve; });
    const entry = new Promise<void>(resolve => { entered = resolve; });
    let open = 0;
    const h = harness({
      listSources: async () => { entered(); return listed; },
      watch: () => { open++; return () => { open--; }; },
    }, { head: B });
    const flight = h.w.tick();
    await entry;
    let settled = false;
    const stopping = h.w.stop().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release([{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: '/brains/acme-example/.git', lastCommit: A }]);
    await stopping;
    await flight;
    expect(settled).toBe(true);
    expect(open).toBe(0);
    expect(h.s.git).toBe(0);
    expect(h.s.starts).toEqual([]);
  });
});
