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
import { authorizeFactsBackstop, dispatchFactsBackstopEffect, readFactsBackstopJobPage } from '../src/core/persistence/effect-facts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
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
  const current = await engine.readPageSnapshot('notes/example', { sourceId: 'default', includeDeleted: true });
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

// #6042: a rewrite that keeps compiled_truth (the only text the extractor reads) of an extracted page.
const retitled = (title: string) => content.replace('title: Field notes', `title: ${title}`);
const withTimeline = (body: string) => `${body}\n\n--- timeline ---\n\n- **2026-08-02** | A synthetic dated event.\n`;

/** Hands every pending facts effect to its job, then records the jobs as finished: no extraction of the page is pending. */
async function finishExtractions() {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at = now() + interval '1 hour' WHERE kind <> 'facts-backstop'");
  for (;;) {
    const effect = await claimPersistenceEffect(engine, localHostId());
    if (!effect) break;
    await dispatchFactsBackstopEffect(engine, effect, localHostId());
  }
  await engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE name = 'facts-absorb'");
}
/** Publishes `body` against the page's current revision, deleted pages included. */
async function rewrite(body: string) {
  const before = (await engine.readPageSnapshot('notes/example', { sourceId: 'default', includeDeleted: true }))!;
  const input = await prepare({}, { content: body, expected_revision: before.revision });
  const row = await publishMutation(engine, input.row, input.prepared);
  expect(row.state).toBe('committed');
  const effectQueued = (await publicEffectsForRequest(engine, row.id)).some(effect => effect.kind === 'facts-backstop');
  return { status: row.outcome?.facts_backstop, effectQueued };
}

test('#6042: title-only and timeline-only rewrites of an extracted page record body_unchanged and queue no effect', () => fixture(async () => {
  expect((await publish()).outcome?.facts_backstop).toEqual({ queued: true });
  await finishExtractions();
  expect(await rewrite(retitled('Renamed once'))).toEqual({ status: { skipped: 'body_unchanged' }, effectQueued: false });
  expect(await rewrite(withTimeline(retitled('Renamed once')))).toEqual({ status: { skipped: 'body_unchanged' }, effectQueued: false });
  expect(await jobs()).toHaveLength(1);
}));

test('#6042 control: a rewrite that changes compiled_truth still queues extraction', () => fixture(async () => {
  await publish();
  await finishExtractions();
  expect(await rewrite(`${content}A further substantive sentence about the project schedule.\n`)).toEqual({ status: { queued: true }, effectQueued: true });
}));

test('#6042: an extraction still in the outbox is superseded by the rewrite, so the rewrite queues in its place', () => fixture(async () => {
  await publish();
  expect(await rewrite(retitled('Renamed before extraction'))).toEqual({ status: { queued: true }, effectQueued: true });
}));

test.each(['waiting', 'delayed', 'paused', 'waiting-children', 'active'])('#6042: a facts-absorb job that is %s still counts as pending', (status) => fixture(async () => {
  await publish();
  await finishExtractions();
  // A move to active is a claim, which the queue protocol trigger requires to advance claim_generation.
  await engine.executeRaw(`UPDATE minion_jobs SET status = $1::text,
    claim_generation = claim_generation + CASE WHEN $1::text = 'active' THEN 1 ELSE 0 END WHERE name = 'facts-absorb'`, [status]);
  expect(await rewrite(retitled('Renamed during the job'))).toEqual({ status: { queued: true }, effectQueued: true });
}));

test.each(['completed', 'failed', 'dead', 'cancelled'])('#6042: on an extracted page, a later facts-absorb job that is %s no longer blocks the skip', (status) => fixture(async () => {
  await publish();
  await finishExtractions();
  const { page } = (await engine.readPageSnapshot('notes/example', { sourceId: 'default' }))!;
  const later = await new MinionQueue(engine).add('facts-absorb', { slug: 'notes/example', sourceId: 'default', page_id: page.id }, { queue: 'default' });
  await engine.executeRaw('UPDATE minion_jobs SET status = $1 WHERE id = $2', [status, later.id]);
  expect((await rewrite(retitled('Renamed after the job'))).status).toEqual({ skipped: 'body_unchanged' });
}));

test('#6042: only an extraction bound to this page row blocks the skip, not one for the same slug elsewhere', () => fixture(async () => {
  await publish();
  await finishExtractions();
  const { page } = (await engine.readPageSnapshot('notes/example', { sourceId: 'default' }))!;
  await new MinionQueue(engine).add('facts-absorb', { slug: 'notes/example', sourceId: 'elsewhere', page_id: page.id + 1000 }, { queue: 'default' });
  expect((await rewrite(retitled('Renamed beside a foreign job'))).status).toEqual({ skipped: 'body_unchanged' });
}));

test('#6042: a page that was ineligible before the write is offered when it becomes eligible with the same body', () => fixture(async () => {
  await publish();
  await finishExtractions();
  const asConcept = content.replace('type: note', 'type: concept');
  expect((await rewrite(asConcept)).status).toEqual({ skipped: 'kind:concept' });
  expect(await rewrite(content)).toEqual({ status: { queued: true }, effectQueued: true });
}));

test('#6042: rewriting a soft-deleted page with its old body queues extraction again', () => fixture(async () => {
  await publish();
  await finishExtractions();
  await engine.softDeletePage('notes/example', { sourceId: 'default' });
  expect(await rewrite(content)).toEqual({ status: { queued: true }, effectQueued: true });
}));

test('#6071: a body-preserving rewrite of an extracted page queues no extraction', () => fixture(async () => {
  await publish();
  await finishExtractions();
  const before = (await jobs()).length;
  expect(await rewrite(retitled('Renamed after extraction'))).toEqual({ status: { skipped: 'body_unchanged' }, effectQueued: false });
  expect(await jobs()).toHaveLength(before);
}));

test('#6071: a body-preserving rewrite of a never-extracted eligible page still queues extraction', () => fixture(async () => {
  await engine.setConfig('facts.extraction_enabled', 'false');
  expect((await publish()).outcome?.facts_backstop).toEqual({ skipped: 'extraction_disabled' });
  await engine.setConfig('facts.extraction_enabled', 'true');
  expect(await rewrite(retitled('Renamed after enabling'))).toEqual({ status: { queued: true }, effectQueued: true });
}));

test('#6071: an extraction that did not complete does not count as extracted', () => fixture(async () => {
  await publish();
  await finishExtractions();
  await engine.executeRaw("UPDATE minion_jobs SET status = 'failed' WHERE name = 'facts-absorb'");
  expect(await rewrite(retitled('Renamed after a failed extraction'))).toEqual({ status: { queued: true }, effectQueued: true });
}));

test('a slug-bound writer\'s backstop refusal says the page was written and who widens the grant', async () => {
  const row = { slug: 'notes/a', authority: { slugPrefixes: ['notes/'] } } as unknown as WriteRequest;
  await expect(authorizeFactsBackstop(engine, row)).rejects.toMatchObject({ code: 'permission_denied',
    suggestion: expect.stringContaining('the page itself is written') });
});

test.each([
  [null, 'all'], ['medium-and-up', 'medium-and-up'], ['high-only', 'high-only'], ['all', 'all'], ['  Medium-And-Up ', 'medium-and-up'], ['low', 'all'],
])('#6231: facts.page_write_notability_filter=%p queues the page-write extraction with %p', (setting, expected) => fixture(async () => {
  const row = await publish();
  const effect = await claimFacts(row);
  // Read at dispatch, after the claim: a change before the job is queued still applies.
  if (setting !== null) await engine.setConfig('facts.page_write_notability_filter', setting);
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const work = await jobs();
  expect(work).toHaveLength(1);
  expect(work[0].data.notabilityFilter).toBe(expected);
}));

test('#6232: a page that sets facts_backstop: false queues no extraction, and removing the line queues it with the same body', () => fixture(async () => {
  await publish();
  await finishExtractions();
  const optedOut = content.replace('title: Field notes', 'title: Field notes\nfacts_backstop: false');
  expect(await rewrite(optedOut)).toEqual({ status: { skipped: 'opted_out' }, effectQueued: false });
  expect(await rewrite(content)).toEqual({ status: { queued: true }, effectQueued: true });
}));
