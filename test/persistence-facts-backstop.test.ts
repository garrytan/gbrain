import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect, publicEffectsForRequest } from '../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect, readFactsBackstopJobPage } from '../src/core/persistence/effect-facts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'A useful substantive record of this project and its current status. '.repeat(4)}`;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function fixture(run: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-effect-'));
  try { await withEnv({ GBRAIN_HOME: home }, async () => { await resetPgliteState(engine); await engine.setConfig('version', '156'); await registerLocalWriter(engine, 'cli'); await run(); }); }
  finally { rmSync(home, { force: true, recursive: true }); }
}
async function prepare(overrides: Partial<OperationContext> = {}, params: Record<string, unknown> = {}) {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} }, ...overrides };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/example');
  const intent = { content, ...params };
  const current = await engine.readPageSnapshot('notes/example', { sourceId: 'default' });
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: 'notes/example', pageId: current?.page.id ?? null, requestId: randomUUID(), callerIntent: intent, intent });
  const row = (await claimNextWrite(engine, localHostId()))!;
  return { row, prepared: await preparePageMutation(engine, row, config) };
}
async function publish() { const input = await prepare(); return publishMutation(engine, input.row, input.prepared); }
async function claimFacts(row: WriteRequest) {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
  const effect = (await claimPersistenceEffect(engine, localHostId()))!;
  expect(effect.request_id).toBe(row.id); expect(effect.kind).toBe('facts-backstop');
  return effect;
}
async function jobs() { return engine.executeRaw<{ id: number; data: Record<string, unknown>; idempotency_key: string }>("SELECT id,data,idempotency_key FROM minion_jobs WHERE name='facts-absorb'"); }

test('page receipt and bounded extraction debt commit together; durable handoff rolls back and replays once', () => fixture(async () => {
  const row = await publish(); expect(row.outcome?.facts_backstop).toEqual({ queued: true });
  expect(await jobs()).toHaveLength(0);
  const effect = await claimFacts(row);
  await expect(engine.transaction(async tx => {
    await dispatchFactsBackstopEffect(tx, effect, localHostId());
    throw new Error('transaction aborted after job insert');
  })).rejects.toThrow('transaction aborted');
  expect(await jobs()).toHaveLength(0);
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  // The first ACK may be lost; a stale execution token cannot insert again.
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const work = await jobs(); expect(work).toHaveLength(1);
  expect(work[0].idempotency_key).toBe(`facts-absorb:write:${row.id}`);
  expect(work[0].data).toMatchObject({ persistence_request_id: row.id, visibility: 'private', sourceId: 'default' });
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'facts-backstop')).toEqual({ kind: 'facts-backstop', state: 'dispatched' });
  expect('page' in await readFactsBackstopJobPage(engine, work[0].data)).toBe(true);
  const current = (await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }))!;
  const noop = await prepare({}, { expected_revision: current.revision });
  const unchanged = await publishMutation(engine, noop.row, noop.prepared);
  expect(unchanged.outcome?.facts_backstop).toEqual({ skipped: 'not_imported' });
  expect(await publicEffectsForRequest(engine, unchanged.id)).toEqual([]);
  expect((await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }))?.revision).toBe(current.revision);
}));

test('activation between preparation and publication retains durable coordinated extraction debt', () => fixture(async () => {
  const input = await prepare();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const row = await publishMutation(engine, input.row, input.prepared);
  expect(row.state).toBe('committed');
  expect(row.outcome?.facts_backstop).toEqual({ queued: true });
  expect((await publicEffectsForRequest(engine, row.id)).some(effect => effect.kind === 'facts-backstop')).toBe(true);
  expect(await jobs()).toHaveLength(0);
}));

test('activation after publication dispatches coordinated extraction without changing the committed canonical receipt', () => fixture(async () => {
  const row = await publish(); const effect = await claimFacts(row);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  expect(await jobs()).toHaveLength(1);
  expect((await getWriteRequestById(engine, row.id))?.outcome).toEqual(row.outcome);
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'facts-backstop')).toEqual({ kind: 'facts-backstop', state: 'dispatched' });
  expect('page' in await readFactsBackstopJobPage(engine, (await jobs())[0].data)).toBe(true);
}));

test('a superseded page cannot enqueue extraction from an obsolete receipt', () => fixture(async () => {
  const row = await publish(); const effect = await claimFacts(row);
  const snapshot = (await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }))!;
  await engine.putPage(row.slug, { ...snapshot.page, compiled_truth: 'Changed by a later writer' }, { sourceId: row.source_id });
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  expect(await jobs()).toHaveLength(0);
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'facts-backstop')).toMatchObject({ state: 'skipped', reason: 'superseded' });
}));

test('durable job execution rechecks revocation, grant narrowing, page revision and activation', () => fixture(async () => {
  const row = await publish(); await dispatchFactsBackstopEffect(engine, await claimFacts(row), localHostId());
  const data = (await jobs())[0].data;
  await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [row.principal_id]);
  expect(await readFactsBackstopJobPage(engine, data)).toEqual({ skipped: 'permission_denied' });
  await engine.executeRaw("UPDATE persistence_local_writers SET revoked_at=NULL,grant_ceiling=jsonb_set(grant_ceiling,'{slugPrefixes}','[\"notes/\"]'::jsonb) WHERE id=$1::uuid", [row.principal_id]);
  expect(await readFactsBackstopJobPage(engine, data)).toEqual({ skipped: 'permission_denied' });
  await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{slugPrefixes}','null'::jsonb) WHERE id=$1::uuid", [row.principal_id]);
  const snapshot = (await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }))!;
  await engine.putPage(row.slug, { ...snapshot.page, compiled_truth: 'Changed after handoff' }, { sourceId: row.source_id });
  expect(await readFactsBackstopJobPage(engine, data)).toEqual({ skipped: 'superseded' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await readFactsBackstopJobPage(engine, data)).toEqual({ skipped: 'superseded' });
}));

test('confined writers and disabled extraction never receive a queued claim', () => fixture(async () => {
  const input = await prepare({ viaSubagent: true, allowedSlugPrefixes: ['notes/*'] });
  const row = await publishMutation(engine, input.row, input.prepared);
  expect(row.outcome?.facts_backstop).toEqual({ skipped: 'slug_bound_client' });
  expect((await publicEffectsForRequest(engine, row.id)).some(effect => effect.kind === 'facts-backstop')).toBe(false);
  await engine.setConfig('facts.extraction_enabled', 'false');
  const current = (await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }))!;
  const updated = await prepare({}, { content: `${content}\nAdditional content`, expected_revision: current.revision });
  const disabled = await publishMutation(engine, updated.row, updated.prepared);
  expect(disabled.outcome?.facts_backstop).toEqual({ skipped: 'extraction_disabled' });
}));
