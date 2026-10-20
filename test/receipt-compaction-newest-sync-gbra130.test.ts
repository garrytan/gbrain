/**
 * GBRA-130 A-14 (inventory E-6, #6712 PR 4b): the compaction pass selected the 100 oldest eligible receipts without
 * leaving out each worktree's newest committed managed-sync receipt (kept so a resumed run finds what it committed), and
 * `compactReceipt` then skipped every one of them. Once 100 or more worktrees (retired ones included) held such a receipt
 * past retention, every pass compacted 0 rows while still recording itself, so doctor read fresh and terminal_bytes grew
 * toward write_quota_exhausted.
 *
 * Protects (red before: the pass compacts 0 and the older put_page receipt stays): the exclusion is in the selection, so
 * 101 newest sync receipts on 101 worktrees, all past retention, leave the candidate window; the older put_page receipt
 * is compacted and the 101 stay. With nothing compacted, doctor's message names what the pass skipped.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { compactWriteReceiptsDetailed } from '../src/core/persistence/journal.ts';
import { LAST_COMPACTION_KEY } from '../src/core/persistence/compaction-pass.ts';
import { checkPersistenceCompaction } from '../src/commands/doctor/checks/persistence-compaction.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const WORKTREES = 101;

for (const kind of testBackends()) describe(`[${kind}] GBRA-130 A-14: the compaction window past each worktree's newest sync receipt`, () => {
  let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
  let scratch: string;
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-a14-'));
    factory = await freshBrainFactory(kind, process.env.DATABASE_URL);
  }, 120_000);
  afterAll(async () => { await factory?.dispose(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  test(`${WORKTREES} worktrees' newest sync receipts past retention do not starve an older put_page receipt`, () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine: BrainEngine = await factory.fresh();
    const requests = await requestFixture(engine);
    // 101 worktrees (retired or not), each with its newest committed managed-sync receipt, all past retention; admitted first,
    // so they lead the selection's sequence order.
    const sync = (await engine.executeRaw<{ id: string }>(`WITH w AS (INSERT INTO persistence_worktrees(state) SELECT 'active' FROM generate_series(1, ${WORKTREES}) RETURNING id)
      INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,intent,authority,
        intent_bytes,terminal_reservation,state,completed_at,published_at)
      SELECT 'local_cli','sync-example',gen_random_uuid(),'submit_job',$1,$2::uuid,'s-'||w.id,w.id,'d',jsonb_build_object('kind','managed_sync_import','runId','run-'||w.id),
        '{}'::jsonb,1,16384,'committed',now()-interval '150 days',now()-interval '150 days' FROM w RETURNING id::text AS id`, [requests.sourceId, requests.incarnation])).map(row => row.id);
    expect(sync).toHaveLength(WORKTREES);
    // The put_page receipt completed earlier than all of them but was admitted after them.
    const admitted = await requests.admit('put-page');
    await editRequest(engine, admitted.id, `state='committed',completed_at=now()-interval '200 days',published_at=now(),claim_expires_at=NULL`);
    await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [admitted.id]);
    const putPage = admitted.id;
    await engine.setConfig('persistence.receipt_retention_days', '90');

    const result = await compactWriteReceiptsDetailed(engine);
    const compacted = new Set((await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE compacted')).map(row => row.id));
    expect(compacted.has(putPage)).toBe(true);
    expect(sync.filter(id => compacted.has(id))).toEqual([]);
    expect(result.compacted).toBe(1);
    expect(result.skipped_by_reason.newest_sync_receipt ?? 0).toBe(0);

    // A pass that compacted nothing names what it skipped.
    await engine.setConfig(LAST_COMPACTION_KEY, JSON.stringify({ at: new Date().toISOString(), host_id: 'host-example', compacted: 0, freed_bytes: 0, skipped_by_reason: { lock_timeout: 3 } }));
    expect((await checkPersistenceCompaction(engine)).message).toContain('lock_timeout: 3');
  }), 180_000);
});
