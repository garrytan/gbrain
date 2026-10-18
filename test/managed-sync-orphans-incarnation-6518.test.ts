/**
 * #6518: incarnation-scoped readers versus incarnation-blind writers. A managed
 * source re-pointed at a new checkout gets a new incarnation; the cursor and
 * failure rows written under the old one stay in `op_checkpoints`, every
 * incarnation-joined reader drops them (`readManagedSyncFailures`, the orphan
 * classifier, the clear paths), and the local ledger keeps their mirror rows.
 *
 * Contract pinned here (reviewed plan G3.2, [R18], CEO C05):
 *  - `classifyManagedSyncOrphans` names such rows `incarnation_retired`, and
 *    `retireManagedSyncOrphan` removes cursor + failure + manifest + mirror row
 *    even when a live local writer with `syncOptions` exists (that veto applies
 *    to live incarnations only); a manifest another cursor shares is kept.
 *  - a ledger row whose `managed_cursor_key` has no durable failure row under
 *    any incarnation is `mirror_only`: listed by the preview, pruned on
 *    `--apply`, and pruned by the successful-sync clear path for its source.
 *  - the orphan diagnostic is reachable from doctor with no visible managed
 *    failure (`managed.length === 0`), locally with the repair command and
 *    remotely without keys or paths.
 *  - `doctor --fast` (no engine) reports mirror rows as `warn` "could not be
 *    verified", never `fail`, while an old unmanaged failure keeps `fail`.
 *  - `readSyncStatus` filters the cursor by the current incarnation: an
 *    old-only cursor is `cursor: null` + `cursor_incarnation_retired` whose
 *    `next` is the repair preview; beside a current cursor it is invisible.
 *  - a failed durable read never reads as "no failures" and never authorises a
 *    mirror deletion; archived sources are excluded and refused at apply.
 * Both engines where a database is involved.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { classifyManagedSyncOrphans, retireManagedSyncOrphan } from '../src/core/persistence/managed-sync-orphans.ts';
import { clearSettledManagedSyncFailures, readManagedSyncFailures, recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { managedSyncOrphansRepair } from '../src/core/repair/managed-sync-orphans.ts';
import { runRepair } from '../src/core/repair/core.ts';
import { repairSpec } from '../src/core/repair/registry.ts';
import { loadSyncFailures, mirrorManagedSyncFailure, recordFailures } from '../src/core/sync-failure-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6518-'));
const env = { GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host' };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const ctx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false } as unknown as OperationContext);
const spec = repairSpec('managed-sync-orphans');

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  await withEnv(env, async () => { for (const engine of engines) await registerLocalWriter(engine, 'cli'); });
}, 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) { rmSync(join(home, 'sync-failures.jsonl'), { force: true }); await fn(engine); } });
const keys = async (engine: BrainEngine, op: string, like: string) => (await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2 ORDER BY fingerprint', [op, `${like}%`])).map(row => row.fingerprint);
const mirrors = (prefix: string) => loadSyncFailures().filter(row => row.managed_cursor_key?.startsWith(prefix)).map(row => row.managed_cursor_key);

/** A live source plus bookkeeping written under its previous incarnation (the issue's re-pointed checkout). */
async function fixture(engine: BrainEngine) {
  const id = `s6518-${randomUUID().slice(0, 8)}`, prefix = `ck-${id}-`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  const [{ incarnation: old }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  const liveWriterId = (await readLocalWriter(engine, 'cli'))!.id;
  const principal = { authority: { writer: { principal: { kind: 'local_cli', id: liveWriterId } } } };
  const cursor = (key: string, incarnation: string, body: Record<string, unknown>) => engine.executeRaw(
    "INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)",
    [key, JSON.stringify([{ sourceId: id, incarnation, index: 0, total: 1, target: 'deadbeef', syncOptions: { full: false }, ...principal, ...body }])]);
  const failure = (key: string, incarnation: string, runId: string, path: string) => recordManagedSyncFailure(engine, { source_id: id, source_incarnation: incarnation, path, code: 'recovery_required',
    message: 'The private physical-checkout identity cannot be verified.', request_id: null, run_id: runId, target: 'deadbeef', cursor_key: key, phase: 'resume', state: 'failed', observation_id: `${runId}:0` });
  // The probe's pair: an unfinished cursor of the live writer (with recorded options) and its same-key failure row, plus the manifest.
  await cursor(`${prefix}old`, old, { runId: `${prefix}run-old` });
  await failure(`${prefix}old`, old, `${prefix}run-old`, 'notes/2026-09-30.md');
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest',$1,'[{\"path\":\"notes/2026-09-30.md\"}]'::jsonb)", [`${prefix}run-old`]);
  // A failure row under the old incarnation with no cursor under its key.
  await failure(`${prefix}oldfail`, old, `${prefix}run-oldfail`, 'notes/2026-09-29.md');
  // Re-point: the source gets a new incarnation, as `sources set-path` to a new checkout does.
  await engine.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [id]);
  const [{ incarnation: current }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  expect(current).not.toBe(old);
  return { id, prefix, old, current, cursor, failure, principal };
}

test('an old-incarnation cursor and failure are incarnation_retired; doctor reaches the diagnostic with no visible managed failure; sync status does not name the dead cursor', async () => each(async engine => {
  const f = await fixture(engine);
  // The issue's symptoms on master: every incarnation-joined reader drops the rows while the mirror keeps them.
  expect((await readManagedSyncFailures(engine, [f.id])).length).toBe(0);
  expect(mirrors(f.prefix).sort()).toEqual([`${f.prefix}old`, `${f.prefix}oldfail`]);

  const before = await classifyManagedSyncOrphans(engine, [f.id]);
  expect(before.orphans.map(orphan => [orphan.kind, orphan.cursor_key, orphan.reason, orphan.source_incarnation]).sort()).toEqual([
    ['failure_row', `${f.prefix}oldfail`, 'incarnation_retired', f.old], ['unfinished_cursor', `${f.prefix}old`, 'incarnation_retired', f.old]]);
  expect(before.retained).toEqual([]);

  // (ii) reachable with managed.length === 0: locally with the repair, remotely without keys or paths.
  const local = await checkSyncFailures(engine, { remote: false, sourceIds: [f.id] });
  expect(local?.status).toBe('warn');
  expect(local!.message).toContain('incarnation_retired');
  expect(local!.message).toContain(`gbrain repair managed-sync-orphans --source ${f.id}`);
  expect(local!.message).toContain('says nothing about whether the current source\'s files are imported');
  expect((local!.details as { orphans: unknown[] }).orphans).toHaveLength(2);
  const remote = await checkSyncFailures(engine, { remote: true, sourceIds: [f.id] });
  expect(remote?.status).toBe('warn');
  expect(remote!.message).not.toContain(f.prefix);
  expect(remote!.message).not.toContain('notes/');
  expect(remote!.details).toBeUndefined();

  // (4) status: the dead cursor is not reported as resumable; the next step is the repair preview.
  const status = await readSyncStatus(engine, f.id);
  expect(status.cursor).toBeNull();
  expect(status.run_id).toBeNull();
  expect(status.last_error).toMatchObject({ code: 'cursor_incarnation_retired', needs_human: false, safe_actions: ['repair'] });
  expect(status.next?.argv).toEqual(['gbrain', 'repair', 'managed-sync-orphans', '--source', f.id]);
  expect(JSON.stringify(status)).not.toContain('deadbeef');
  // An old-only cursor beside a current one: the current cursor is the one shown.
  await f.cursor(`${f.prefix}current`, f.current, { runId: `${f.prefix}run-current`, index: 0, total: 3 });
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest',$1,'[{\"path\":\"a.md\"},{\"path\":\"b.md\"},{\"path\":\"c.md\"}]'::jsonb)", [`${f.prefix}run-current`]);
  const beside = await readSyncStatus(engine, f.id);
  expect(beside.cursor).toMatchObject({ index: 0, total: 3, done: false });
  expect(beside.run_id).toBe(`${f.prefix}run-current`);
  expect(beside.last_error?.code).not.toBe('cursor_incarnation_retired');
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE fingerprint IN ($1,$2)", [`${f.prefix}current`, `${f.prefix}run-current`]);

  // The repair: preview lists both with the class; apply retires them although the recording principal is the live local writer with syncOptions.
  const scope = { brain_id: 'host', source_ids: [f.id] };
  const preview = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec });
  expect(preview.affected).toBe(2);
  const applied = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash, spec });
  expect(applied.applied).toBe(2);
  expect(await keys(engine, 'managed-sync', f.prefix)).toEqual([]);
  expect(await keys(engine, 'managed-sync-failure', f.prefix)).toEqual([]);
  expect(await keys(engine, 'managed-sync-manifest', f.prefix)).toEqual([]);
  expect(mirrors(f.prefix)).toEqual([]);
  expect((await classifyManagedSyncOrphans(engine, [f.id])).orphans).toEqual([]);
  expect(await checkSyncFailures(engine, { remote: false, sourceIds: [f.id] })).toBeNull();
  const after = await readSyncStatus(engine, f.id);
  expect(after.cursor).toBeNull();
  expect(after.last_error).toBeNull();
  expect(after.next).toBeNull();
}), 120_000);

test('a mirror row with no durable failure is mirror_only: listed, pruned on apply, pruned by the successful-sync clear; a durable row appearing before apply keeps it', async () => each(async engine => {
  const id = `s6518m-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  const mirror = (key: string) => mirrorManagedSyncFailure({ source_id: id, path: 'notes/a.md', code: 'recovery_required', message: 'stale', target: 'deadbeef', cursor_key: key,
    request_id: null, run_id: `run-${key}`, observation_id: `run-${key}:0`, first_seen: new Date().toISOString(), attempts: 1 });
  mirror(`${id}-m1`); mirror(`${id}-m2`); mirror(`${id}-m3`);
  // A mirror whose durable row exists under the current incarnation is not mirror_only.
  await recordManagedSyncFailure(engine, { source_id: id, source_incarnation: incarnation, path: 'notes/live.md', code: 'storage_error', message: 'durable', request_id: null,
    run_id: 'run-live', target: 'deadbeef', cursor_key: `${id}-live`, phase: 'receipt', state: 'failed', observation_id: 'run-live:0' });

  const classified = await classifyManagedSyncOrphans(engine, [id]);
  expect(classified.orphans.filter(orphan => orphan.reason === 'mirror_only').map(orphan => orphan.cursor_key).sort()).toEqual([`${id}-m1`, `${id}-m2`, `${id}-m3`]);
  expect(classified.orphans.find(orphan => orphan.cursor_key === `${id}-m1`)).toMatchObject({ kind: 'mirror_row', source_id: id });

  const scope = { brain_id: 'host', source_ids: [id] };
  const preview = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec });
  expect(preview.affected).toBe(4); // three mirrors + the durable no_cursor failure row
  // A durable failure row appears under m2 between preview and apply: its mirror is no longer mirror-only and is kept
  // (a `<checkpoint>` path, which no imported commit settles, so the #6288 clear below leaves the durable row alone).
  await recordManagedSyncFailure(engine, { source_id: id, source_incarnation: incarnation, path: '<checkpoint>', code: 'storage_error', message: 'late', request_id: null,
    run_id: `run-${id}-m2`, target: 'deadbeef', cursor_key: `${id}-m2`, phase: 'receipt', state: 'failed', observation_id: `run-${id}-m2:1` });
  const applied = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash, spec });
  expect(applied.applied).toBe(3);
  expect(mirrors(`${id}-`).sort()).toEqual([`${id}-m2`]);
  expect(await keys(engine, 'managed-sync-failure', `${id}-`)).toEqual([`${id}-m2`]);

  // The successful-sync clear path prunes this source's mirror-only rows and leaves another source's alone.
  mirror(`${id}-m4`);
  const otherId = `${id}-other`;
  mirrorManagedSyncFailure({ source_id: otherId, path: 'x.md', code: 'storage_error', message: 'other', target: null, cursor_key: `${otherId}-m`, request_id: null, run_id: 'r', observation_id: 'r:0', first_seen: new Date().toISOString(), attempts: 1 });
  await clearSettledManagedSyncFailures(engine, { sourceId: id, incarnation, root: home, gitRoot: home, target: 'deadbeef' });
  expect(mirrors(`${id}-`).sort()).toEqual([`${id}-m2`, `${otherId}-m`]);
}), 120_000);

test('doctor --fast (no engine) warns on mirror rows it cannot verify and keeps fail for an old unmanaged failure', async () => each(async () => {
  const id = `s6518f-${randomUUID().slice(0, 8)}`;
  mirrorManagedSyncFailure({ source_id: id, path: 'notes/a.md', code: 'recovery_required', message: 'stale', target: 'deadbeef', cursor_key: `${id}-m`, request_id: null, run_id: 'r',
    observation_id: 'r:0', first_seen: new Date(Date.now() - 10 * 86_400_000).toISOString(), attempts: 1 });
  // Age the mirror row past the 72 h fail cadence: before, it alone turned the fast check `fail`.
  const aged = loadSyncFailures().map(row => row.managed_cursor_key === `${id}-m` ? { ...row, ts: new Date(Date.now() - 10 * 86_400_000).toISOString() } : row);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(home, 'sync-failures.jsonl'), aged.map(row => JSON.stringify(row)).join('\n') + '\n');
  const mirrorOnly = await checkSyncFailures(null, { remote: false, sourceIds: [id] });
  expect(mirrorOnly?.status).toBe('warn');
  expect(mirrorOnly!.message).toContain('could not be verified without a database connection');
  expect(mirrorOnly!.message).toContain('gbrain doctor --only sync_failures');
  expect(mirrorOnly!.message).toMatch(/less certainty/);
  expect(mirrorOnly!.remediation).toBeUndefined();
  // A genuinely old unmanaged failure in the same ledger keeps its authoritative severity.
  recordFailures(id, [{ path: 'legacy.md', error: 'YAML broke' }], 'c1');
  const agedBoth = loadSyncFailures().map(row => row.path === 'legacy.md' ? { ...row, ts: new Date(Date.now() - 10 * 86_400_000).toISOString() } : row);
  writeFileSync(join(home, 'sync-failures.jsonl'), agedBoth.map(row => JSON.stringify(row)).join('\n') + '\n');
  const mixed = await checkSyncFailures(null, { remote: false, sourceIds: [id] });
  expect(mixed?.status).toBe('fail');
  expect(mixed!.message).toContain('1 unresolved sync failure(s)');
  expect(mixed!.message).toContain('could not be verified');
  const remote = await checkSyncFailures(null, { remote: true, sourceIds: [id] });
  expect(remote?.status).toBe('fail');
  expect(remote!.message).not.toContain('legacy.md');
}));

test('a failing durable read is not "no failures" and never deletes a mirror; archived sources are excluded and refused at apply; a recreated source retires its old rows', async () => each(async engine => {
  const f = await fixture(engine);
  const executeRaw = engine.executeRaw;
  const failReads = () => { engine.executeRaw = (async (sql: string, params?: unknown[]) => {
    // The classifier's mirror read (the durable rows under the ledger's keys) fails; the current-incarnation read still answers.
    if (/managed-sync-failure/.test(sql) && (/fingerprint=ANY/.test(sql) || sql.startsWith("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure'"))) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return executeRaw.call(engine, sql, params);
  }) as BrainEngine['executeRaw']; };
  const restore = () => { engine.executeRaw = executeRaw; };
  // Preview with a healthy read, then the apply's own re-check fails: the mirror and the rows stay.
  const scope = { brain_id: 'host', source_ids: [f.id] };
  mirrorManagedSyncFailure({ source_id: f.id, path: 'notes/m.md', code: 'storage_error', message: 'm', target: null, cursor_key: `${f.prefix}mirror`, request_id: null, run_id: 'rm', observation_id: 'rm:0', first_seen: new Date().toISOString(), attempts: 1 });
  const preview = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec });
  expect(preview.affected).toBe(3);
  failReads();
  try {
    await expect(classifyManagedSyncOrphans(engine, [f.id])).rejects.toMatchObject({ code: 'ECONNRESET' });
    const check = await checkSyncFailures(engine, { remote: false, sourceIds: [f.id] });
    expect(check?.status).toBe('warn');
    expect(check!.message).toContain('could not be classified (ECONNRESET)');
    expect(check!.message).toContain('not proof');
    await expect(retireManagedSyncOrphan(engine, { kind: 'mirror_row', cursor_key: `${f.prefix}mirror`, run_id: null, source_id: f.id, source_incarnation: f.current, reason: 'mirror_only' })).rejects.toMatchObject({ code: 'ECONNRESET' });
  } finally { restore(); }
  expect(mirrors(f.prefix).sort()).toEqual([`${f.prefix}mirror`, `${f.prefix}old`, `${f.prefix}oldfail`]);
  expect(await keys(engine, 'managed-sync', f.prefix)).toEqual([`${f.prefix}old`]);

  // Archived: not classified; an approved set from before the archive is refused row by row (kept), nothing deleted.
  await engine.executeRaw('UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval \'72 hours\' WHERE id=$1', [f.id]);
  expect((await classifyManagedSyncOrphans(engine, null)).orphans.filter(orphan => orphan.source_id === f.id)).toEqual([]);
  for (const orphan of (await classifyManagedSyncOrphans(engine, null)).orphans) expect(orphan.source_id).not.toBe(f.id);
  const keptCursor = await retireManagedSyncOrphan(engine, { kind: 'unfinished_cursor', cursor_key: `${f.prefix}old`, run_id: `${f.prefix}run-old`, source_id: f.id, source_incarnation: f.old, reason: 'incarnation_retired' });
  expect(keptCursor).toEqual({ cursor: false, failure: false, manifest: false, mirror: false });
  expect(await keys(engine, 'managed-sync', f.prefix)).toEqual([`${f.prefix}old`]);
  expect(await keys(engine, 'managed-sync-failure', f.prefix).then(rows => rows.length)).toBe(2);
  await engine.executeRaw('UPDATE sources SET archived=false, archived_at=NULL, archive_expires_at=NULL WHERE id=$1', [f.id]);

  // Recreated: the source is removed and added again (a third incarnation); rows under both earlier incarnations are retired.
  await f.cursor(`${f.prefix}second`, f.current, { runId: `${f.prefix}run-second` });
  await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.id]);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [f.id]);
  const retired = (await classifyManagedSyncOrphans(engine, [f.id])).orphans;
  expect(retired.map(orphan => [orphan.cursor_key, orphan.reason]).sort()).toEqual([
    [`${f.prefix}mirror`, 'mirror_only'], [`${f.prefix}old`, 'incarnation_retired'], [`${f.prefix}oldfail`, 'incarnation_retired'], [`${f.prefix}second`, 'incarnation_retired']]);
  // A manifest another cursor still references survives the retirement of one of them.
  await f.cursor(`${f.prefix}twin`, f.old, { runId: `${f.prefix}run-old` });
  const twinRetired = await retireManagedSyncOrphan(engine, { kind: 'unfinished_cursor', cursor_key: `${f.prefix}old`, run_id: `${f.prefix}run-old`, source_id: f.id, source_incarnation: f.old, reason: 'incarnation_retired' });
  expect(twinRetired).toEqual({ cursor: true, failure: true, manifest: false, mirror: true });
  expect(await keys(engine, 'managed-sync-manifest', f.prefix)).toEqual([`${f.prefix}run-old`]);
  expect(mirrors(f.prefix).sort()).toEqual([`${f.prefix}mirror`, `${f.prefix}oldfail`]);
  // Preview/apply race: a row retired by another apply in between is reported kept, and the rest of the set still applies.
  const race = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec });
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE fingerprint=$1", [`${f.prefix}second`]);
  const raced = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: race.preview_hash, spec });
  expect(raced.applied).toBe(race.affected - 1);
  expect(raced.skipped).toBe(1);
  expect(await keys(engine, 'managed-sync', f.prefix)).toEqual([]);
  expect(await keys(engine, 'managed-sync-failure', f.prefix)).toEqual([]);
  expect(mirrors(f.prefix)).toEqual([]);
}), 120_000);
