import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  beginSourceIngestionReceipt, discardSourceIngestionReceipt, getSourceIngestionReceipt,
  linkSourceIngestionCheckpoints, pruneSourceIngestionReceipts, readSourceIngestionState,
  recordSourceIngestionOutcome, transitionSourceIngestionReceipt,
  type BeginSourceIngestionReceiptInput, type SourceIngestionCheckpoint, type SourceIngestionFence,
  type SourceIngestionMutation, type SourceIngestionReceipt,
} from '../../src/core/company-brain/receipts.ts';
import { SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL } from '../../src/core/company-brain/receipt-schema.ts';
import { appendCompleted, clearOpCheckpoint, loadOpCheckpoint, purgeStaleCheckpoints } from '../../src/core/op-checkpoint.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';

export function sourceIngestionReceiptTests(label: string, getEngine: () => BrainEngine): void {
  describe(label, () => {
    let engine: BrainEngine;
    let input: BeginSourceIngestionReceiptInput;
    let checkpoints: SourceIngestionCheckpoint[];
    let worktreeId: string | undefined;
    beforeAll(() => { engine = getEngine(); });
    beforeEach(async () => {
      const sourceId = `receipt-${randomUUID().slice(0, 8)}`;
      const incarnation = randomUUID();
      await engine.executeRaw('INSERT INTO sources(id,name,incarnation) VALUES ($1,$1,$2::uuid)', [sourceId, incarnation]);
      input = { id: randomUUID(), sourceId, sourceIncarnation: incarnation, approvedRevision: 'a'.repeat(40), profile: 'company',
        schemaFingerprint: 'b'.repeat(64), policyFingerprint: 'c'.repeat(64), extractorVersion: '1', lifecycleRequestIds: [randomUUID()], fence: { mode: 'unmanaged' } };
      checkpoints = ['content', 'manifest', 'managed_cursor'].map(kind => ({ op: `fixture-${kind}`, fingerprint: input.id, kind: kind as SourceIngestionCheckpoint['kind'] }));
    });
    afterEach(async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [input.sourceId]);
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE fingerprint=$1', [input.id]);
      if (worktreeId) {
        await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE worktree_id=$1::uuid', [worktreeId]);
        await engine.executeRaw('DELETE FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
        worktreeId = undefined;
      }
    });
    function mutation(r: SourceIngestionReceipt, fence: SourceIngestionFence = input.fence): SourceIngestionMutation {
      return { sourceId: r.sourceId, sourceIncarnation: r.sourceIncarnation, receiptId: r.id, expectedRevision: r.revision, expectedPhase: r.phase, fence };
    }
    async function complete(r: SourceIngestionReceipt): Promise<SourceIngestionReceipt> {
      for (const phase of ['CONTENT', 'GRAPH', 'VERIFY'] as const) r = await transitionSourceIngestionReceipt(engine, { ...mutation(r), phase });
      return recordSourceIngestionOutcome(engine, { ...mutation(r), outcome: 'complete', contentCommitted: true, graphCommitted: true, verificationPassed: true });
    }
    async function read(id = input.id): Promise<SourceIngestionReceipt | null> {
      return getSourceIngestionReceipt(engine, { ...input, receiptId: id });
    }

    test('bootstrap and idempotent migration expose the same receipt columns and indexes', async () => {
      for (let replay = 0; replay < 2; replay++) {
        for (const sql of SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL.split(';').filter(sql => sql.trim())) await engine.executeRaw(sql);
      }
      const indexes = await engine.executeRaw<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='source_ingestion_receipts'");
      expect(indexes.map(row => row.indexname)).toContain('source_ingestion_receipts_retention');
      expect(Number(await engine.getConfig('version'))).toBeGreaterThanOrEqual(162);
      expect((await beginSourceIngestionReceipt(engine, input)).schemaFingerprint).toBe(input.schemaFingerprint);
      expect((await read())?.policyFingerprint).toBe(input.policyFingerprint);
    });

    test('idempotent receipt DDL retains old unbound metadata without fabricating policy approval', async () => {
      await beginSourceIngestionReceipt(engine, input);
      await engine.executeRaw('ALTER TABLE source_ingestion_receipts DROP COLUMN policy_fingerprint');
      for (const sql of SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL.split(';').filter(sql => sql.trim())) await engine.executeRaw(sql);
      expect((await read())?.policyFingerprint).toBeNull();
      await expect(beginSourceIngestionReceipt(engine, input)).rejects.toMatchObject({ code: 'receipt_identity_mismatch' });
      await expect(beginSourceIngestionReceipt(engine, { ...input, id: randomUUID(), policyFingerprint: '' })).rejects.toMatchObject({ code: 'invalid_receipt' });
    });

    test('duplicate receipt IDs load exact approved identity without resetting progress', async () => {
      const first = await beginSourceIngestionReceipt(engine, input);
      const progressed = await transitionSourceIngestionReceipt(engine, { ...mutation(first), phase: 'CONTENT', counts: { importedPages: 3 } });
      expect(await beginSourceIngestionReceipt(engine, input)).toEqual(progressed);
      for (const changed of [{ approvedRevision: 'c'.repeat(40) }, { schemaFingerprint: 'd'.repeat(64) }, { policyFingerprint: 'e'.repeat(64) }, { extractorVersion: '2' }, { profile: 'other' }, { lifecycleRequestIds: [randomUUID()] }]) {
        await expect(beginSourceIngestionReceipt(engine, { ...input, ...changed })).rejects.toMatchObject({ code: 'receipt_identity_mismatch' });
      }
      expect((await read())?.counts.importedPages).toBe(3);
    });

    test('concurrent duplicate admission and revision CAS have one logical winner', async () => {
      const [a, b] = await Promise.all([beginSourceIngestionReceipt(engine, input), beginSourceIngestionReceipt(engine, input)]);
      expect(a).toEqual(b);
      const updates = await Promise.allSettled([
        transitionSourceIngestionReceipt(engine, { ...mutation(a), phase: 'CONTENT' }),
        transitionSourceIngestionReceipt(engine, { ...mutation(a), phase: 'CONTENT' }),
      ]);
      expect(updates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(updates.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((await read())?.revision).toBe(2);
    });

    test('nested admission rolls back with its caller transaction', async () => {
      await expect(engine.transaction(async tx => {
        await beginSourceIngestionReceipt(tx, input);
        throw new Error('fixture rollback');
      })).rejects.toThrow('fixture rollback');
      expect(await read()).toBeNull();
    });

    test('wrong phase, stale revision, and replaced incarnation cannot mutate receipts', async () => {
      const r = await beginSourceIngestionReceipt(engine, input);
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r), expectedPhase: 'GRAPH', phase: 'GRAPH' })).rejects.toMatchObject({ code: 'receipt_conflict' });
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r), phase: 'GRAPH' })).rejects.toMatchObject({ code: 'invalid_receipt_transition' });
      const updated = await transitionSourceIngestionReceipt(engine, { ...mutation(r), phase: 'CONTENT' });
      await expect(recordSourceIngestionOutcome(engine, { ...mutation(r), outcome: 'incomplete', diagnostic: 'interrupted' })).rejects.toMatchObject({ code: 'receipt_conflict' });
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(updated), sourceIncarnation: randomUUID(), phase: 'GRAPH' })).rejects.toMatchObject({ code: 'source_changed' });
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [input.sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [input.sourceId]);
      await expect(beginSourceIngestionReceipt(engine, input)).rejects.toMatchObject({ code: 'source_changed' });
      expect(await read()).toBeNull();
    });

    test('source-scoped state distinguishes absent pointer, missing receipt, and complete', async () => {
      expect((await readSourceIngestionState(engine, { ...input, receiptId: null })).state).toBe('never_connected');
      expect((await readSourceIngestionState(engine, { ...input, receiptId: input.id })).state).toBe('missing');
      const r = await beginSourceIngestionReceipt(engine, input);
      expect((await readSourceIngestionState(engine, { ...input, receiptId: input.id })).state).toBe('incomplete');
      expect(await getSourceIngestionReceipt(engine, { sourceId: 'default', sourceIncarnation: input.sourceIncarnation, receiptId: input.id })).toBeNull();
      expect(await getSourceIngestionReceipt(engine, { ...input, sourceIncarnation: randomUUID(), receiptId: input.id })).toBeNull();
      await complete(r);
      expect((await readSourceIngestionState(engine, { ...input, receiptId: input.id })).state).toBe('complete');
    });

    test('unreadable receipt storage propagates an error instead of reporting never connected', async () => {
      await beginSourceIngestionReceipt(engine, input);
      await expect(engine.transaction(async tx => {
        await tx.executeRaw('ALTER TABLE source_ingestion_receipts RENAME TO fixture_unreadable_receipts');
        await readSourceIngestionState(tx, { ...input, receiptId: input.id });
      })).rejects.toMatchObject({ code: '42P01' });
      expect((await read())?.id).toBe(input.id);
    });

    test('interrupted checkpoints and manifest paths survive more than seven days, ordinary GC still works', async () => {
      let r = await beginSourceIngestionReceipt(engine, input);
      r = await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints });
      for (const key of checkpoints) expect(await appendCompleted(engine, key, ['fixture-path'])).toBe(true);
      const ordinary = { op: 'fixture-ordinary', fingerprint: input.id };
      expect(await appendCompleted(engine, ordinary, ['unprotected'])).toBe(true);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '10 days' WHERE fingerprint=$1", [input.id]);
      await engine.executeRaw("UPDATE source_ingestion_receipts SET updated_at=now()-interval '100 days' WHERE id=$1::uuid", [input.id]);
      r = await recordSourceIngestionOutcome(engine, { ...mutation(r), outcome: 'incomplete', diagnostic: 'interrupted' });
      await purgeStaleCheckpoints(engine);
      for (const key of checkpoints) expect(await loadOpCheckpoint(engine, key)).toEqual(['fixture-path']);
      expect(await loadOpCheckpoint(engine, ordinary)).toEqual([]);
      expect(await pruneSourceIngestionReceipts(engine)).toBe(0);
      expect((await read())?.diagnostic).toBe('interrupted');
      expect((await transitionSourceIngestionReceipt(engine, { ...mutation(r), phase: 'CONTENT' })).phase).toBe('CONTENT');
    });

    test('completion permits checkpoint cleanup without deleting durable receipt', async () => {
      let r = await beginSourceIngestionReceipt(engine, input);
      r = await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints });
      for (const key of checkpoints) await appendCompleted(engine, key, ['fixture-path']);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '10 days' WHERE fingerprint=$1", [input.id]);
      const completed = await complete(r);
      await clearOpCheckpoint(engine, checkpoints[0]);
      await purgeStaleCheckpoints(engine);
      for (const key of checkpoints) expect(await loadOpCheckpoint(engine, key)).toEqual([]);
      expect(await read()).toEqual(completed);
    });

    test('managed-sync cursor headers and immutable manifests retain their original JSONB payloads', async () => {
      const cursor = { op: 'managed-sync', fingerprint: input.id, kind: 'managed_cursor' as const };
      const manifest = { op: 'managed-sync-manifest', fingerprint: input.id, kind: 'manifest' as const };
      const payloads = [[{ runId: input.id, index: 1, total: 2, pending: { requestId: randomUUID() } }],
        [{ path: 'fixture-a.md', action: 'import' }, { path: 'fixture-b.md', action: 'import' }]];
      const r = await beginSourceIngestionReceipt(engine, input);
      await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints: [cursor, manifest] });
      for (const [index, key] of [cursor, manifest].entries()) {
        await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now()-interval '30 days')",
          [key.op, key.fingerprint, JSON.stringify(payloads[index])]);
      }
      await purgeStaleCheckpoints(engine);
      for (const [index, key] of [cursor, manifest].entries()) {
        const [row] = await engine.executeRaw<{ completed_keys: unknown }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [key.op, key.fingerprint]);
        expect(row.completed_keys).toEqual(payloads[index]);
      }
      expect((await read())?.checkpointRefs).toEqual([cursor, manifest]);
    });

    test('ordinary explicit checkpoint cleanup is unchanged, including receipt-linked keys', async () => {
      const r = await beginSourceIngestionReceipt(engine, input);
      await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints: [checkpoints[0]] });
      await appendCompleted(engine, checkpoints[0], ['fixture-path']);
      await clearOpCheckpoint(engine, checkpoints[0]);
      expect(await loadOpCheckpoint(engine, checkpoints[0])).toEqual([]);
      expect((await read())?.outcome).toBe('incomplete');
    });

    test('checkpoint links are bounded, additive, CAS guarded, and retain only identities', async () => {
      const r = await beginSourceIngestionReceipt(engine, input);
      const linked = await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints: [checkpoints[0]] });
      await expect(linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints })).rejects.toMatchObject({ code: 'receipt_conflict' });
      const next = await linkSourceIngestionCheckpoints(engine, { ...mutation(linked), checkpoints });
      expect(next.checkpointRefs).toEqual(checkpoints);
      await expect(linkSourceIngestionCheckpoints(engine, { ...mutation(next), checkpoints: [{ ...checkpoints[0], fingerprint: 'private text with spaces' }] })).rejects.toMatchObject({ code: 'invalid_receipt' });
      const deduped = await linkSourceIngestionCheckpoints(engine, { ...mutation(next), checkpoints });
      expect(deduped.checkpointRefs).toHaveLength(3);
      await expect(linkSourceIngestionCheckpoints(engine, { ...mutation(deduped), checkpoints: Array(33).fill(checkpoints[0]) })).rejects.toMatchObject({ code: 'invalid_receipt' });
    });

    test('retention keeps latest completed and every incomplete receipt while pruning old completed ones', async () => {
      const oldest = await complete(await beginSourceIngestionReceipt(engine, input));
      const latest = await complete(await beginSourceIngestionReceipt(engine, { ...input, id: randomUUID() }));
      const incomplete = await beginSourceIngestionReceipt(engine, { ...input, id: randomUUID() });
      await engine.executeRaw("UPDATE source_ingestion_receipts SET completed_at=now()-interval '120 days', created_at=now()-interval '120 days', updated_at=now()-interval '120 days' WHERE id=$1::uuid", [oldest.id]);
      await engine.executeRaw("UPDATE source_ingestion_receipts SET completed_at=now()-interval '100 days', created_at=now()-interval '100 days', updated_at=now()-interval '100 days' WHERE id=$1::uuid", [latest.id]);
      await engine.executeRaw("UPDATE source_ingestion_receipts SET created_at=now()-interval '200 days', updated_at=now()-interval '200 days' WHERE id=$1::uuid", [incomplete.id]);
      expect(await pruneSourceIngestionReceipts(engine)).toBe(1);
      expect(await read(oldest.id)).toBeNull();
      expect((await read(latest.id))?.outcome).toBe('complete');
      expect((await read(incomplete.id))?.outcome).toBe('incomplete');
      expect(await pruneSourceIngestionReceipts(engine)).toBe(0);
    });

    test('explicit discard releases checkpoint retention and source removal cascades receipts', async () => {
      let r = await beginSourceIngestionReceipt(engine, input);
      r = await linkSourceIngestionCheckpoints(engine, { ...mutation(r), checkpoints: [checkpoints[0]] });
      await appendCompleted(engine, checkpoints[0], ['fixture-path']);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '10 days' WHERE fingerprint=$1", [input.id]);
      const discarded = await discardSourceIngestionReceipt(engine, mutation(r));
      expect(discarded.discardedAt).not.toBeNull();
      expect(discarded.outcome).toBe('discarded');
      await purgeStaleCheckpoints(engine);
      expect(await loadOpCheckpoint(engine, checkpoints[0])).toEqual([]);
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(discarded), phase: 'CONTENT' })).rejects.toMatchObject({ code: 'receipt_conflict' });
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [input.sourceId]);
      expect(await engine.executeRaw('SELECT id FROM source_ingestion_receipts WHERE id=$1::uuid', [input.id])).toHaveLength(0);
    });

    test('counts are numeric only and diagnostics never persist raw errors or content', async () => {
      const r = await beginSourceIngestionReceipt(engine, input);
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r), phase: 'CONTENT', counts: { importedPages: -1 } })).rejects.toMatchObject({ code: 'invalid_receipt' });
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r), phase: 'CONTENT', counts: { importedPages: Number.MAX_SAFE_INTEGER + 1 } })).rejects.toMatchObject({ code: 'invalid_receipt' });
      const badCounts = { ...mutation(r), phase: 'CONTENT', counts: { repositoryContent: 'private fixture' } } as unknown as Parameters<typeof transitionSourceIngestionReceipt>[1];
      await expect(transitionSourceIngestionReceipt(engine, badCounts)).rejects.toMatchObject({ code: 'invalid_receipt' });
      const rawError = { ...mutation(r), outcome: 'incomplete', diagnostic: `private fixture ${'x'.repeat(10000)}` } as unknown as Parameters<typeof recordSourceIngestionOutcome>[1];
      const failed = await recordSourceIngestionOutcome(engine, rawError);
      expect(failed.diagnostic).toBe('operation_failed');
      expect(JSON.stringify(await read())).not.toContain('private fixture');
    });

    test('approved identity rejects abbreviated revision and schema fingerprints', async () => {
      await expect(beginSourceIngestionReceipt(engine, { ...input, approvedRevision: 'a'.repeat(8) })).rejects.toMatchObject({ code: 'invalid_receipt' });
      await expect(beginSourceIngestionReceipt(engine, { ...input, schemaFingerprint: 'b'.repeat(8) })).rejects.toMatchObject({ code: 'invalid_receipt' });
      expect(await read()).toBeNull();
    });

    test('accepts the real inspection extractor timestamp without accepting arbitrary diagnostics', async () => {
      const current = await beginSourceIngestionReceipt(engine, { ...input, extractorVersion: LINK_EXTRACTOR_VERSION_TS });
      expect(current.extractorVersion).toBe(LINK_EXTRACTOR_VERSION_TS);
      await expect(beginSourceIngestionReceipt(engine, { ...input, id: randomUUID(), extractorVersion: 'private error\ncontent' }))
        .rejects.toMatchObject({ code: 'invalid_receipt' });
    });

    test('completion requires VERIFY, actual outcome evidence, and no failed or pending writes', async () => {
      let r = await beginSourceIngestionReceipt(engine, input);
      const evidence = { outcome: 'complete' as const, contentCommitted: true as const, graphCommitted: true as const, verificationPassed: true as const };
      await expect(recordSourceIngestionOutcome(engine, { ...mutation(r), ...evidence })).rejects.toMatchObject({ code: 'invalid_receipt_transition' });
      for (const phase of ['CONTENT', 'GRAPH', 'VERIFY'] as const) r = await transitionSourceIngestionReceipt(engine, { ...mutation(r), phase });
      for (const counts of [{ pendingWrites: 1 }, { failedFiles: 1 }, { verificationFailures: 1 }]) {
        await expect(recordSourceIngestionOutcome(engine, { ...mutation(r), ...evidence, counts })).rejects.toMatchObject({ code: 'invalid_receipt_transition' });
      }
      await expect(recordSourceIngestionOutcome(engine, { ...mutation(r), outcome: 'complete' } as Parameters<typeof recordSourceIngestionOutcome>[1])).rejects.toMatchObject({ code: 'invalid_receipt_transition' });
      expect((await read())?.outcome).toBe('incomplete');
      expect((await recordSourceIngestionOutcome(engine, { ...mutation(r), ...evidence })).outcome).toBe('complete');
    });

    test('managed writes require current owner, binding incarnation, and topology fence', async () => {
      worktreeId = randomUUID();
      const ownerHostId = randomUUID();
      await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation) VALUES($1::uuid,$2::uuid,4,7)', [worktreeId, ownerHostId]);
      await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,topology_generation) VALUES($1,$2::uuid,$3::uuid,7)', [input.sourceId, input.sourceIncarnation, worktreeId]);
      const fence: SourceIngestionFence = { mode: 'managed', worktreeId, ownerHostId, ownerEpoch: 4, topologyGeneration: 7 };
      await expect(beginSourceIngestionReceipt(engine, input)).rejects.toMatchObject({ code: 'receipt_fence_required' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await expect(beginSourceIngestionReceipt(engine, input)).rejects.toMatchObject({ code: 'receipt_fence_required' });
      const r = await beginSourceIngestionReceipt(engine, { ...input, fence });
      for (const changed of [{ ownerEpoch: 3 }, { topologyGeneration: 6 }, { ownerHostId: randomUUID() }]) {
        await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r, { ...fence, ...changed }), phase: 'CONTENT' })).rejects.toMatchObject({ code: 'receipt_fence_changed' });
      }
      await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [worktreeId]);
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r, fence), phase: 'CONTENT' })).rejects.toMatchObject({ code: 'receipt_fence_changed' });
      await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [worktreeId]);
      await engine.executeRaw('UPDATE persistence_source_bindings SET source_incarnation=$2::uuid WHERE source_id=$1', [input.sourceId, randomUUID()]);
      await expect(transitionSourceIngestionReceipt(engine, { ...mutation(r, fence), phase: 'CONTENT' })).rejects.toMatchObject({ code: 'receipt_fence_changed' });
      await engine.executeRaw('UPDATE persistence_source_bindings SET source_incarnation=$2::uuid WHERE source_id=$1', [input.sourceId, input.sourceIncarnation]);
      expect((await transitionSourceIngestionReceipt(engine, { ...mutation(r, fence), phase: 'CONTENT' })).phase).toBe('CONTENT');
    });
  });
}
