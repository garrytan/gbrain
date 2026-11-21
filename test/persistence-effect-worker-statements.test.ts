/**
 * The effect worker statements in src/core/engine-sql/persistence-effect-worker.ts are one text on both engines.
 *
 * 1. Protects: the claim stamp, the lease renewal (pooled and direct lane), the cursor advance, the settle statements
 *    (complete, retry, busy retry, requeue, park, fail), the withdrawal-mirror gate read, the effect guard locks and the
 *    re-arm probe that PGLite and Postgres send: the same text and the same bound values through each engine's own
 *    prototype, pinned in test/fixtures/goldens/sql-text-extra/persistence-effect-worker.json.
 * 2. Fails when: either engine changes a statement, a parameter order or the lane a member runs on, or the golden is
 *    edited without the member.
 * 3. Existing coverage: test/n8-sql-move-parity.test.ts compares the members' rows with the statements effect-journal.ts
 *    sent; no test pinned the text each engine sends.
 * 4. Production seam: none. The engine is a prototype with a recording `executeRaw`.
 */
import { describe, expect, test } from 'bun:test';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

describe('the effect worker statements are one text on both engines', () => {
  // The claim, settle, gate, guard and re-arm statements effect-journal.ts and effect-recovery.ts sent through executeRaw
  // before they called the engine members. Both engines delegate to engine-sql/persistence-effect-worker.ts; this pins
  // the text and bound values each engine sends, through its own prototype, in one golden.
  const T = 'f0000000-0000-4000-8000-0000000000e1';
  const ref = { id: '7', token: T };
  const calls: [string, (e: any) => Promise<unknown>][] = [
    ['stampEffectClaim', e => e.stampEffectClaim({ id: '7', token: T, ownerJson: '{}' })],
    ['renewEffectClaim', e => e.renewEffectClaim(ref)],
    ['renewEffectClaim#direct', e => e.renewEffectClaim(ref, { direct: true })],
    ['advanceEffectRow', e => e.advanceEffectRow({ ...ref, slug: 'notes/a' })],
    ['completeEffectRow', e => e.completeEffectRow({ ...ref, outcomeJson: '{}' })],
    ['retryEffectRow', e => e.retryEffectRow({ ...ref, reason: 'r', delayMs: 1000 })],
    ['retryBusyEffectRow', e => e.retryBusyEffectRow({ ...ref, dataJson: '{}', delayMs: 1000 })],
    ['requeueEffectRow', e => e.requeueEffectRow({ ...ref, dataJson: '{}', reason: null, delayMs: 1000 })],
    ['parkEffectRow', e => e.parkEffectRow({ ...ref, dataJson: '{}' })],
    ['failEffectRow', e => e.failEffectRow({ ...ref, reason: 'r' })],
    ['readMirrorGateRows', e => e.readMirrorGateRows(['b0000000-0000-4000-8000-0000000000b1'])],
    ['lockEffectGuard#brain', e => e.lockEffectGuard(null)],
    ['lockEffectGuard#worktree', e => e.lockEffectGuard('b0000000-0000-4000-8000-0000000000b1')],
    ['hasRearmableTargets', e => e.hasRearmableTargets(['b0000000-0000-4000-8000-0000000000b1'], 'withdrawal_mirror_failed')],
  ];
  async function record(proto: object): Promise<Record<string, unknown[][]>> {
    const out: Record<string, unknown[][]> = {};
    for (const [name, run] of calls) {
      const sent: unknown[][] = [];
      const send = async (sql: string, params?: unknown[]) => { sent.push([sql, params ?? []]); return []; };
      const engine = Object.create(proto, { executeRaw: { value: send }, executeRawDirect: { value: send }, engineSql: { value: { executeRaw: send } } });
      await run(engine);
      out[name] = sent;
    }
    return out;
  }

  test('PGLite and Postgres send the pinned statements with the same bound values', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const pglite = await record(PGLiteEngine.prototype);
    expect(await record(PostgresEngine.prototype)).toEqual(pglite);
    expectGolden('sql-text-extra/persistence-effect-worker', pglite, defineNormalizer<Record<string, unknown[][]>>('effect-worker-statements-v1', m => m));
  });
});
