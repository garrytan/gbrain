/**
 * #5984 Phase 4.5 (Postgres only): an agent's page write from another process goes ahead of the queued sync
 * groups of a draining managed sync that do not name its page, waits in order behind one that does, and a
 * stream of writes still lets the drain publish a group after each one. `GBRAIN_SYNC_FOREGROUND_PRIORITY=0`
 * restores the FIFO (and fails the first case).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { withEnv } from './helpers/with-env.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { setClaimOwnerForTest } from '../src/core/persistence/claim-phase.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-fg-priority-'));
let engine: BrainEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const pad = (i: number) => String(i).padStart(3, '0');
async function fixture(e: BrainEngine, count: number) {
  const id = `fgp-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${pad(i)}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
type Row = { id: string; request_id: string; created: number; grp: string | null; slug: string; sequence: string; state: string; kind: string | null; completed: number | null };
const rows = (e: BrainEngine, source: string) => e.executeRaw<Row>(`SELECT id::text,request_id::text,intent->>'group' AS grp,slug,sequence::text,state,intent->>'kind' AS kind,
  (extract(epoch FROM created_at)*1000)::float8 AS created,
  (extract(epoch FROM completed_at)*1000)::float8 AS completed FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [source]);
const until = async (check: () => Promise<boolean>, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error('timed out'); await Bun.sleep(10); }
};
/** Records every request the drain's process claims (FIFO, lane head or group follower), with the time. */
function recordClaims(e: BrainEngine): { claims: Map<string, number>; restore: () => void } {
  const claims = new Map<string, number>();
  const execute = e.executeRaw;
  // When each claim transaction chose its row: a claim already deciding when the write was admitted is not an overtake.
  const chose = new WeakMap<object, number>();
  e.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    const sent = Date.now();
    if (/FOR UPDATE OF r SKIP LOCKED/.test(sql)) chose.set(this, sent);
    const out = await execute.call(this, sql, params, opts as never) as Array<{ id?: string; state?: string }>;
    if (/^UPDATE persistence_requests( r)? SET state='running'/.test(sql.trim())) for (const row of out) if (row.id && row.state === 'running') claims.set(String(row.id), chose.get(this) ?? sent);
    return out as never;
  } as BrainEngine['executeRaw'];
  return { claims, restore: () => { e.executeRaw = execute; } };
}
function writer(source: string, slugs: string[], intervalMs = 0, go?: string, preparingHoldMs = 0, ready?: string) {
  const out = join(home, `worker-${randomUUID()}.json`);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'foreground-put-page-worker.ts')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GBRAIN_HOME: home, WORKER_DATABASE_URL: databaseUrl, WORKER_SOURCE: source, WORKER_SLUGS: slugs.join(',') || '-', WORKER_INTERVAL_MS: String(intervalMs), WORKER_OUT: out, ...(go ? { WORKER_GO: go } : {}), ...(ready ? { WORKER_READY: ready } : {}),
      ...(preparingHoldMs ? { WORKER_PREPARING_HOLD_MS: String(preparingHoldMs) } : {}) } });
  return async () => {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`writer exited ${code}: ${stderr.slice(-2000)}`);
    return JSON.parse(readFileSync(out, 'utf8')) as Array<{ slug: string; state: string; error?: string; submitted: number; returned: number; admitted?: number; held?: [number, number] }>;
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 12);
  engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

/**
 * Starts a drain, waits until it has sync groups queued that nobody claimed, then writes `slug` from another
 * process. Returns the queued sync rows admitted before the write, the drain's claims and the final rows.
 */
async function writeDuringDrain(lanes: number, slug: (queued: Row[]) => string, laneHold = 0, preparingHoldMs = 0) {
  const e = engine!, source = await fixture(e, 64);
  const recorder = recordClaims(e);
  // Each sync page holds its group open a little before commit, so groups stay queued while the writer starts. With
  // `laneHold`, once the write is sent each lane group that has applied its pages holds before its commit turn (no
  // counter lock held) until the write commits or `laneHold` ms pass, and `beside` records, for each foreground
  // publication in this process, whether a lane group was then open.
  let laneOpen = 0, armed = false;
  const beside: boolean[] = [];
  const written = Promise.withResolvers<void>();
  // With `preparingHoldMs`, whichever process claims the write holds its preparation that long, and this process stamps
  // its claims with another process's owner, so either way the write is claimed elsewhere and unpublished meanwhile.
  let heldHere: [number, number] | undefined;
  if (preparingHoldMs) setClaimOwnerForTest({ kind: 'mcp', pid: 1, version: 'test', nonce: 'another-process' });
  installFaultHook(async (point, detail) => {
    if (preparingHoldMs && point === 'consumer:preparing' && detail.operation === 'put_page' && !heldHere) {
      const start = Date.now();
      await Bun.sleep(preparingHoldMs);
      heldHere = [start, Date.now()];
    }
    if (detail.sourceId !== source) return;
    if (point === 'publication:before_commit' && detail.operation !== 'submit_job') beside.push(laneOpen > 0);
    if (point === 'publication:after_commit' && detail.operation !== 'submit_job') written.resolve();
    if (laneHold && armed && point === 'lane:applied') {
      laneOpen++;
      try { await Promise.race([written.promise, Bun.sleep(laneHold)]); } finally { laneOpen--; }
    }
    if (!laneHold && point === 'publication:before_commit' && detail.operation === 'submit_job') await Bun.sleep(150);
  });
  try {
    const drain = performSync(e, { sourceId: source, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes });
    let queued: Row[] = [];
    // The writer process starts now and writes (the slug the go file names) once a sync group is queued that nobody has started.
    const go = join(home, `go-${randomUUID()}`);
    const finish = writer(source, [], 0, go, preparingHoldMs);
    await until(async () => {
      const all = await rows(e, source);
      const begun = new Set(all.filter(row => row.state !== 'queued').map(row => row.request_id));
      queued = all.filter(row => row.state === 'queued' && row.kind?.startsWith('managed_sync_') && !(row.grp && begun.has(row.grp)) && !begun.has(row.request_id));
      // With lanes the drain admits groups ahead; without them only the publishing group is out, so the write comes while one runs.
      return all.some(row => row.state === 'committed') && (lanes > 1 ? queued.length >= 4 : all.some(row => row.state === 'running' && row.kind?.startsWith('managed_sync_')));
    });
    const target = slug(queued.length ? queued : await rows(e, source).then(all => all.filter(row => row.state === 'queued')));
    armed = true;
    // With `laneHold`, the write is sent while a lane group holds the worktree lease, so only the drain's process can publish it.
    if (laneHold) await until(async () => laneOpen > 0);
    writeFileSync(go, target);
    let before: Row[] = [];
    await until(async () => {
      const all = await rows(e, source);
      const put = all.find(row => row.slug === target && !row.kind?.startsWith('managed_sync_'));
      if (!put) return false;
      // Queued sync rows admitted before the write whose group has not started (a started group's followers go with it).
      const started = new Set(all.filter(row => row.state !== 'queued').map(row => row.request_id));
      before = all.filter(row => row.kind?.startsWith('managed_sync_') && row.state === 'queued' && BigInt(row.sequence) < BigInt(put.sequence)
        && !(row.grp && started.has(row.grp)));
      return true;
    });
    const [written] = await finish();
    const result = await drain;
    return { source, target, before, written: written!, result, claims: recorder.claims, final: await rows(e, source), beside, held: heldHere ?? written!.held };
  } finally { recorder.restore(); installFaultHook(undefined); setClaimOwnerForTest(undefined); }
}

for (const lanes of [2, 1]) {
  test(`a write to a page no queued group names commits before another sync group starts (lanes ${lanes})`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
    if (!engine) return;
    resetWriteSwitches();
    const run = await writeDuringDrain(lanes, () => `notes/foreground-${lanes}`);
    expect(run.written.state).toBe('committed');
    expect(run.result.status).toBe('first_sync');
    // With lanes, groups admitted ahead were queued when the write arrived; it still went first.
    if (lanes > 1) expect(run.before.length).toBeGreaterThan(0);
    const put = run.final.find(row => row.slug === run.target)!;
    // No sync group started (its head chosen) after the write's admission committed and before the write was claimed
    // (with lanes, a claimed write publishes beside the lane groups, so they may start again) or, without lanes,
    // committed. `created` is the admission transaction's start: a claim choosing its row before the commit cannot see the write.
    expect(run.written.admitted).toBeGreaterThanOrEqual(put.created - 5);
    const windowEnd = lanes > 1 ? run.claims.get(put.id) ?? put.completed! : put.completed!;
    const heads = run.final.filter(row => row.kind?.startsWith('managed_sync_') && (row.grp ?? row.request_id) === row.request_id);
    const early = heads.filter(row => { const claimed = run.claims.get(row.id) ?? Infinity; return claimed >= run.written.admitted! && claimed < windowEnd; }).map(row => row.slug);
    expect(early).toEqual([]);
    expect(run.final.filter(row => row.kind?.startsWith('managed_sync_import')).every(row => row.state === 'committed')).toBe(true);
  }), 300_000);
}

test('a write the writer\'s own process claimed but cannot publish beside the lanes still holds back new lane heads', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  resetWriteSwitches();
  // The write is claimed by a process other than the drain's (the writer's own, or the drain's stamped as another's) and
  // held in preparation for 1.5 s. No lane head may be chosen while that claim is held.
  const run = await writeDuringDrain(2, () => 'notes/claimed-elsewhere', 0, 1500);
  expect(run.written.state).toBe('committed');
  expect(run.result.status).toBe('first_sync');
  expect(run.before.length).toBeGreaterThan(0);
  const [start, end] = run.held!;
  const heads = run.final.filter(row => row.kind?.startsWith('managed_sync_') && (row.grp ?? row.request_id) === row.request_id);
  expect(heads.filter(row => { const claimed = run.claims.get(row.id) ?? Infinity; return claimed >= start && claimed < end; }).map(row => row.slug)).toEqual([]);
}), 300_000);

test('a write publishes beside the running lane groups instead of waiting for them, and the lanes keep starting groups', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  resetWriteSwitches();
  const run = await writeDuringDrain(2, () => 'notes/beside-lanes', 20_000);
  expect(run.written.state).toBe('committed');
  expect(run.result.status).toBe('first_sync');
  const put = run.final.find(row => row.slug === run.target)!;
  // The drain's process published the write while a lane group's transaction was open in it.
  expect(run.beside).toEqual([true]);
  expect(run.final.filter(row => row.kind?.startsWith('managed_sync_import')).every(row => row.state === 'committed')).toBe(true);
}), 300_000);

test('a write to a page a queued group names waits for that group and settles after it, in order', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  resetWriteSwitches();
  const run = await writeDuringDrain(2, queued => queued.at(-1)!.slug);
  expect(run.result.status).toBe('first_sync');
  const sync = run.final.find(row => row.slug === run.target && row.kind === 'managed_sync_import')!;
  const put = run.final.find(row => row.slug === run.target && row.kind !== 'managed_sync_import')!;
  expect(sync.state).toBe('committed');
  // The write was claimed after the import it names committed, so it met the imported page: a write that creates
  // the page is refused because the page now exists, exactly as if it had arrived after the sync.
  expect(run.written).toMatchObject({ state: 'error', error: expect.stringContaining('already exists') });
  expect(['failed', 'conflict']).toContain(put.state);
  expect(sync.completed!).toBeLessThan(put.completed!);
  expect(run.claims.has(put.id) ? run.claims.get(put.id)! : put.completed!).toBeGreaterThanOrEqual(sync.completed! - 5);
  const lastSync = Math.max(...run.final.filter(row => row.kind === 'managed_sync_import').map(row => row.completed!));
  expect(put.completed!).toBeLessThanOrEqual(lastSync + 5_000);
}), 300_000);

test('a stream of writes from another process still lets the drain publish a group after each write', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  resetWriteSwitches();
  const e = engine, source = await fixture(e, 64);
  // The writer process boots and connects before the drain starts, so the stream begins right after the first group
  // commits instead of whenever a cold process gets going (by then a fast drain can have committed most of its groups).
  const go = join(home, `go-${randomUUID()}`), ready = join(home, `ready-${randomUUID()}`);
  const finish = writer(source, [], 0, go, 0, ready);
  await until(async () => existsSync(ready));
  const drain = performSync(e, { sourceId: source, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 2 });
  await until(async () => (await rows(e, source)).some(row => row.state === 'committed' && row.kind === 'managed_sync_import'));
  writeFileSync(go, Array.from({ length: 12 }, (_, i) => `notes/stream-${i}`).join(','));
  const written = await finish();
  const result = await drain;
  expect(written.map(write => write.state)).toEqual(written.map(() => 'committed'));
  expect(result.status).toBe('first_sync');
  const final = await rows(e, source);
  const writes = final.filter(row => row.slug.startsWith('notes/stream-')).map(row => row.completed!).sort((a, b) => a - b);
  const groupCommits = final.filter(row => row.kind === 'managed_sync_import' && (row.grp ?? row.request_id) === row.request_id).map(row => row.completed!);
  // The drain kept publishing while the writes kept coming: sync groups committed throughout the stream, about one
  // per write (each foreground commit lets the drain start a group before the next write goes ahead).
  const during = groupCommits.filter(at => at > writes[0]! && at < writes.at(-1)!).length;
  expect(during).toBeGreaterThanOrEqual(Math.floor((writes.length - 1) / 2));
}), 300_000);
