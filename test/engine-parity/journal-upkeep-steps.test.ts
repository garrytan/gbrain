/**
 * Parity for the write journal's remaining upkeep steps: the preparation-attempt counters (persistence/journal.ts
 * `chargePreparationAttempt`, `floorPreparationAttempts`), a write receipt's health facts (`writeHealthFacts`), the
 * page a source-scan effect reads next (persistence/effects.ts `selectedEffectPage`), and the failure and
 * skipped-target steps of an effect attempt (`recordFailure`, `recordSkippedTarget`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a charge adds one attempt to a claim its token holds and a floor raises a live request's count to the limit (a
 *    terminal one is left); the health facts of two pending writes of one source say the second waits on the first
 *    and nothing needs recovery; a source scan reads the next page after its cursor in slug order and none past the
 *    last; a skipped target is added to the effect's `skipped` list; a Git attempt that failed on a replaced source fails
 *    `source_changed`, and one that failed on its own is queued again with its failure counted and is claimable again
 *    once its backoff passes. The case reads the running mirror through the mirror gate and never stamps a live claim
 *    again: Postgres still allows that, and the multi-user Rust store refuses it on purpose.
 *  - Regression: each step ran raw SQL, which the Rust engine refuses: on a Rust brain a stalled preparation was never
 *    charged, a write receipt silently lost its health facts (the read's refusal was caught and dropped), a source scan
 *    stopped at its first page, and an effect's failure could not be recorded.
 *  - Why existing coverage misses it: the journal and effect unit tests run PGLite and Postgres only.
 *  - Seam: the cases call each step directly on rows seeded through typed members (the two effect steps through
 *    effects.ts `__effectFailureStepsForTests`), rather than a whole consumer or effect pass.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { withEnv } from '../helpers/with-env.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { chargePreparationAttempt, floorPreparationAttempts, writeHealthFacts } from '../../src/core/persistence/journal.ts';
import { __effectFailureStepsForTests, selectedEffectPage } from '../../src/core/persistence/effects.ts';
import { claimPersistenceEffect } from '../../src/core/persistence/effect-journal.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { opError } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

const PRINCIPAL = { kind: 'local_cli' as const, id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

/** Admits one queued request; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, operation = 'put_page'): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation, sourceId: 'default', sourceIncarnation: incarnation,
    pageId: null, slug: 'notes/upkeep-example', worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
    intent: { kind: operation, slug: 'notes/upkeep-example' }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096,
    targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS, clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  })).id;
}

const row = async (engine: BrainEngine, id: string) => (await engine.readWriteRequestById(id))! as WriteRequest;
const attempts = async (engine: BrainEngine, id: string) => Number((await row(engine, id)).preparation_attempts ?? 0);
const outcome = <T>(run: () => Promise<T>) => run().then(r => r, (e: { code?: string; message?: string }) => ({ refused: e.code ?? e.message ?? String(e) }));

/** A committed withdrawal whose mirror, Git and embedding effects are queued; returns its journal id. */
async function withdrawal(engine: BrainEngine, requestId: string): Promise<string> {
  const id = await admit(engine, requestId, 'forget');
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

async function claim(engine: BrainEngine): Promise<PersistenceEffect> {
  const effect = await claimPersistenceEffect(engine, localHostId());
  if (!effect) throw new Error('no effect was ready to claim');
  return effect;
}

/**
 * A running withdrawal mirror's stored data, read through the mirror gate (`readMirrorGateRows` lists a request's
 * mirror while it is not committed). It does not stamp the live claim again: Postgres allows that, and the multi-user
 * Rust store refuses it on purpose (a store that takes over a live claim lets two hosts run one effect).
 */
async function mirrorDataOf(engine: BrainEngine, mirror: PersistenceEffect): Promise<Record<string, unknown>> {
  const gate = (await engine.readMirrorGateRows([String(mirror.request_id)])).find(r => r.state === 'running');
  return (gate?.data ?? {}) as Record<string, unknown>;
}

/** The next effect that becomes claimable within `withinMs` (an effect queued again waits out its backoff first). */
async function claimWhenDue(engine: BrainEngine, withinMs: number): Promise<PersistenceEffect | null> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const effect = await claimPersistenceEffect(engine, localHostId());
    if (effect || Date.now() >= deadline) return effect;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

describe('engine parity: the write journal upkeep steps', () => {
  parityTest('a charge adds an attempt to a held claim and a floor raises a live request to the limit', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'readWriteRequestById', 'completeWriteRow'],
    timeout: 60_000,
  }, async (engine) => {
    const id = await admit(engine, 'b0000000-0000-4000-8000-0000000000e1');
    const queued = await attempts(engine, id);
    await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const charged = await outcome(async () => chargePreparationAttempt(engine, await row(engine, id)));
    const stale = await outcome(async () => chargePreparationAttempt(engine, { ...await row(engine, id), execution_token: randomUUID() }));
    const afterCharge = await attempts(engine, id);
    await outcome(() => floorPreparationAttempts(engine, id, 5));
    const afterFloor = await attempts(engine, id);
    await outcome(() => floorPreparationAttempts(engine, id, 3));
    const lowerFloor = await attempts(engine, id);
    await engine.completeWriteRow({
      id, state: 'failed', outcome: {}, errorCode: 'preparation_stalled', errorMessage: null, consumerVersion: 'parity', consumerHostId: null,
      errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 4096, terminalReservation: 4096, probePurges: false,
    });
    await outcome(() => floorPreparationAttempts(engine, id, 9));
    const terminal = await attempts(engine, id);
    const out = { queued, charged, stale, afterCharge, afterFloor, lowerFloor, terminal };
    expect(out).toEqual({ queued: 0, charged: 1, stale: 2, afterCharge: 1, afterFloor: 5, lowerFloor: 5, terminal: 5 });
    return out;
  });

  parityTest('the health facts of two pending writes of one source say the second waits on the first', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'readWriteRequestById'],
    timeout: 60_000,
  }, async (engine) => {
    const first = await admit(engine, 'b0000000-0000-4000-8000-0000000000e2');
    const second = await admit(engine, 'b0000000-0000-4000-8000-0000000000e3');
    const view = async () => {
      const facts = await writeHealthFacts(engine, [await row(engine, first), await row(engine, second)]);
      const strip = (id: string) => { const f = facts.get(id); if (!f) return null; const { observed_at: _at, ...rest } = f; return rest; };
      return { first: strip(first), second: strip(second) };
    };
    const queued = await view();
    await engine.stampWriteClaim(first, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const running = await view();
    const facts = { recovery_required: false, owner_unavailable: false, inspect_owner: false };
    const out = { queued, running };
    expect(out).toEqual({
      queued: { first: { ...facts, earlier_write: false }, second: { ...facts, earlier_write: true } },
      running: { first: { ...facts, earlier_write: false }, second: { ...facts, earlier_write: true } },
    });
    return out;
  });

  parityTest('a source scan reads the page after its cursor in slug order, and none past the last', {
    methods: ['putPage', 'readSourceMembership', 'readPageSnapshot'],
    timeout: 60_000,
  }, async (engine) => {
    for (const slug of ['notes/scan-b', 'notes/scan-a', 'notes/scan-c']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'scan body', timeline: '' });
    }
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const scan = (after: string | undefined) => ({ id: 1, kind: 'git', source_id: 'default', source_incarnation: incarnation,
      data: { source_scan: true, ...(after !== undefined ? { after_slug: after } : {}) } }) as unknown as PersistenceEffect;
    const next = async (after: string | undefined) => (await outcome(() => selectedEffectPage(engine, scan(after))) as { page?: { slug: string }; refused?: string } | null);
    const slugOf = (s: { page?: { slug: string }; refused?: string } | null) => s?.refused ?? s?.page?.slug ?? null;
    const out = { first: slugOf(await next(undefined)), afterA: slugOf(await next('notes/scan-a')), afterB: slugOf(await next('notes/scan-b')),
      afterC: slugOf(await next('notes/scan-c')) };
    expect(out).toEqual({ first: 'notes/scan-a', afterA: 'notes/scan-b', afterB: 'notes/scan-c', afterC: null });
    return out;
  });

  parityTest('a skipped target is added to the effect, a replaced source fails it and its own failure queues it again', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertWithdrawalEffects', 'transactionDirect',
      'declarePersistence', 'stampWriteClaim', 'completeWriteRow', 'selectClaimableEffect', 'stampEffectClaim', 'readMirrorGateRows',
      'completeEffectRow', 'readRequestEffects', 'failEffectRow'],
    // The own failure queues the effect again behind a 30-second backoff, which the last step waits out on each arm.
    timeout: 240_000,
  }, async (engine) => {
    const id = await withdrawal(engine, 'b0000000-0000-4000-8000-0000000000e4');
    const mirror = await claim(engine);
    await __effectFailureStepsForTests.recordSkippedTarget(engine, mirror, { slug: 'notes/upkeep-example', reason: 'metafile' });
    const skipped = (await mirrorDataOf(engine, mirror)).skipped ?? null;
    await engine.completeEffectRow({ id: mirror.id, token: mirror.execution_token, outcomeJson: '{}' });
    const git = await claim(engine);
    const replaced = await outcome(() => __effectFailureStepsForTests.recordFailure(engine, { ...git, source_incarnation: 'f0000000-0000-4000-8000-0000000000f0' },
      opError('source_changed', 'The source changed.', 'parity')));
    const embedding = await claim(engine);
    const own = await outcome(() => __effectFailureStepsForTests.recordFailure(engine, { ...embedding, kind: 'git' as never },
      opError('git_commit_failed' as never, 'The commit failed.', 'parity')));
    const effects = (await engine.readRequestEffects(id)).map(e => ({ kind: e.kind, state: e.state, error_code: e.error_code }));
    // The effect its own failure queued again is claimable once its backoff passes, and nothing else is.
    const again = await claimWhenDue(engine, 60_000);
    const out = { skipped, replaced: replaced ?? 'ok', own: own ?? 'ok', effects, claimableAgain: again?.id === embedding.id };
    expect(out).toEqual({
      skipped: [{ slug: 'notes/upkeep-example', reason: 'metafile' }], replaced: 'ok', own: 'ok',
      effects: [
        { kind: 'embedding', state: 'queued', error_code: 'git_commit_failed' },
        { kind: 'git', state: 'failed', error_code: 'source_changed' },
        { kind: 'withdrawal-mirror', state: 'committed', error_code: null },
      ],
      claimableAgain: true,
    });
    return out;
  });

  parityTest('the segment sweep lists the sources bound to an active worktree this host owns', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'persistenceUpkeepStore'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-upkeep-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'checkout');
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createSource(engine, backend, 'work', {}, root);
        try {
          const upkeep = await engine.persistenceUpkeepStore();
          const before = await upkeep.listOwnedBoundSources(localHostId());
          await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim',
            expected_state: await writerAdminState(engine) });
          const out = { before, owned: await upkeep.listOwnedBoundSources(localHostId()),
            otherHost: await upkeep.listOwnedBoundSources('e0000000-0000-4000-8000-0000000000e9') };
          expect(out).toEqual({ before: [], owned: ['work'], otherHost: [] });
          return out;
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
