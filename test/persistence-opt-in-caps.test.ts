/**
 * GBRA-108: gbrain's own receipt bookkeeping never refuses, pauses or throttles a write by default. The cumulative caps
 * (permanent request ids, reserved receipt bytes) are opt-in; housekeeping compacts settled receipts early while receipt
 * storage is above its target, never a failed or conflicted receipt whose intent a replay needs; doctor tells the brain
 * host's operator when storage stays above the target. Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { LAST_COMPACTION_KEY, runCompactionPass } from '../src/core/persistence/compaction-pass.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { __resetCapacityNoticesForTests, capacityNotices } from '../src/core/persistence/capacity-snapshot.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { RECEIPT_TARGET_KEY, readJournalLimits } from '../src/core/persistence/limits.ts';
import { manageReconcileBackups } from '../src/core/persistence/reconcile-backup.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { checkPersistenceCapacity } from '../src/commands/doctor/checks/persistence-capacity.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const OLD_DEFAULTS = { principal_lifetime_ids: 2_000_000, brain_lifetime_ids: 8_000_000, principal_terminal_bytes: 16 * 1024 ** 3, brain_terminal_bytes: 64 * 1024 ** 3 };

async function raw(engine: BrainEngine, sql: string, params: unknown[] = []) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
}
/** Elapsed time: every request and effect moves `days` into the past. */
const age = (engine: BrainEngine, days: number) => raw(engine, `UPDATE persistence_requests SET created_at=created_at-($1::double precision*interval '1 day'),
  completed_at=completed_at-($1::double precision*interval '1 day')`, [days]);
const settleEffects = (engine: BrainEngine) => raw(engine, "UPDATE persistence_effects SET state='committed',error_code=NULL WHERE state<>'committed'");
const receipts = (engine: BrainEngine) => engine.executeRaw<{ slug: string; state: string; compacted: boolean; has_intent: boolean; age_days: number }>(
  `SELECT slug,state,compacted,intent IS NOT NULL AND intent::text<>'null' AS has_intent,EXTRACT(EPOCH FROM now()-completed_at)::float8/86400 AS age_days
   FROM persistence_requests ORDER BY sequence`);
const brainBytes = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: string }>("SELECT terminal_bytes::text AS n FROM persistence_counters WHERE key='brain'"))[0]!.n);

for (const kind of testBackends()) {
  describe(`opt-in receipt caps ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-opt-in-caps-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 240_000);

    check('an unset cap is no cap: writes past the old defaults are admitted, background ones too, and nothing says to raise a limit', async engine => {
      const requests = await requestFixture(engine);
      await requests.admit('first');
      // Counters at the old default caps: before GBRA-108 the next write refused write_quota_exhausted (and background
      // writes paused at 80% with write_capacity_backpressure).
      await raw(engine, `UPDATE persistence_counters SET lifetime_ids=CASE WHEN key='brain' THEN $1::bigint ELSE $2::bigint END,
        terminal_bytes=CASE WHEN key='brain' THEN $3::bigint ELSE $4::bigint END WHERE key='brain' OR key LIKE 'principal:%'`,
        [OLD_DEFAULTS.brain_lifetime_ids, OLD_DEFAULTS.principal_lifetime_ids, OLD_DEFAULTS.brain_terminal_bytes, OLD_DEFAULTS.principal_terminal_bytes]);
      expect((await requests.admit('background')).slug).toBe('background');
      expect((await withAdmissionOrigin('interactive', () => requests.admit('interactive'))).slug).toBe('interactive');
      const limits = await readJournalLimits(engine);
      for (const key of ['principalLifetimeIds', 'brainLifetimeIds', 'principalTerminalBytes', 'brainTerminalBytes'] as const) expect(limits[key]).toBe(Infinity);
      await engine.setConfig(RECEIPT_TARGET_KEY, '0');
      const doctor = await checkPersistenceCapacity(engine);
      expect(doctor.status).toBe('ok');
      expect(doctor.details).toMatchObject({ resources: [], commands: [] });
      expect(JSON.stringify(doctor)).not.toContain('persistence.limits.');
      __resetCapacityNoticesForTests();
      expect(await capacityNotices(engine, { throttle: false, now: Date.now() + 10 * 60_000 })).toEqual([]);
    });

    check('a cap the operator sets is still enforced', async engine => {
      const requests = await requestFixture(engine);
      await requests.admit('a');
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1');
      expect(await withAdmissionOrigin('interactive', () => requests.admit('b')).then(() => null, error => error))
        .toMatchObject({ code: 'write_quota_exhausted', detail: 'principal_lifetime_ids' });
    });

    check('above the target, housekeeping compacts settled receipts and re-derivable producer refusals older than a week, and keeps every intent a replay or retry reads', async engine => {
      const requests = await requestFixture(engine);
      const slugs = ['old-committed', 'old-failed', 'old-conflict', 'old-maintenance-failed', 'old-sync-failed', 'old-facts-failed', 'old-job-committed', 'old-subagent-committed', 'young-committed'];
      for (const slug of slugs) await requests.publish(await requests.admit(slug));
      await settleEffects(engine);
      const [failed] = await engine.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE slug='old-failed'");
      const [conflict] = await engine.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE slug='old-conflict'");
      await editRequest(engine, failed!.id, "state='failed',error_code='example_failure'");
      await editRequest(engine, conflict!.id, "state='conflict',error_code='revision_conflict'");
      const id = async (slug: string) => (await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE slug=$1', [slug]))[0]!.id;
      // Refusals gbrain's own producers write again from current content: a maintenance page and a managed sync import.
      await editRequest(engine, await id('old-maintenance-failed'), `operation='submit_job',state='conflict',error_code='source_changed',intent=intent||'{"kind":"managed_maintenance_page"}'::jsonb`);
      await editRequest(engine, await id('old-sync-failed'), `state='failed',error_code='example_failure',intent=intent||'{"kind":"managed_sync_import"}'::jsonb`);
      // A producer that recovers from its refused intent (the frozen extraction), and a settled job whose intent later runs read.
      await editRequest(engine, await id('old-facts-failed'), `operation='submit_job',state='failed',error_code='example_failure',intent=intent||'{"kind":"managed_conversation_facts"}'::jsonb`);
      await editRequest(engine, await id('old-job-committed'), `operation='submit_job',intent=intent||'{"kind":"managed_atom_page"}'::jsonb`);
      // A subagent's own page write: a deferred synthesis postprocess compares its committed content with the page.
      await editRequest(engine, await id('old-subagent-committed'), `authority=authority||'{"restrictedNamespace":true}'::jsonb`);
      await age(engine, 10);
      await raw(engine, "UPDATE persistence_requests SET completed_at=now()-interval '2 days' WHERE slug='young-committed'");
      // Under the target (the default) nothing inside the 30-day retention is touched.
      await runCompactionPass(engine, { hostId: 'host-a' });
      expect((await receipts(engine)).filter(r => r.compacted)).toEqual([]);
      // An explicit retention is the operator's choice: housekeeping leaves it alone even above the target.
      await engine.setConfig(RECEIPT_TARGET_KEY, '1');
      await engine.setConfig('persistence.receipt_retention_days', '30');
      await runCompactionPass(engine, { hostId: 'host-a' });
      expect((await receipts(engine)).filter(r => r.compacted)).toEqual([]);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.receipt_retention_days'");
      const before = await brainBytes(engine);
      const pass = await runCompactionPass(engine, { hostId: 'host-a' });
      expect(pass).toMatchObject({ compacted: 3, early: 3 });
      expect(await brainBytes(engine)).toBeLessThan(before);
      const rows = Object.fromEntries((await receipts(engine)).map(r => [r.slug, r]));
      expect(rows['old-committed']).toMatchObject({ compacted: true });
      expect(rows['old-maintenance-failed']).toMatchObject({ compacted: true, has_intent: false });
      expect(rows['old-sync-failed']).toMatchObject({ compacted: true, has_intent: false });
      expect(rows['old-facts-failed']).toMatchObject({ compacted: false, has_intent: true });
      expect(rows['old-job-committed']).toMatchObject({ compacted: false, has_intent: true });
      expect(rows['old-subagent-committed']).toMatchObject({ compacted: false, has_intent: true });
      expect(rows['old-failed']).toMatchObject({ compacted: false, has_intent: true });
      expect(rows['old-conflict']).toMatchObject({ compacted: false, has_intent: true });
      expect(rows['young-committed']).toMatchObject({ compacted: false, has_intent: true });
    });

    check('the retention pass keeps a refused caller write that failed-writes can still replay until a later request resolves it', async engine => {
      const requests = await requestFixture(engine);
      for (const slug of ['drifted', 'guarded', 'resolved', 'other-failure', 'no-code-failure']) await requests.publish(await requests.admit(slug));
      await settleEffects(engine);
      const id = async (slug: string) => (await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE slug=$1 ORDER BY sequence LIMIT 1', [slug]))[0]!.id;
      // Refusals `gbrain repair failed-writes` replays: a file/database drift and a writer guard on a caller's own page write.
      await editRequest(engine, await id('drifted'), "state='conflict',error_code='source_changed'");
      await editRequest(engine, await id('guarded'), "state='failed',error_code='writer_coordinator_required'");
      await editRequest(engine, await id('resolved'), "state='conflict',error_code='source_changed'");
      // A refusal failed-writes does not replay.
      await editRequest(engine, await id('other-failure'), "state='failed',error_code='example_failure'");
      // A refusal with no recorded code is not one failed-writes replays either (the predicate is NULL, not true).
      await editRequest(engine, await id('no-code-failure'), "state='failed',error_code=NULL");
      await age(engine, 40);
      // A later committed write of the page resolves its refusal.
      const later = await requests.admit('resolved');
      await editRequest(engine, later.id, "state='committed',completed_at=now(),error_code=NULL");
      await settleEffects(engine);
      await engine.setConfig(RECEIPT_TARGET_KEY, '0');
      await runCompactionPass(engine, { hostId: 'host-a' });
      const rows = await receipts(engine);
      const first = (slug: string) => rows.find(r => r.slug === slug)!;
      expect(first('drifted')).toMatchObject({ compacted: false, has_intent: true });
      expect(first('guarded')).toMatchObject({ compacted: false, has_intent: true });
      expect(first('resolved')).toMatchObject({ compacted: true });
      expect(first('other-failure')).toMatchObject({ compacted: true });
      expect(first('no-code-failure')).toMatchObject({ compacted: true });
      // Explicitly dropping it stays the operator's call (gbrain repair receipt-compaction --include-failures).
    });

    check('a long synthetic run: storage above the target keeps a week of settled receipts, failed intents wait for the retention, writes never refuse', async engine => {
      const requests = await requestFixture(engine);
      await engine.setConfig(RECEIPT_TARGET_KEY, '1');
      const perDay = 3;
      let peak = 0;
      for (let day = 0; day < 40; day++) {
        for (let i = 0; i < perDay; i++) await requests.publish(await requests.admit(`d${day}-${i}`));
        await settleEffects(engine);
        if (day % 10 === 0) {
          const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE slug=$1', [`d${day}-0`]);
          await editRequest(engine, row!.id, "state='failed',error_code='example_failure'");
        }
        await age(engine, 1);
        await runCompactionPass(engine, { hostId: 'host-a' });
        const rows = await receipts(engine);
        const fat = rows.filter(r => r.state === 'committed' && !r.compacted);
        expect(Math.max(0, ...fat.map(r => r.age_days))).toBeLessThanOrEqual(7.01);
        peak = Math.max(peak, fat.length);
      }
      const rows = await receipts(engine);
      expect(rows).toHaveLength(40 * perDay);
      // Uncompacted settled receipts never pass a week of admissions, however long the run.
      expect(peak).toBeLessThanOrEqual(8 * perDay);
      // Housekeeping never takes a failed receipt early: it keeps its intent until the 30-day retention pass, as before.
      const failed = rows.filter(r => r.state === 'failed');
      expect(failed).toHaveLength(4);
      for (const row of failed) expect(row).toMatchObject(row.age_days > 30 ? { compacted: true } : { compacted: false, has_intent: true });
    });

    check('doctor warns the host operator, without blocking anything, while receipt storage stays above the target', async engine => {
      const requests = await requestFixture(engine);
      await requests.publish(await requests.admit('page'));
      expect((await checkPersistenceCapacity(engine)).status).toBe('ok');
      await engine.setConfig(RECEIPT_TARGET_KEY, '1');
      const warning = await checkPersistenceCapacity(engine);
      expect(warning.status).toBe('warn');
      expect(warning.message).toContain('Writes are not affected');
      expect(warning.message).toContain(RECEIPT_TARGET_KEY);
      expect(warning.message).not.toContain('persistence.limits.');
      expect(warning.fix).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'repair', 'receipt-compaction', '--json'] });
      expect(warning.details).toMatchObject({ housekeeping: { target_bytes: 1, over_target: true } });
    });

    check('compacted receipts alone above the target: housekeeping has nothing to take and doctor stays ok', async engine => {
      const requests = await requestFixture(engine);
      for (const slug of ['a', 'b', 'c']) await requests.publish(await requests.admit(slug));
      await settleEffects(engine);
      await age(engine, 40);
      await engine.setConfig(RECEIPT_TARGET_KEY, '0');
      await runCompactionPass(engine, { hostId: 'host-a' });
      expect((await receipts(engine)).every(r => r.compacted)).toBe(true);
      // What compacted receipts keep for idempotency never shrinks, so it alone passing the target is nothing to act on.
      expect(await brainBytes(engine)).toBeGreaterThan(1);
      await engine.setConfig(RECEIPT_TARGET_KEY, '1');
      const doctor = await checkPersistenceCapacity(engine);
      expect(doctor.status).toBe('ok');
      expect(doctor.details).toMatchObject({ housekeeping: { target_bytes: 1, compactable_bytes: 0, over_target: false } });
      expect(await runCompactionPass(engine, { hostId: 'host-a' })).toMatchObject({ compacted: 0 });
      // A new settled receipt is something housekeeping can act on again.
      await requests.publish(await requests.admit('d'));
      expect((await checkPersistenceCapacity(engine)).status).toBe('warn');
    });

    check('a housekeeping error still runs the reservation sweep and records the pass', async engine => {
      const requests = await requestFixture(engine);
      await requests.publish(await requests.admit('page'));
      await raw(engine, "INSERT INTO config (key,value) VALUES ($1,'not-a-number') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [RECEIPT_TARGET_KEY]);
      // Past the hourly record interval, so the pass records even though it compacted nothing.
      const pass = await runCompactionPass(engine, { hostId: 'host-a', now: Date.now() + 2 * 60 * 60_000 });
      expect(pass.skipped_by_reason).toMatchObject({ housekeeping_error: 1 });
      expect(JSON.parse((await engine.getConfig(LAST_COMPACTION_KEY))!)).toMatchObject({ host_id: 'host-a', skipped_by_reason: { housekeeping_error: 1 } });
    });

    check('writer status lists only the limits that are set, never an unset cap as null', async engine => {
      const listed = async () => JSON.parse(JSON.stringify((await readWriterDiagnostics(engine)).limits)) as Record<string, unknown>;
      const limits = await listed();
      expect(Object.values(limits).every(value => typeof value === 'number')).toBe(true);
      expect(limits).not.toHaveProperty('brainTerminalBytes');
      await engine.setConfig('persistence.limits.brain_terminal_bytes', '5000000');
      expect(await listed()).toMatchObject({ brainTerminalBytes: 5_000_000 });
    });

    check('the reconciliation backup listing names no count bound while the id cap is unset, and the cap once set', async engine => {
      const authority = { version: 1, principal: { kind: 'cli', id: 'opt-in-caps' }, remote: false, sourceId: 'default' } as unknown as WriteAuthority;
      const listing = async () => JSON.parse(JSON.stringify(await manageReconcileBackups(engine, authority, 'people/example', { action: 'list' })));
      expect((await listing()).capacity).toEqual({ max_retained_bytes: 1024 ** 3 });
      await engine.setConfig('persistence.limits.brain_lifetime_ids', '5000');
      expect((await listing()).capacity).toEqual({ max_retained_bytes: 1024 ** 3, max_retained_count: 5000 });
    });
  });
}
