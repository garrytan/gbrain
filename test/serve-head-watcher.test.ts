/**
 * #6858 ask 6 (option C): the serve's on-commit HEAD watcher (src/core/serve-head-watcher.ts), driven through its
 * seams with a fake clock: no timers fire on their own, each test calls `tick()`. What it protects:
 *   - `sync.on_commit` off: no git call and no sync, and flipping it on takes effect at the next flag read;
 *   - a burst of HEAD moves inside the debounce starts one sync, at the last HEAD;
 *   - a commit during the watcher's own sync starts exactly one follow-up once that sync ends;
 *   - while another sync runs or another process holds the drain lease, the move waits and fires afterwards;
 *   - a resumable stop is resumed up to MAX_RESUMES times, then left to the next move;
 *   - a source whose drain lease is held is skipped, so another due source still starts (no starvation);
 *   - errors never leave the loop and are logged once per distinct message; stop() halts polling, and a stop that lands
 *     while discovery is awaiting leaves no watcher open and no git call behind; its promise settles the in-flight step.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MAX_RESUMES, HEAD_FLAG_EVERY_MS, startServeHeadWatcher, type OnCommitJobStatus, type ServeHeadWatcherOptions } from '../src/core/serve-head-watcher.ts';

const sha = (c: string) => c.repeat(40);
const A = sha('a'), B = sha('b'), C = sha('c'), D = sha('d');

function harness(over: Partial<ServeHeadWatcherOptions> = {}, init: { head?: string; dbCommit?: string | null; flag?: boolean } = {}) {
  const s = { t: 1_000_000, head: init.head ?? A, dbCommit: init.dbCommit === undefined ? A : init.dbCommit, flag: init.flag ?? true, running: false, held: false,
    git: 0, flagReads: 0, starts: [] as Array<{ id: string; jobId: string }>, jobs: new Map<string, OnCommitJobStatus>(), lines: [] as string[], intervalCleared: false };
  const w = startServeHeadWatcher({} as BrainEngine, {
    log: line => s.lines.push(line), pollMs: 3000, debounceMs: 3000,
    now: () => s.t,
    setInterval: () => 'interval', clearInterval: () => { s.intervalCleared = true; },
    setTimeout: () => 'timer', clearTimeout: () => {},
    readFlag: async () => { s.flagReads++; return s.flag; },
    listSources: async () => [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: null, lastCommit: s.dbCommit }],
    lastCommit: async () => s.dbCommit,
    revParse: async () => { s.git++; return s.head; },
    syncRunning: () => s.running,
    drainHeld: async () => s.held,
    startSync: async (id) => { const jobId = `job-${s.starts.length + 1}`; s.starts.push({ id, jobId }); s.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: (jobId) => s.jobs.get(jobId) ?? null,
    ...over,
  });
  const finish = (jobId: string, status: OnCommitJobStatus = { state: 'done', outcome: 'synced' }, synced?: string) => { s.jobs.set(jobId, status); if (synced) s.dbCommit = synced; };
  return { w, s, finish, advance: (ms: number) => { s.t += ms; } };
}

describe('serve HEAD watcher', () => {
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
    expect(h.s.starts).toEqual([]);
  });

  test('a HEAD equal to the last synced commit starts nothing; an idle poll is one git call', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) { await h.w.tick(); h.advance(3000); }
    expect(h.s.git).toBe(4);
    expect(h.s.starts).toEqual([]);
  });

  test('a burst of HEAD moves inside the debounce starts one sync, at the last HEAD', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    h.advance(1000); h.s.head = C; await h.w.tick();
    h.advance(1000); h.s.head = D; await h.w.tick();
    h.advance(2000); await h.w.tick();
    expect(h.s.starts).toEqual([]);
    h.advance(1000); await h.w.tick();
    expect(h.s.starts.map(x => x.id)).toEqual(['acme-example']);
    expect(h.s.lines.some(l => l.includes(`HEAD moved to ${D.slice(0, 8)}`))).toBe(true);
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
  });

  test('a commit during the running sync starts exactly one follow-up after it ends', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
    h.s.head = C; h.advance(1000); await h.w.tick();
    h.advance(5000); await h.w.tick();
    expect(h.s.starts).toHaveLength(1);
    h.finish('job-1', { state: 'done', outcome: 'synced' }, B);
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(2);
    h.finish('job-2', { state: 'done', outcome: 'synced' }, C);
    for (let i = 0; i < 5; i++) { h.advance(3000); await h.w.tick(); }
    expect(h.s.starts).toHaveLength(2);
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

  test('a resumable stop is not yet searchable, not a failure: resumed up to MAX_RESUMES times, then left to the next move', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    for (let i = 0; i < MAX_RESUMES + 3; i++) {
      h.advance(3000); await h.w.tick();
      const last = h.s.starts.at(-1);
      if (last && h.s.jobs.get(last.jobId)?.state === 'running') h.finish(last.jobId, { state: 'done', outcome: 'resumable', reason: 'deadline' });
      h.advance(10); await h.w.tick();
    }
    expect(h.s.starts).toHaveLength(1 + MAX_RESUMES);
    expect(h.s.lines.filter(l => l.includes('not yet searchable'))).toHaveLength(MAX_RESUMES);
    expect(h.s.lines.some(l => l.includes(`still resumable after ${MAX_RESUMES} passes`))).toBe(true);
    expect(h.s.lines.some(l => /failed/.test(l))).toBe(false);
    h.s.head = C; h.advance(3000); await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.starts).toHaveLength(2 + MAX_RESUMES);
  });

  test('errors never leave the loop and are logged once per distinct message; a failed start waits for the next move', async () => {
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
    h.advance(3000); await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.lines.filter(l => l.includes('writer_lock_unavailable'))).toHaveLength(1);
    failStart = false;
    h.advance(3000); await h.w.tick();
    expect(h.s.lines.some(l => l.includes('job-ok'))).toBe(false);
    h.s.head = C; h.advance(1); await h.w.tick();
    h.advance(3000); await h.w.tick();
    expect(h.s.lines.some(l => l.includes('job-ok'))).toBe(true);
  });

  test('a refused start is logged once and not retried until HEAD moves', async () => {
    let starts = 0;
    const h = harness({ startSync: async () => { starts++; return { refused: 'permission_denied' }; } });
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    for (let i = 0; i < 4; i++) { h.advance(3000); await h.w.tick(); }
    expect(starts).toBe(1);
    expect(h.s.lines.filter(l => l.includes('refused the sync: permission_denied'))).toHaveLength(1);
  });

  test('stop() halts polling', async () => {
    const h = harness();
    await h.w.tick();
    const git = h.s.git;
    h.w.stop();
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
    h.finish('job-alice-example');
    await h.w.tick();
    expect(starts).toEqual(['alice-example', 'acme-example']);
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
    let release!: (rows: Array<{ sourceId: string; root: string; gitDir: string | null; lastCommit: string | null }>) => void;
    let entered!: () => void;
    const listed = new Promise<Parameters<typeof release>[0]>(resolve => { release = resolve; });
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
