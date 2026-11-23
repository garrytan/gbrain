/**
 * The effects a forget under a write request queues, on PGLite and on a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: recordFactWithdrawal (facts/withdrawal.ts) with a `requestId` still leaves its `withdrawal-mirror`, `git`
 *    and `embedding` effects on PGLite now that the insert is the typed member insertWithdrawalEffects, and a Rust
 *    brain stores the same three rows inside `transaction`, committed with the transaction or not at all.
 *  - Regression: the insert went through `executeRaw`, which the Rust engine refuses, so a managed forget on a Rust
 *    brain could not record the effects its receipt promises.
 *  - Why existing coverage misses it: test/persistence-effects.test.ts runs the withdrawal on PGLite only; the parity
 *    case in test/engine-parity/persistence.test.ts covers the member's rows but not the rollback.
 *  - Seam: none on PGLite. The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *    The whole Rust withdrawal is not driven here: its earlier statements still go through `executeRaw`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const KEYS = ['principal:local_cli:withdrawal-writer', 'brain'];

/** Admits one queued request under `requestId`; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'withdrawal-writer', requestId, operation: 'forget_fact', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: 'people/alice-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'forget_fact' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'test', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

const queued = (kind: string) => ({ kind, state: 'queued', error_code: null, outcome: null, recovering: false });
const THREE = [queued('embedding'), queued('git'), queued('withdrawal-mirror')];

describe('withdrawal effects', () => {
  let pg: PGLiteEngine;
  let pgHome: string;

  beforeAll(async () => {
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-effects-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite: a forget under a write request leaves its three effects', async () => {
    const id = await admit(pg, 'b0000000-0000-4000-8000-0000000000a1');
    const [fact] = await pg.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,source,visibility)
      VALUES('default','people/alice-example','Withdraw this claim','test conversation','world') RETURNING id`);
    const result = await pg.transaction(tx => recordFactWithdrawal(tx, Number(fact.id), 'default', false, { requestId: id }));
    expect(result.withdrawn).toBe(true);
    expect(await pg.readRequestEffects(id)).toEqual(THREE);
  });

  rustRun('Rust: the effects commit with the transaction they run in, and a refused transaction leaves none', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      const kept = await admit(engine, 'b0000000-0000-4000-8000-0000000000a2');
      const dropped = await admit(engine, 'b0000000-0000-4000-8000-0000000000a3');
      const targets = [{ slug: 'people/alice-example', page_id: 1, revision: 'e0000000-0000-4000-8000-0000000000e1' }];
      await engine.transaction(tx => tx.insertWithdrawalEffects({ requestId: kept, sourceId: 'default', targets }));
      let refused = '';
      try {
        await engine.transaction(async tx => {
          await tx.insertWithdrawalEffects({ requestId: dropped, sourceId: 'default', targets });
          throw new Error('the withdrawal refused after its effects');
        });
      } catch (e) { refused = (e as Error).message; }
      expect(refused).toContain('the withdrawal refused after its effects');
      expect(await engine.readRequestEffects(kept)).toEqual(THREE);
      expect(await engine.readRequestEffects(dropped)).toEqual([]);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  });
});
