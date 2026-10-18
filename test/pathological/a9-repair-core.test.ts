/**
 * GBRA-130 A-9: the repair core's per-item catch (src/core/repair/core.ts).
 *
 * Protects: one item whose apply throws anything item-scoped (a terminal
 * `storage_error`, `content_rejected`, a plain `Error`) is recorded in
 * failed[] with retry next_full_scan and a fix naming the kind's preview, and
 * the run goes on; a run-scoped failure (connection lost, 25P02, abort, a held
 * writer) still stops the run and records no failure; most items failing trips
 * item_failures_systemic; a limited run that ends with only item failures
 * clears its cursor so the next run is a full scan.
 * Fails when: the catch goes back to an allowlist (the run throws and the
 * stored cursor re-fails the same item on every rerun), or a run-scoped error
 * is recorded as one item's failure.
 * Why new: test/repair-apply-continue-6459.test.ts covers only the three
 * listed refusal codes with a store-only stub; this drives real pages on both
 * engines through the pathological harness.
 * Seams: none (a stub repair handler, as the registry accepts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { afterCursor, resolveRepairScope, runRepair, type RepairCursor, type RepairHandler, type RepairItem } from '../../src/core/repair/core.ts';
import type { RepairKindSpec } from '../../src/core/repair/registry.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const slugOf = (n: number) => `notes/p${n}`;

interface Stub { handler: RepairHandler; spec: RepairKindSpec; attempts: string[]; poison: Map<string, () => unknown>; recorded: Array<{ slug: string; code: string; class: string }> }

function stubKind(engine: BrainEngine): Stub {
  const stub = { attempts: [], poison: new Map(), recorded: [] } as unknown as Stub;
  stub.handler = {
    kind: 'timeline', publication: 'projection', embeds: false,
    async plan(_engine, scope, after: RepairCursor | null) {
      const rows = await engine.executeRaw<{ id: number; slug: string }>(
        "SELECT id, slug FROM pages WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND compiled_truth LIKE 'needs repair%' ORDER BY id", [scope.source_ids]);
      const items: RepairItem[] = rows.map(row => ({ cursor: { phase: 0, id: Number(row.id) }, source_id: SOURCE, slug: row.slug, chars: 10, action: 'repair' }));
      return { items: items.filter(item => afterCursor(item.cursor, after)), residuals: {} };
    },
    async apply(_ctx, item) {
      stub.attempts.push(item.slug);
      const poison = stub.poison.get(item.slug);
      if (poison) throw poison();
      await engine.putPage(item.slug, { type: 'note', title: item.slug, compiled_truth: `repaired ${item.slug}` }, { sourceId: SOURCE, allowEmptyOverwrite: true });
      return { applied: true, outcome: 'repaired' };
    },
    async onItemFailures(_ctx, failures) {
      for (const { item, failure } of failures) stub.recorded.push({ slug: item.slug, code: failure.code, class: failure.class });
    },
  } as RepairHandler;
  stub.spec = { kind: 'timeline', handler: stub.handler, summary: 'stub', embeds: 'none', checks: [], consent: 'safe' } as unknown as RepairKindSpec;
  return stub;
}

const ctxOf = (engine: BrainEngine) => ({ engine, sourceId: SOURCE, remote: false as const, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as never;

const ITEM_ERRORS: Array<{ name: string; error: () => unknown; code: string }> = [
  { name: 'terminal storage_error', error: () => new OperationError('storage_error', 'The write ended failed: publication refused the page.'), code: 'storage_error' },
  { name: 'content_rejected', error: () => new OperationError('content_rejected', 'The content sanity gate rejected the body.'), code: 'content_rejected' },
  { name: 'plain Error', error: () => new Error('boom: postgres://user:secret@db.example/brain'), code: 'internal' },
];

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-9 repair core: one bad item never stops the kind (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [SOURCE]);
      for (let n = 1; n <= 6; n++) await engine.putPage(slugOf(n), { type: 'note', title: slugOf(n), compiled_truth: `needs repair ${n}` }, { sourceId: SOURCE });
    });
    const cursorRows = () => engine.executeRaw<{ completed_keys: Array<{ cursor: RepairCursor | null }> }>("SELECT completed_keys FROM op_checkpoints WHERE op='repair'");
    const run = async (stub: Stub, opts: { limit?: number } = {}) => runRepair(ctxOf(engine), stub.handler, await resolveRepairScope(engine), { apply: true, spec: stub.spec, ...opts });

    for (const { name, error, code } of ITEM_ERRORS) {
      test(`item case: an item whose apply throws ${name} is recorded in failed[] and the healthy items are repaired`, async () => {
        const stub = stubKind(engine);
        stub.poison.set(slugOf(3), error);
        const before = await snapshotItems(engine, SOURCE);
        const result = await expectUnitNotAborted(() => run(stub));
        expect(stub.attempts).toEqual([1, 2, 3, 4, 5, 6].map(slugOf));
        expect(result).toMatchObject({ applied: 5, complete: true });
        expect(result.stopped).toBeUndefined();
        expect(result.failed.length).toBe(1);
        expectItemFailure({ ...result.failed[0]!, code: result.failed[0]!.reason }, { key: `${SOURCE}:${slugOf(3)}`, code, fix: /"gbrain","repair","timeline","--source","default"/ });
        expect(result.failed[0]!.retry).toBe('next_full_scan');
        expect(JSON.stringify(result)).not.toContain('secret');
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: [1, 2, 4, 5, 6].map(slugOf), progressFields: ['content_hash'] });
        expect(await cursorRows()).toEqual([]);
        expect(stub.recorded.map(r => r.slug)).toEqual([slugOf(3)]);
      });
    }

    test('recovery case: once the cause clears, the next full scan retries the failed item and it lands', async () => {
      const stub = stubKind(engine);
      stub.poison.set(slugOf(2), ITEM_ERRORS[2]!.error);
      await expectUnitNotAborted(() => run(stub));
      stub.poison.clear();
      stub.attempts.length = 0;
      const before = await snapshotItems(engine, SOURCE);
      const rerun = await expectUnitNotAborted(() => run(stub));
      expect(stub.attempts).toEqual([slugOf(2)]);
      expect(rerun).toMatchObject({ applied: 1, failed: [], complete: true, resumed_from: null });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: [slugOf(2)], progressFields: ['content_hash'] });
    });

    test('an accepted, still pending write stays a pending stop, never an item failure', async () => {
      const stub = stubKind(engine);
      stub.poison.set(slugOf(2), () => Object.assign(new OperationError('write_pending', 'accepted, pending publication'), { writeRequest: { request_id: 'req-pending-1', state: 'queued' } }));
      const result = await runRepair(ctxOf(engine), stub.handler, await resolveRepairScope(engine), { apply: true, spec: stub.spec,
        publicationOwner: async () => ({ alive: false, owner: 'none (test)' }) });
      expect(result.failed).toEqual([]);
      expect(result.stopped?.reason).toBe('write_pending');
      expect(result.pending).toEqual([{ item: `${SOURCE}:${slugOf(2)}`, request_id: 'req-pending-1' }]);
    });

    for (const { name, error } of runScopedErrors()) {
      test(`run case: a run-scoped ${name} at an item stops the run and records no failure`, async () => {
        const stub = stubKind(engine);
        const injected = error();
        stub.poison.set(slugOf(3), () => injected);
        let thrown: unknown;
        const result = await run(stub).catch(err => { thrown = err; return null; });
        expect(stub.attempts).toEqual([1, 2, 3].map(slugOf));
        if (result) {
          expect(result.stopped?.reason).toBe('owner_unavailable');
          expect(result.stopped?.message).toContain('gbrain sources writer status default');
          expect(result.failed).toEqual([]);
        } else expect(thrown).toBe(injected);
        const rows = await cursorRows();
        expect(rows.length).toBe(1);
        expect(rows[0]!.completed_keys[0]!.cursor?.id).toBeGreaterThan(0);
        expect(stub.recorded).toEqual([]);
      });
    }

    test('breaker case: when most items fail the run stops with item_failures_systemic and records nothing', async () => {
      const stub = stubKind(engine);
      for (let n = 1; n <= 6; n++) stub.poison.set(slugOf(n), () => new Error('the chunker is broken for every page'));
      const result = await expectUnitNotAborted(() => run(stub));
      expect(result.stopped?.reason).toBe('item_failures_systemic');
      expect(result.stopped?.message).toContain('repair.apply_items');
      expect(result.complete).toBe(false);
      expect(stub.recorded).toEqual([]);
      expect((await cursorRows()).length).toBe(1);
    });

    test('a limited run that ends with only item failures clears its cursor, so the next run is a full scan', async () => {
      const stub = stubKind(engine);
      stub.poison.set(slugOf(1), ITEM_ERRORS[2]!.error);
      stub.poison.set(slugOf(3), ITEM_ERRORS[0]!.error);
      const first = await expectUnitNotAborted(() => run(stub, { limit: 2 }));
      expect(first).toMatchObject({ applied: 1, complete: false });
      expect((await cursorRows())[0]!.completed_keys[0]!.cursor).toMatchObject({ id: expect.any(Number) });
      const second = await expectUnitNotAborted(() => run(stub, { limit: 1 }));
      expect(second.failed.map(f => f.slug)).toEqual([slugOf(3)]);
      expect(await cursorRows()).toEqual([]);
      stub.poison.clear();
      stub.attempts.length = 0;
      const full = await expectUnitNotAborted(() => run(stub));
      expect(full.resumed_from).toBeNull();
      expect(stub.attempts).toEqual([1, 3, 4, 5, 6].map(slugOf));
    });
  });
}
