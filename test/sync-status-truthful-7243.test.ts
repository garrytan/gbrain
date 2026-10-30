/**
 * #7243 (GBRA-133 PR 3a lane S): `gbrain sync status` told an agent less than the truth on a large managed source. Each
 * case is red on master, on PGLite and on Postgres (test/postgres-unit-arms.txt):
 * - plain --json printed every hold inline (thousands of rows); it now prints counts by code and state over every
 *   hold and the first PLAIN_STATUS_HOLDS rows, and --detail pages through the rest with a cursor;
 * - status had no last_commit and no live block naming the drain-lease holder (a serve pass read live_job_id: null);
 * - a last_error from a phase a later pass got past still read live with safe_actions: retry; it reads superseded
 *   with what passed it and its age;
 * - the notifier said "No resident ... watches this source" while its row (and trace) named the resident; it names it;
 * - convergence.target (the newest pass's pin) was the only target status printed, with no converged obligation
 *   behind it; converged_target reads the stored obligation and is null without one.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus, supersedingAttempt } from '../src/core/persistence/sync-status.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { writeGitHold, type GitHoldCode } from '../src/core/persistence/sync-holds.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { claimLease, writeCoverage } from '../src/core/notifier/store.ts';
import { formatNotifierBlock, readNotifierBlock } from '../src/core/notifier/status.ts';
import { PLAIN_STATUS_HOLDS, runSyncStatus } from '../src/commands/sync/operator.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-status-7243-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

/** A managed source with one synced commit; returns its id, root, incarnation and HEAD. */
async function syncedSource(engine: BrainEngine) {
  const id = `st-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'alice-example.md'), '---\ntitle: Alice Example\n---\nAlice keeps the acme-example ledger.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  return { id, root, incarnation, head: git(root, 'rev-parse', 'HEAD') };
}

const CODES: GitHoldCode[] = ['concurrent_write', 'preparation_stalled', 'managed_image_sync_unsupported'];
async function seedHolds(engine: BrainEngine, s: { id: string; incarnation: string }, count: number) {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const path = `held/note-${String(i).padStart(4, '0')}.md`;
    await writeGitHold(engine, { source_id: s.id, incarnation: s.incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null,
      code: CODES[i % CODES.length]!, message: `${path} is held (fixture).`, upstream_version: null, observed_at: now, run_id: null, mode: 'managed', meta: { recovery_version: 1 } });
  }
}

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}
type StatusJson = { holds: Array<{ path: string; code: string; needs_human: boolean }>; holds_summary?: { total: number; by_code: { counts: Record<string, number>; other: number }; by_state: { counts: Record<string, number>; other: number } };
  holds_page?: { returned: number; limit: number | null; complete: boolean; next_cursor: string | null; next_command: string[] | null }; last_commit?: string | null; live?: unknown };
const statusJson = async (engine: BrainEngine, args: string[]) => JSON.parse(await printed(() => runSyncStatus(engine, args))) as StatusJson;

test('plain status --json bounds the holds: counts over every hold plus the first rows; --detail pages through all of them', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const big = await syncedSource(engine), bigger = await syncedSource(engine), small = await syncedSource(engine);
    await seedHolds(engine, big, 150); await seedHolds(engine, bigger, 450); await seedHolds(engine, small, 3);

    const plain = await statusJson(engine, ['--source', big.id, '--json']);
    expect(plain.holds).toHaveLength(PLAIN_STATUS_HOLDS);
    expect(plain.holds_summary!.total).toBe(150);
    expect(plain.holds_summary!.by_code.counts).toEqual({ concurrent_write: 50, preparation_stalled: 50, managed_image_sync_unsupported: 50 });
    expect(Object.values(plain.holds_summary!.by_state.counts).reduce((a, b) => a + b, 0)).toBe(150);
    expect(plain.holds_page).toMatchObject({ returned: PLAIN_STATUS_HOLDS, complete: false, next_cursor: expect.any(String) });
    expect(plain.holds_page!.next_command).toEqual(['gbrain', 'sync', 'status', '--source', big.id, '--json', '--cursor', plain.holds_page!.next_cursor!]);
    // Needs-human holds come first, so the bounded page never hides the ones a person must decide.
    if (plain.holds_summary!.by_state.counts.needs_human) expect(plain.holds[0]!.needs_human).toBe(true);
    // The rows come last, after the summary and the page fields.
    expect(Object.keys(plain).slice(-3)).toEqual(['holds_summary', 'holds_page', 'holds']);

    // Bounded however many holds exist: three times the holds, the same rows and about the same size.
    const plainText = await printed(() => runSyncStatus(engine, ['--source', big.id, '--json']));
    const biggerText = await printed(() => runSyncStatus(engine, ['--source', bigger.id, '--json']));
    expect((JSON.parse(biggerText) as StatusJson).holds).toHaveLength(PLAIN_STATUS_HOLDS);
    expect(Math.abs(biggerText.length - plainText.length)).toBeLessThan(2_000);

    // --detail pages through every hold exactly once.
    const seen: string[] = [];
    let args: string[] | null = ['--source', big.id, '--detail', '--limit', '40', '--json'];
    for (let pages = 0; args && pages < 10; pages++) {
      const page: StatusJson = await statusJson(engine, args);
      expect(page.holds.length).toBeLessThanOrEqual(40);
      seen.push(...page.holds.map(hold => hold.path));
      args = page.holds_page!.next_command?.slice(3) ?? null;
      if (!args) expect(page.holds_page).toMatchObject({ complete: true, next_cursor: null });
    }
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);

    // --all lists every hold in the earlier shape (no page fields); --hold-state lists one state.
    const all = await statusJson(engine, ['--source', big.id, '--detail', '--all', '--json']);
    expect(all.holds).toHaveLength(150);
    expect(all.holds_page).toBeUndefined();
    const held = await statusJson(engine, ['--source', big.id, '--detail', '--hold-state', 'held', '--all', '--json']);
    expect(held.holds.length).toBe(plain.holds_summary!.by_state.counts.held ?? 0);

    // A source whose holds fit on one page keeps the earlier shape.
    const few = await statusJson(engine, ['--source', small.id, '--json']);
    expect(few.holds).toHaveLength(3);
    expect(few.holds_page).toBeUndefined();
    expect(few.holds_summary!.total).toBe(3);

    const text = await printed(() => runSyncStatus(engine, ['--source', big.id]));
    expect(text).toContain(`${150 - PLAIN_STATUS_HOLDS} more not listed here`);
    expect(text.split('\n').filter(line => line.startsWith('    held/')).length).toBe(PLAIN_STATUS_HOLDS);
  }
}), 600_000);

test('status names last_commit and a live block for the drain-lease holder, a serve pass included', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    const idle = await readSyncStatus(engine, s.id, { detail: false });
    expect(idle.last_commit).toBe(s.head);
    expect(idle.live).toBeNull();
    const seen: Array<Awaited<ReturnType<typeof readSyncStatus>>> = [];
    await withDrainLease(engine, s.id, { holder: { kind: 'serve', id: 'serve-job-example' } }, async () => { seen.push(await readSyncStatus(engine, s.id, { detail: false })); return { status: 'synced' } as never; });
    await withDrainLease(engine, s.id, { holder: { kind: 'job', id: '4242' } }, async () => { seen.push(await readSyncStatus(engine, s.id, { detail: false })); return { status: 'synced' } as never; });
    const [serve, job] = seen;
    expect(serve!.live).toMatchObject({ kind: 'serve', id: 'serve-job-example', pid: process.pid, job_id: null, stalled: false });
    expect(serve!.last_commit).toBe(s.head);
    expect(job!.live).toMatchObject({ kind: 'job', id: '4242', job_id: 4242 });
    expect(job!.live_job_id).toBe(4242);
    const json = await statusJson(engine, ['--source', s.id, '--json']);
    expect(json.last_commit).toBe(s.head);
    expect(json).toHaveProperty('live', null);
    expect(await printed(() => runSyncStatus(engine, ['--source', s.id]))).toContain(`last synced commit: ${s.head.slice(0, 8)}`);
  }
}), 300_000);

test('GBRA-133: status reports when the source last converged and when a sync write last committed, so a catch-up never reads as stale', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    const synced = await readSyncStatus(engine, s.id, { detail: false });
    expect(synced.last_sync_at).not.toBeNull();
    expect(synced.last_committed_at).not.toBeNull();
    // A source that last converged a day ago and has committed sync writes since (a long catch-up blocked short of convergence).
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE sources SET last_sync_at=now() - interval '26 hours' WHERE id=$1", [s.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const catchingUp = await readSyncStatus(engine, s.id, { detail: false });
    expect(Date.parse(catchingUp.last_committed_at!) - Date.parse(catchingUp.last_sync_at!)).toBeGreaterThan(25 * 3600_000);
    const json = await statusJson(engine, ['--source', s.id, '--json']) as { last_sync_at?: string; last_committed_at?: string };
    expect(json.last_sync_at).toBe(catchingUp.last_sync_at!);
    expect(json.last_committed_at).toBe(catchingUp.last_committed_at!);
    expect(await printed(() => runSyncStatus(engine, ['--source', s.id]))).toContain(`last committed write: ${catchingUp.last_committed_at} (still importing since it last converged)`);
  }
}), 300_000);

test('a last error a later pass got past reads superseded with what passed it and its age; one it did not get past stays live', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    // The first sync's commits and its pass happened before the failure below.
    await engine.executeRaw("UPDATE persistence_requests SET completed_at = now() - interval '3 hours', created_at = now() - interval '3 hours' WHERE source_id=$1", [s.id]);
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,telemetry,started_at}', to_jsonb(to_char((now() - interval '3 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE op='managed-sync-pass' AND fingerprint=$1`, [`${s.id}:${s.incarnation}`]);
    const key = `${s.id}:cursor-example`;
    await recordManagedSyncFailure(engine, { source_id: s.id, source_incarnation: s.incarnation, path: 'alice-example.md', code: 'storage_error',
      message: 'cannot execute the statement in a read-only transaction', request_id: null, run_id: 'run-example', target: s.head, cursor_key: key, phase: 'receipt', state: 'failed', observation_id: 'run-example:0' });
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at = now() - interval '2 hours' WHERE op='managed-sync-failure' AND fingerprint=$1", [key]);
    const before = await readSyncStatus(engine, s.id, { detail: false });
    expect(before.last_error).toMatchObject({ code: 'storage_error', safe_actions: ['retry'] });
    expect(before.last_error!.superseded).toBeUndefined();

    // A later pass that commits nothing: an idle tick reads the source and stamps up_to_date.
    expect((await performManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('up_to_date');
    const receipt = await readSyncStatus(engine, s.id, { detail: false });
    expect(receipt.last_error!.code).toBe('storage_error');
    expect(receipt.last_error!.superseded).toBeUndefined();

    // The same failure, recorded before its run read the level: the later pass got past that phase.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,phase}', '"resume"') WHERE op='managed-sync-failure' AND fingerprint=$1`, [key]);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at = now() - interval '2 hours' WHERE op='managed-sync-failure' AND fingerprint=$1", [key]);
    const after = await readSyncStatus(engine, s.id, { detail: false });
    expect(after.last_error).toMatchObject({ code: 'storage_error', superseded: { at: expect.any(String), by: 'level_read' } });
    expect(after.last_error!.superseded!.age_seconds).toBeGreaterThanOrEqual(7_190);
    expect(after.last_error!.superseded!.age_seconds).toBeLessThan(7_200 + 600);
    expect(after.reason).not.toBe('last_error');
    expect(await printed(() => runSyncStatus(engine, ['--source', s.id]))).toContain('superseded: a later pass read the source at');
  }
}), 300_000);

test('supersedingAttempt: only evidence newer than the failure and past its phase supersedes it', () => {
  const at = '2026-01-01T10:00:00.000Z', later = '2026-01-01T11:00:00.000Z', earlier = '2026-01-01T09:00:00.000Z';
  expect(supersedingAttempt('admission', at, { pin: later, level_read: later })).toBeNull();
  expect(supersedingAttempt('admission', at, { admission: later })).toEqual({ at: later, by: 'admission' });
  expect(supersedingAttempt('admission', at, { admission: earlier, commit: earlier })).toBeNull();
  expect(supersedingAttempt('receipt', at, { admission: later })).toBeNull();
  expect(supersedingAttempt('checkpoint', at, { commit: later })).toEqual({ at: later, by: 'commit' });
  expect(supersedingAttempt('discovery', at, { pin: later })).toBeNull();
  expect(supersedingAttempt('discovery', at, { pin: later, level_read: later })).toEqual({ at: later, by: 'level_read' });
  expect(supersedingAttempt('resume', at, { pin: later })).toEqual({ at: later, by: 'pin' });
});

test('the notifier names the resident its row recorded when that resident holds no live lease, never "No resident"', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    expect(await claimLease(engine, { hostId: 'host-example', ownerId: 'owner-example', kind: 'serve-http', pid: 4242, leaseMs: 60_000 })).toMatchObject({ owner: true });
    await engine.executeRaw("UPDATE sync_notifier_leases SET expires_at = now() - interval '5 minutes' WHERE host_id='host-example'");
    await writeCoverage(engine, s.id, { head: s.head, mode: 'poll', ownerHostId: 'host-example', ownerKind: 'serve-http', ownerPid: 4242 });
    const block = (await readNotifierBlock(engine, s.id))!;
    expect(block.resident).toBeNull();
    expect(block.drain_holder).toBeNull();
    expect(block.recorded_resident).toMatchObject({ kind: 'serve-http', pid: 4242, host_id: 'host-example', lease_expired_at: expect.any(String) });
    expect(block.fix!.why).toContain("serve-http resident recorded as this source's notifier (PID 4242) holds no live notifier lease");
    expect(block.fix!.why).not.toContain('No resident');
    expect(formatNotifierBlock(s.id, block)).toContain('serve-http (PID 4242) was recorded but holds no live lease');
    const remote = (await readNotifierBlock(engine, s.id, { remote: true }))!;
    expect(remote.recorded_resident).toMatchObject({ kind: 'serve-http', pid: null, host_id: null });
    await engine.executeRaw("DELETE FROM sync_notifier_leases WHERE host_id='host-example'");
  }
}), 300_000);

test("status reports the converged target only from the stored obligation, beside the newest pass's pin", async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    const stamped = await readSyncStatus(engine, s.id, { detail: false });
    expect(stamped.convergence).toMatchObject({ target: s.head, converged_target: s.head });
    // A stuck source's pass row: the newest pass pinned HEAD, and no stamp ever stored a converged obligation.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,obligations}', (completed_keys->0->'obligations') - 'converged')
      WHERE op='managed-sync-pass' AND fingerprint=$1`, [`${s.id}:${s.incarnation}`]);
    const stuck = await readSyncStatus(engine, s.id, { detail: false });
    expect(stuck.convergence).toMatchObject({ target: s.head, converged_target: null, converged_at: null });
    expect(await printed(() => runSyncStatus(engine, ['--source', s.id]))).toContain(`pinned ${s.head.slice(0, 8)}; no converged stamp stored`);
  }
}), 300_000);
