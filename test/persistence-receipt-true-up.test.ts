/**
 * #6696 (A1): a finished receipt gives back the part of its admission
 * reservation it does not keep: at completion when it has no unfinished
 * effect (single and group paths), else when its last effect settles
 * (`trueUpRequests`, idempotent); a reservation covers the retained intent
 * (a ~100 KB body); a counter already below the delta clamps at zero and the
 * clamp is counted. Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { COMPACTED_SWEEP_KEY, sweepCompactedReservations, trueUpRequests } from '../src/core/persistence/receipt-true-up.ts';
import { completeGroup } from '../src/core/persistence/group-publish.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { EFFECT_BYTES_SQL, RECEIPT_RESERVATION_FLOOR, receiptReservation, retainedReceiptBytes, TRUE_UP_CLAMPED_KEY } from '../src/core/persistence/receipt-bytes.ts';
import { recordTopologyChange } from '../src/core/persistence/topology-receipts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const row = async (engine: BrainEngine, id: string) => (await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id]))[0]!;
const counters = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ key: string; terminal_bytes: string }>(
  "SELECT key,terminal_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%'")).map(c => [c.key, Number(c.terminal_bytes)]));
const reservations = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: string }>(
  'SELECT COALESCE(SUM(terminal_reservation),0)::text AS n FROM persistence_requests'))[0]!.n);
const formula = (r: WriteRequest, effects = 0) => retainedReceiptBytes(r, { stage: 'terminal', effects });
const effectBytes = async (engine: BrainEngine, id: string) => Number((await engine.executeRaw<{ n: string }>(
  `SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0)::text AS n FROM persistence_effects WHERE request_id=$1::uuid`, [id]))[0]!.n);
/** Runs the effect worker until none of the request's effects is queued or running (no embedding provider: those fail or skip). */
async function settleEffects(engine: BrainEngine, id: string) {
  for (let pass = 0; pass < 10; pass++) {
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND state='queued'", [id]);
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 20 });
    const [open] = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state IN ('queued','running')", [id]);
    if (!open) return;
  }
  throw new Error('effects did not settle');
}

for (const kind of testBackends()) {
  describe(`receipt true-up at completion ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-true-up-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('a single completion with no effects shrinks its reservation to the formula and releases the rest', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('refused');
      expect(Number(admitted.terminal_reservation)).toBe(RECEIPT_RESERVATION_FLOOR);
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'conflict', {}, { code: 'source_changed', message: 'the file moved' }));
      const done = await row(engine, admitted.id);
      expect(Number(done.terminal_reservation)).toBe(formula(done));
      expect(Number(done.terminal_reservation)).toBeLessThan(RECEIPT_RESERVATION_FLOOR);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
      expect(await reservations(engine)).toBe(Number(done.terminal_reservation));
    });

    check('an effectful page write keeps the floor until its last effect settles, then equals the formula', async engine => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('published'));
      const pending = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed'", [published.id]);
      expect(pending.length).toBeGreaterThan(0);
      expect(Number((await row(engine, published.id)).terminal_reservation)).toBe(RECEIPT_RESERVATION_FLOOR);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(RECEIPT_RESERVATION_FLOOR);
      // A true-up while an effect is still open changes nothing.
      expect(await trueUpRequests(engine, [published.id])).toBe(0);
      await settleEffects(engine, published.id);
      const done = await row(engine, published.id);
      expect(Number(done.terminal_reservation)).toBe(formula(done, await effectBytes(engine, published.id)));
      expect(Number(done.terminal_reservation)).toBeLessThan(RECEIPT_RESERVATION_FLOOR);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
      // Idempotent: a second call (another settle path reaching the same request) gives nothing back twice.
      expect(await trueUpRequests(engine, [published.id])).toBe(0);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
    });

    check('a ~100 KB page write reserves its retained intent, completes, and settles to the formula', async engine => {
      const requests = await requestFixture(engine);
      const slug = 'large';
      const body = 'x'.repeat(100_000);
      const authority = await submissionAuthority(requests.ctx, 'put_page', requests.sourceId, requests.incarnation, slug);
      const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: requests.sourceId,
        sourceIncarnation: requests.incarnation, slug, requestId: randomUUID(), callerIntent: { body }, intent: { body } });
      expect(Number(admitted.terminal_reservation)).toBe(receiptReservation({ intent: { body }, authority }));
      expect(Number(admitted.terminal_reservation)).toBeGreaterThan(100_000);
      const published = await requests.publish(admitted);
      expect(published.state).toBe('committed');
      await settleEffects(engine, published.id);
      const done = await row(engine, published.id);
      const kept = formula(done, await effectBytes(engine, published.id));
      expect(kept).toBeGreaterThan(100_000);
      expect(Number(admitted.terminal_reservation)).toBeGreaterThanOrEqual(kept);
      expect(Number(done.terminal_reservation)).toBe(kept);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(kept);
    });

    check('a three-member group completion trues up every member in one statement', async engine => {
      const requests = await requestFixture(engine);
      const admitted = [await requests.admit('g1'), await requests.admit('g2'), await requests.admit('g3')];
      // Claimed together, as claimGroupFollowers claims a lane group's members behind its head.
      const claimed = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        return tx.executeRaw<WriteRequest>(`UPDATE persistence_requests r SET state='running',execution_token=t.token,claim_expires_at=now()+interval '1 minute'
          FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token) WHERE r.id=t.id RETURNING r.*`, [admitted.map(a => a.id), admitted.map(() => randomUUID())]);
      });
      claimed.sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
      const outcomes = claimed.map(r => ({ slug: r.slug, status: 'created_or_updated' }));
      await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await completeGroup(tx, claimed, outcomes); });
      const done = await Promise.all(admitted.map(a => row(engine, a.id)));
      const sum = done.reduce((total, r) => total + Number(r.terminal_reservation), 0);
      for (const r of done) {
        expect(r.state).toBe('committed');
        expect(Number(r.terminal_reservation)).toBe(formula(r));
        expect(Number(r.terminal_reservation)).toBeLessThan(RECEIPT_RESERVATION_FLOOR);
      }
      for (const value of Object.values(await counters(engine))) expect(value).toBe(sum);
    });

    check('a counter already below the delta still commits, clamps at zero and counts the clamp', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('drifted');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=100 WHERE key='brain' OR key LIKE 'principal:%'");
      });
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'storage_error', message: 'generic failure' }));
      expect((await row(engine, admitted.id)).state).toBe('failed');
      for (const value of Object.values(await counters(engine))) expect(value).toBe(0);
      expect(await engine.getConfig(TRUE_UP_CLAMPED_KEY)).toBe('2');
    });

    check('a receipt redacted for purged content at completion shrinks to what it keeps', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit(`purged-${'x'.repeat(120)}`);
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'purged_content', message: 'the page carries content the owner purged' }));
      const done = await row(engine, admitted.id);
      expect(done).toMatchObject({ compacted: true, intent: null });
      expect(Number(done.terminal_reservation)).toBe(retainedReceiptBytes(done, { stage: 'terminal' }));
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
    });

    check('the one-shot sweep shrinks receipts compacted before this release with their full reservation, then stops', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('legacy-redacted');
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'storage_error', message: 'generic failure' }));
      // What an older release left: redacted and marked compacted, still charged the 16 KiB admission reservation.
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        const before = Number((await row(tx as BrainEngine, admitted.id)).terminal_reservation);
        await tx.executeRaw('UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid',
          [admitted.id, RECEIPT_RESERVATION_FLOOR]);
        await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes+$1 WHERE key='brain' OR key LIKE 'principal:%'", [RECEIPT_RESERVATION_FLOOR - before]);
      });
      for (const value of Object.values(await counters(engine))) expect(value).toBe(RECEIPT_RESERVATION_FLOOR);
      expect(await sweepCompactedReservations(engine, 10)).toMatchObject({ done: false });
      const done = await row(engine, admitted.id);
      expect(Number(done.terminal_reservation)).toBe(retainedReceiptBytes(done, { stage: 'compacted' }));
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
      expect(await sweepCompactedReservations(engine, 10)).toEqual({ freed_bytes: 0, done: true });
      expect(await engine.getConfig(COMPACTED_SWEEP_KEY)).toBe('done');
    });

    check('a lifecycle change recorded committed is charged its retained bytes, not 16 KiB', async engine => {
      const requests = await requestFixture(engine);
      const [writer] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_local_writers LIMIT 1');
      const change = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        return recordTopologyChange(tx, { principal: writer!.id, requestId: randomUUID(), intent: { op: 'example' }, operation: 'example',
          sourceId: requests.sourceId, incarnation: requests.incarnation, worktrees: [] }, { done: true });
      });
      expect(change.state).toBe('committed');
      expect(Number(change.terminal_bytes)).toBe(retainedReceiptBytes({ outcome: { done: true } }, { stage: 'terminal' }));
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(change.terminal_bytes));
    });
  });
}
