/**
 * #5459: managed sync bookkeeping nothing current can resume or clear.
 *
 * The classifier names the orphans doctor used to report forever (a failure
 * row with no cursor under its key, an unfinished cursor recorded by a
 * principal that is no longer an active local writer, a pre-options cursor a
 * later run superseded) and keeps what the loop still owns (a live pending
 * request, a cursor the live writer can resume). Doctor's `sync_failures`
 * names the repair for the orphans instead of a retry that never clears.
 * `gbrain repair managed-sync-orphans` is explicit-only and preview-bound and
 * retires exactly the previewed set, atomically, leaving the kept rows alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { classifyManagedSyncOrphans } from '../src/core/persistence/managed-sync-orphans.ts';
import { recordManagedSyncFailure, readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { managedSyncOrphansRepair } from '../src/core/repair/managed-sync-orphans.ts';
import { REPAIR_KINDS, runRepair } from '../src/core/repair/core.ts';
import { repairSpec, PREVIEW_BOUND_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
const SOURCE = 'orphans-src';
let incarnation: string;
let liveWriterId: string;
const ctx = () => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false } as unknown as OperationContext);

const cursor = (key: string, body: Record<string, unknown>, done = false) => engine.executeRaw(
  "INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)",
  [key, JSON.stringify([{ sourceId: SOURCE, incarnation, index: 0, target: 'abc', ...(done ? { done: true } : {}), ...body }])]);
const principal = (kind: string, id: string) => ({ authority: { writer: { principal: { kind, id } } } });
const keys = async (op: string) => (await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 ORDER BY fingerprint', [op])).map(row => row.fingerprint);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-sync-orphans-'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host' }, async () => { await registerLocalWriter(engine, 'cli'); liveWriterId = (await readLocalWriter(engine, 'cli'))!.id; });
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [SOURCE]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the kind is registered explicit-only and preview-bound, clearing sync_failures', () => {
  expect(REPAIR_KINDS).toContain('managed-sync-orphans');
  expect(repairSpec('managed-sync-orphans')).toMatchObject({ explicit_only: true, preview_bound: true, embeds: 'none', checks: ['sync_failures'] });
  expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('managed-sync-orphans');
  expect(PREVIEW_BOUND_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('managed-sync-orphans');
});

test('orphans are classified by what nothing current can do, doctor names the repair, and the apply retires exactly the previewed set', () => withEnv({ GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host' }, async () => {
  // (1) unfinished legacy_token cursor: its pending request is invisible to the live writer (not_found) → principal_unadoptable.
  await cursor('ck-legacy', { runId: 'run-legacy', pending: { requestId: randomUUID() }, syncOptions: { full: false }, ...principal('legacy_token', 'tok') });
  await recordManagedSyncFailure(engine, { source_id: SOURCE, source_incarnation: incarnation, path: '2026-08-08.md', code: 'sync_incomplete', message: 'cursor unfinished',
    request_id: null, run_id: 'run-legacy', target: 'abc', cursor_key: 'ck-legacy', phase: 'resume', state: 'unfinished', observation_id: 'run-legacy:0' });
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest','run-legacy','[{\"path\":\"2026-08-08.md\"}]'::jsonb)");
  // (2) unfinished cursor of the live writer with recorded options → resumable, kept.
  await cursor('ck-live', { runId: 'run-live', syncOptions: { full: false }, ...principal('local_cli', liveWriterId) });
  // (3) pre-options cursor of the live writer, superseded by a later completed run → superseded.
  await cursor('ck-old', { runId: 'run-old', ...principal('local_cli', liveWriterId) });
  await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '2 days' WHERE fingerprint='ck-old'");
  await cursor('ck-done', { runId: 'run-done', syncOptions: { full: false }, ...principal('local_cli', liveWriterId) }, true);
  // (4) legacy cursor whose pending request is still queued → kept, the loop owns it.
  const busyRequest = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,state)
    VALUES('legacy_token','tok',$1::uuid,'put_page',$2,$3::uuid,'busy','d','{}'::jsonb,0,0,'queued')`, [busyRequest, SOURCE, incarnation]);
  await cursor('ck-busy', { runId: 'run-busy', pending: { requestId: busyRequest }, syncOptions: { full: false }, ...principal('legacy_token', 'tok') });
  // (5) failure row with no cursor under its key → no_cursor.
  await recordManagedSyncFailure(engine, { source_id: SOURCE, source_incarnation: incarnation, path: 'twin.md', code: 'page_identity_changed', message: 'sync_origin_mismatch',
    request_id: null, run_id: 'run-twin', target: 'abc', cursor_key: 'ck-fail-orphan', phase: 'discovery', state: 'failed', observation_id: 'run-twin:0' });

  const before = await classifyManagedSyncOrphans(engine, [SOURCE]);
  expect(before.orphans.map(orphan => [orphan.kind, orphan.cursor_key, orphan.reason]).sort()).toEqual([
    ['failure_row', 'ck-fail-orphan', 'no_cursor'], ['unfinished_cursor', 'ck-legacy', 'principal_unadoptable'], ['unfinished_cursor', 'ck-old', 'superseded']]);
  expect(before.retained.map(row => [row.cursor_key, row.why]).sort()).toEqual([['ck-busy', 'pending_request_live'], ['ck-live', 'resumable']]);
  expect(before.orphans.find(orphan => orphan.cursor_key === 'ck-legacy')).toMatchObject({ principal: { kind: 'legacy_token', id: 'tok' }, pending_state: null, run_id: 'run-legacy' });

  // Doctor still counts every unfinished cursor, and now says which ones no sync can reach and what retires them.
  const check = (await checkSyncFailures(engine, { remote: false, sourceIds: [SOURCE] }))!;
  expect(check.status).not.toBe('ok');
  expect(check.message).toContain('3 of these');
  expect(check.message).toContain('cannot be resumed or cleared by any sync');
  expect(check.message).toContain(`gbrain repair managed-sync-orphans --source ${SOURCE}`);
  expect(check.message).toContain('ck-legacy'.slice(0, 12) + ' principal_unadoptable');
  expect(check.message).toContain('--retry-failed');
  expect((check.details as { orphans: unknown[] }).orphans).toHaveLength(3);
  const remote = (await checkSyncFailures(engine, { remote: true, sourceIds: [SOURCE] }))!;
  expect(remote.message).not.toContain('ck-legacy');

  // Preview: the plan lists the three with their class and prints a hash; the kept rows are residuals.
  const scope = { brain_id: 'host', source_ids: [SOURCE] };
  const preview = await runRepair(ctx(), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec: repairSpec('managed-sync-orphans') });
  expect(preview.affected).toBe(3);
  expect(preview.preview_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.residuals).toEqual({ pending_request_live: 1, resumable: 1 });
  expect(preview.apply_command).toContain(`--apply --expect ${preview.preview_hash}`);
  // Apply without the hash, or with a stale one, is refused and changes nothing.
  await expect(runRepair(ctx(), managedSyncOrphansRepair, scope, { apply: true, explicit: true, spec: repairSpec('managed-sync-orphans') })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runRepair(ctx(), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: 'f'.repeat(64), spec: repairSpec('managed-sync-orphans') })).rejects.toMatchObject({ code: 'preview_changed' });
  expect(await keys('managed-sync')).toEqual(['ck-busy', 'ck-done', 'ck-legacy', 'ck-live', 'ck-old']);

  const applied = await runRepair(ctx(), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash, spec: repairSpec('managed-sync-orphans') });
  expect(applied.applied).toBe(3);
  expect(await keys('managed-sync')).toEqual(['ck-busy', 'ck-done', 'ck-live']);
  expect(await keys('managed-sync-failure')).toEqual([]);
  expect(await keys('managed-sync-manifest')).toEqual([]);
  const after = await classifyManagedSyncOrphans(engine, [SOURCE]);
  expect(after.orphans).toEqual([]);
  expect(after.retained.map(row => row.cursor_key).sort()).toEqual(['ck-busy', 'ck-live']);
  expect((await readManagedSyncFailures(engine, [SOURCE])).map(row => row.cursor_key).sort()).toEqual(['ck-busy', 'ck-live']);
  // A second preview finds nothing; its apply command still binds to "nothing to do".
  const again = await runRepair(ctx(), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec: repairSpec('managed-sync-orphans') });
  expect(again.affected).toBe(0);
}), 60_000);
