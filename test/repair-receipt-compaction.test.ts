/**
 * #6696 (A9): `gbrain repair receipt-compaction` compacts terminal receipts on
 * demand. `--older-than` is floored at the configured retention unless
 * `--force` (retention 90 days: a 30-day request is refused, and the refusal's
 * fix is the preview at the floor); failures stay unless
 * `--include-failures`; a receipt of a run whose sync cursor is open is never
 * compacted. Refusal -> preview -> apply -> verify through the fix objects; an
 * interrupted apply resumes; an admission racing the apply waits under 1 s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';
import { parseOlderThanHours } from '../src/core/repair/receipt-compaction.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;

test('flags parse with the purge-deleted duration grammar and belong to receipt-compaction only', () => {
  expect(parseRepairArgs(['receipt-compaction', '--older-than', '90d', '--include-failures', '--force'])).toMatchObject({ kind: 'receipt-compaction', olderThan: '90d', includeFailures: true, force: true });
  expect(() => parseRepairArgs(['receipt-compaction', '--older-than', '3w'])).toThrow(/hours \(72 or 72h\) or days \(30d\)/);
  expect(() => parseRepairArgs(['timeline', '--older-than', '30d'])).toThrow(/applies only to gbrain repair receipt-compaction/);
  expect([parseOlderThanHours('72'), parseOlderThanHours('72h'), parseOlderThanHours('30d'), parseOlderThanHours('x')]).toEqual([72, 72, 720, null]);
  expect(repairSpec('receipt-compaction')).toMatchObject({ explicit_only: true, preview_bound: true, consent: 'destructive' });
  expect(repairSpec('receipt-compaction').handler.publication).toBe('projection');
});

for (const kind of testBackends()) {
  describe(`receipt-compaction repair ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-receipt-compaction-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });

    test('refusal -> preview -> apply -> verify; failures and open sync runs kept; an interrupted apply resumes', () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine: BrainEngine = await factory.fresh();
      const requests = await requestFixture(engine);
      const terminal = async (slug: string, state: 'committed' | 'failed', days: number, intent?: Record<string, unknown>) => {
        const row = await requests.admit(slug);
        await editRequest(engine, row.id, `state=$2,completed_at=now()-($3::double precision*interval '1 day'),published_at=now(),claim_expires_at=NULL
          ${state === 'failed' ? ",error_code='source_changed',error_message='the file moved'" : ''}${intent ? ',intent=$4::text::jsonb' : ''}`,
        [state, days, ...(intent ? [JSON.stringify(intent)] : [])]);
        await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [row.id]);
        return row.id;
      };
      const old = await terminal('old', 'committed', 100);
      const month = await terminal('month', 'committed', 40);
      const failed = await terminal('failed', 'failed', 100);
      const open = await terminal('open-run', 'committed', 100, { kind: 'managed_sync_import', runId: 'run-open-example', content: 'x' });
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync','cursor-example',$1::text::jsonb)`,
        [JSON.stringify([{ runId: 'run-open-example', done: false }])]);
      await engine.setConfig('persistence.receipt_retention_days', '90');
      const row = async (id: string) => (await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id]))[0]!;
      const bytes = async () => Number((await engine.executeRaw<{ n: string }>("SELECT terminal_bytes::text AS n FROM persistence_counters WHERE key='brain'"))[0]!.n);
      const scope = await resolveRepairScope(engine, undefined);
      const run = (apply: boolean, args: { olderThan?: string; force?: boolean; includeFailures?: boolean; expect?: string; limit?: number }) =>
        repairRunner(engine, { apply }).then(runner => runner.run('receipt-compaction', scope, { explicit: true, ...args }));

      // 30 days inside a 90-day retention: refused, and the fix is the preview at the floor.
      const refusal = await run(false, { olderThan: '30d' }).then(() => null, error => error);
      expect(refusal).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'repair', 'receipt-compaction', '--older-than', '90d', '--json'] } });
      const floor = await run(false, { olderThan: refusal.fix.argv[4] });
      expect(floor).toMatchObject({ affected: 1, residuals: { failures_kept: 1 }, cost: { lifetime_ids: 0, receipt_bytes: 0 } });
      expect(floor.sample).toEqual([`${requests.sourceId}:receipt:${(await row(old)).request_id}`]);
      expect((await run(false, { olderThan: '90d', includeFailures: true })).affected).toBe(2);

      // --force reaches inside the window; the apply is bound to the preview and resumes after an interruption.
      const preview = await run(false, { olderThan: '30d', force: true });
      expect(preview.affected).toBe(2);
      expect(preview.apply_command).toBe(`gbrain repair receipt-compaction --older-than 30d --force --apply --expect ${preview.preview_hash} --yes`);
      const before = await bytes();
      const reserved = Number((await row(old)).terminal_reservation) + Number((await row(month)).terminal_reservation);
      const first = await run(true, { olderThan: '30d', force: true, expect: preview.preview_hash, limit: 1 });
      expect(first).toMatchObject({ applied: 1, complete: false });
      const second = await run(true, { olderThan: '30d', force: true, expect: preview.preview_hash });
      expect(second).toMatchObject({ applied: 1, outcomes: { compacted: 1 } });
      expect(second.resumed_from).not.toBeNull();
      for (const id of [old, month]) expect(await row(id)).toMatchObject({ compacted: true, intent: null });
      for (const id of [failed, open]) expect((await row(id)).compacted).toBe(false);
      const kept = Number((await row(old)).terminal_reservation) + Number((await row(month)).terminal_reservation);
      expect(kept).toBeLessThan(reserved);
      expect(before - await bytes()).toBe(reserved - kept);
      // Verify: the same preview now finds nothing.
      expect((await run(false, { olderThan: '30d', force: true })).affected).toBe(0);
      // The open run's cursor finishes: its receipt becomes compactable.
      await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$1::text::jsonb WHERE op='managed-sync' AND fingerprint='cursor-example'",
        [JSON.stringify([{ runId: 'run-open-example', done: true }])]);
      expect((await run(false, { olderThan: '90d' })).affected).toBe(1);
    }), 120_000);

    test('an admission racing the apply waits under a second', () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine: BrainEngine = await factory.fresh();
      const requests = await requestFixture(engine);
      for (let i = 0; i < 40; i++) {
        const row = await requests.admit(`bulk-${i}`);
        await editRequest(engine, row.id, "state='committed',completed_at=now()-interval '60 days',published_at=now(),claim_expires_at=NULL");
        await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [row.id]);
      }
      const scope = await resolveRepairScope(engine, undefined);
      const preview = await (await repairRunner(engine, { apply: false })).run('receipt-compaction', scope, { explicit: true });
      expect(preview.affected).toBe(40);
      const apply = (await repairRunner(engine, { apply: true })).run('receipt-compaction', scope, { explicit: true, expect: preview.preview_hash });
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await requests.admit(`racing-${i}`);
        latencies.push(performance.now() - started);
      }
      expect((await apply).applied).toBe(40);
      expect(Math.max(...latencies)).toBeLessThan(1000);
    }), 120_000);
  });
}
