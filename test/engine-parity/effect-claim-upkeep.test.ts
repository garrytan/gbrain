/**
 * Parity for the effect claim upkeep steps (persistence/effect-journal.ts): `effectClaimKeeper`, which renews a running
 * withdrawal-mirror or Git claim between the pieces of a long file, and `rearmWithheldTargets`, which re-queues the
 * Git and embedding targets a failed withdrawal mirror held back once that mirror commits.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the keeper renews a claim still held under its token and refuses `write_claim_lost` once the token no longer
 *    holds it; the re-arm takes only a request's Git or embedding effect that parked a target behind a failed mirror
 *    while that mirror is committed, queues it again with the withheld slugs to retry and its other parked entries kept,
 *    and leaves every other effect alone.
 *  - Regression: both steps ran raw SQL (the keeper's renewal, the re-arm's locked read and its update), which the Rust
 *    engine refuses, so on a Rust brain a long withdrawal-mirror or Git file lost its claim and a withheld target never
 *    came back.
 *  - Why existing coverage misses it: effect-scans.test.ts and the effect worker parity cases cover the claim, settle
 *    and park statements, not the keeper or the re-arm.
 *  - Seam: the cases call the two steps on effects queued, claimed and parked through typed members, rather than a
 *    whole effect pass. Ids, tokens and times differ per arm, so the cases compare states, codes and data.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { WITHHELD_BY_MIRROR } from '../../src/core/persistence/effect-model.ts';
import { claimPersistenceEffect, effectClaimKeeper, rearmWithheldTargets } from '../../src/core/persistence/effect-journal.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';

const { parityTest } = parityArms(testBackends());

const PRINCIPAL = { kind: 'local_cli' as const, id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const REQUEST = 'b0000000-0000-4000-8000-0000000000f4';

/** A committed request whose withdrawal queued its mirror, Git and embedding effects; returns its journal id. */
async function withdrawal(engine: BrainEngine): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  const { id } = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId: REQUEST, operation: 'forget', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: 'notes/upkeep-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'forget', slug: 'notes/upkeep-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  await engine.transactionDirect(async tx => {
    await tx.declarePersistence();
    await tx.insertWithdrawalEffects({ requestId: id, sourceId: 'default', targets: [{ slug: 'notes/upkeep-example', page_id: 1, revision: 'a0000000-0000-4000-8000-0000000000b0' }] });
  });
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id, state: 'committed', outcome: {}, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
    resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 4096, terminalReservation: 4096, probePurges: false,
  });
  return id;
}

/** Claims the next ready effect of this host; refuses when none is ready. */
async function claim(engine: BrainEngine): Promise<PersistenceEffect> {
  const effect = await claimPersistenceEffect(engine, localHostId());
  if (!effect) throw new Error('no effect was ready to claim');
  return effect;
}

const outcome = (run: () => Promise<unknown>) => run().then(r => r ?? 'ok', (e: { code?: string; message?: string }) => ({ refused: e.code ?? e.message ?? String(e) }));

describe('engine parity: the effect claim upkeep', () => {
  parityTest('the keeper renews a claim its token holds and refuses write_claim_lost once the token no longer does', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertWithdrawalEffects', 'transactionDirect',
      'declarePersistence', 'stampWriteClaim', 'completeWriteRow', 'selectClaimableEffect', 'stampEffectClaim', 'lockEffectClaimRow'],
    timeout: 60_000,
  }, async (engine) => {
    await withdrawal(engine);
    const mirror = await claim(engine);
    const renewed = await outcome(() => effectClaimKeeper(engine, mirror, 0)());
    const row = await engine.lockEffectClaimRow(mirror.id);
    const lost = await outcome(() => effectClaimKeeper(engine, { ...mirror, execution_token: randomUUID() }, 0)());
    const out = { kind: mirror.kind, renewed, stillRunning: row?.state === 'running' && row.execution_token === mirror.execution_token, lost };
    expect(out).toEqual({ kind: 'withdrawal-mirror', renewed: 'ok', stillRunning: true, lost: { refused: 'write_claim_lost' } });
    return out;
  });

  parityTest('the re-arm queues a target a failed mirror withheld once the mirror commits, and nothing else', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertWithdrawalEffects', 'transactionDirect',
      'declarePersistence', 'stampWriteClaim', 'completeWriteRow', 'selectClaimableEffect', 'stampEffectClaim', 'completeEffectRow',
      'parkEffectRow', 'readRequestEffects'],
    timeout: 60_000,
  }, async (engine) => {
    const id = await withdrawal(engine);
    const mirror = await claim(engine);
    await engine.completeEffectRow({ id: mirror.id, token: mirror.execution_token, outcomeJson: JSON.stringify({ parity: true }) });
    const git = await claim(engine);
    const parked = [{ slug: 'notes/upkeep-example', error_code: WITHHELD_BY_MIRROR }, { slug: 'notes/other-example', error_code: 'git_target_ignored' }];
    await engine.parkEffectRow({ id: git.id, token: git.execution_token, dataJson: JSON.stringify({ ...git.data, parked }) });
    const none = await engine.transaction(tx => rearmWithheldTargets(tx, ['a0000000-0000-4000-8000-0000000000a9']));
    const rearmed = await engine.transaction(tx => rearmWithheldTargets(tx, [id]));
    const effects = await engine.readRequestEffects(id);
    const again = await engine.transaction(tx => rearmWithheldTargets(tx, [id]));
    // The re-armed Git effect comes back with the withheld slug to retry and its other parked entry kept.
    let next = await claim(engine);
    if (next.kind !== 'git') next = await claim(engine);
    const out = { mirror: mirror.kind, git: git.kind, none, rearmed, again, effects,
      rearmedData: { kind: next.kind, parked: next.data.parked ?? null, retry_slugs: next.data.retry_slugs ?? null, attempts: next.attempts } };
    expect(out).toEqual({
      mirror: 'withdrawal-mirror', git: 'git', none: 0, rearmed: 1, again: 0,
      effects: [
        { kind: 'embedding', state: 'queued', error_code: null, outcome: null, recovering: false },
        { kind: 'git', state: 'queued', error_code: null, outcome: null, recovering: false },
        { kind: 'withdrawal-mirror', state: 'committed', error_code: null, outcome: { parity: true }, recovering: false },
      ],
      rearmedData: { kind: 'git', parked: [{ slug: 'notes/other-example', error_code: 'git_target_ignored' }], retry_slugs: ['notes/upkeep-example'], attempts: 2 },
    });
    return out;
  });
});
