/**
 * #6188 attempt claims and memo for paid fence repairs
 * (`src/core/fence-repair/attempts.ts`).
 *
 * Protects: two appliers (cycle and CLI) never both attempt one candidate; a
 * rejected memo (content sha256, model, rules version, prompt version) spends
 * nothing again until one part changes; a transient provider failure does not
 * consume it; a crash before dispatch is taken over for free, a crash after
 * dispatch is charged its reserved maximum by the ledger and counts against
 * the memo; an applier whose claim was taken over cannot publish; at most one
 * paid attempt plus one re-ask per claim.
 * Fails when: the claim is a read-then-write without a version check, a
 * rejected memo is claimable, transient consumes the memo, or a stale claim
 * blocks the candidate forever.
 * Seams: an injected clock; PGLite always, Postgres through
 * test/e2e/fence-repair-attempts-postgres.test.ts (separate sessions for the
 * concurrent claim).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  FENCE_REPAIR_ATTEMPT_OP, attemptFingerprint, attemptMemoKey, attemptStore,
  type AttemptCandidate, type AttemptClaim, type ClaimResult, type TransitionResult,
} from '../src/core/fence-repair/attempts.ts';
import { dailyLedger } from '../src/core/budget/daily-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const LEASE_MS = 60_000;

function clock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}
const candidate = (): AttemptCandidate => ({ sourceId: 'notes-example', incarnation: randomUUID(), key: `path:people/alice-example-${randomUUID()}.md` });
const memo = (content: string, model = 'anthropic:claude-sonnet-5-5') => attemptMemoKey({ contentSha256: content, model, fenceVersion: 1, promptVersion: 1 });
const held = (r: ClaimResult | TransitionResult): AttemptClaim => { if (!r.ok) throw new Error(`expected a claim, got ${r.reason}`); return r.claim; };

for (const backend of backends) {
  describe(`${backend}: fence repair attempts`, () => {
    let engine: BrainEngine;
    let sessions: BrainEngine[] = [];
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        sessions = [pglite];
        close = () => pglite.disconnect();
        return;
      }
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine;
      const extra = await Promise.all(Array.from({ length: 4 }, async () => {
        const session = new PostgresEngine();
        await session.connect({ database_url: pg.databaseUrl, poolSize: 2 });
        return session;
      }));
      sessions = [pg.engine, ...extra];
      close = async () => { for (const session of extra) await session.disconnect(); await pg.close(); };
    }, 120_000);

    afterAll(async () => { await close(); });

    test('one applier holds a candidate: a second claim is refused, and concurrent claims admit exactly one', async () => {
      const c = clock('2026-10-06T12:00:00Z');
      const store = attemptStore(engine, { ...c, leaseMs: LEASE_MS });
      const target = candidate();
      const first = await store.claim(target, memo('a'));
      expect(first).toMatchObject({ ok: true, claim: { record: { state: 'claimed', crashes: 0, dispatches: 0 } } });
      expect(await store.claim(target, memo('a'))).toMatchObject({ ok: false, reason: 'claimed_elsewhere' });
      expect(await store.claim(target, memo('b'))).toMatchObject({ ok: false, reason: 'claimed_elsewhere' });

      const contested = candidate();
      const stores = sessions.map(session => attemptStore(session, { ...c, leaseMs: LEASE_MS }));
      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % stores.length]!.claim(contested, memo('c'))));
      expect(claims.filter(r => r.ok)).toHaveLength(1);
      expect(claims.filter(r => !r.ok).every(r => !r.ok && r.reason === 'claimed_elsewhere')).toBe(true);
    }, 60_000);

    test('a rejected memo is not claimed again until the content, model, rules or prompt version changes', async () => {
      const store = attemptStore(engine, { ...clock('2026-10-06T12:00:00Z'), leaseMs: LEASE_MS });
      const target = candidate();
      let claim = held(await store.claim(target, memo('a')));
      claim = held(await store.dispatched(claim, randomUUID()));
      claim = held(await store.settled(claim));
      expect(held(await store.reject(claim, { reason: 'claim_changed', gate: 'b', rows: [3, 7] })).record).toMatchObject({ state: 'rejected', gate: 'b', rows: [3, 7] });
      expect(await store.claim(target, memo('a'))).toMatchObject({ ok: false, reason: 'rejected', record: { reason: 'claim_changed', gate: 'b', rows: [3, 7] } });
      for (const changed of [memo('a', 'openai:gpt-6-sol'), memo('a-edited'),
        attemptMemoKey({ contentSha256: 'a', model: 'anthropic:claude-sonnet-5-5', fenceVersion: 2, promptVersion: 1 }),
        attemptMemoKey({ contentSha256: 'a', model: 'anthropic:claude-sonnet-5-5', fenceVersion: 1, promptVersion: 2 })]) {
        expect(changed).not.toBe(memo('a'));
      }
      expect(await store.claim(target, memo('a', 'openai:gpt-6-sol'))).toMatchObject({ ok: true, claim: { record: { state: 'claimed', crashes: 0 } } });
      // The purge exemption the integration lane adds keys on these two fields.
      const [row] = await engine.executeRaw<{ source_id: string; incarnation: string }>(
        "SELECT completed_keys->0->>'source_id' AS source_id, completed_keys->0->>'incarnation' AS incarnation FROM op_checkpoints WHERE op = $1 AND fingerprint = $2",
        [FENCE_REPAIR_ATTEMPT_OP, attemptFingerprint(target)]);
      expect(row).toEqual({ source_id: target.sourceId, incarnation: target.incarnation });
    });

    test('a transient provider failure does not consume the memo; a published memo is done', async () => {
      const store = attemptStore(engine, { ...clock('2026-10-06T12:00:00Z'), leaseMs: LEASE_MS });
      const target = candidate();
      let claim = held(await store.claim(target, memo('a')));
      claim = held(await store.dispatched(claim, randomUUID()));
      expect(held(await store.transient(claim, 'llm_unavailable')).record).toMatchObject({ state: 'transient', reason: 'llm_unavailable' });
      claim = held(await store.claim(target, memo('a')));
      claim = held(await store.dispatched(claim, randomUUID()));
      claim = held(await store.settled(claim));
      await store.publish(claim);
      expect(await store.claim(target, memo('a'))).toMatchObject({ ok: false, reason: 'published' });
      expect(await store.read(target)).toMatchObject({ state: 'published', memo: memo('a') });
    });

    test('a claim makes at most one paid attempt plus one corrective re-ask', async () => {
      const store = attemptStore(engine, { ...clock('2026-10-06T12:00:00Z'), leaseMs: LEASE_MS });
      let claim = held(await store.claim(candidate(), memo('a')));
      claim = held(await store.settled(held(await store.dispatched(claim, randomUUID()))));
      claim = held(await store.settled(held(await store.dispatched(claim, randomUUID()))));
      expect(claim.record.dispatches).toBe(2);
      expect(await store.dispatched(claim, randomUUID())).toEqual({ ok: false, reason: 'dispatch_limit' });
      const fresh = held(await store.claim(candidate(), memo('b')));
      await expect(store.publish(fresh)).rejects.toThrow('cannot move from claimed to published');
    });

    test('an expired undispatched claim is taken over for free, and the old holder can no longer publish', async () => {
      const c = clock('2026-10-06T12:00:00Z');
      const store = attemptStore(engine, { ...c, leaseMs: LEASE_MS });
      const target = candidate();
      const stale = held(await store.claim(target, memo('a')));
      c.advance(LEASE_MS - 1);
      expect(await store.claim(target, memo('a'))).toMatchObject({ ok: false, reason: 'claimed_elsewhere' });
      c.advance(2);
      const taken = await store.claim(target, memo('a'));
      expect(taken).toMatchObject({ ok: true, recovered: 'stale_claim', claim: { record: { crashes: 0 } } });
      expect(held(taken).record.owner).not.toBe(stale.record.owner);
      expect(await store.dispatched(stale, randomUUID())).toEqual({ ok: false, reason: 'lost_claim' });
      expect(await store.transient(stale, 'llm_unavailable')).toEqual({ ok: false, reason: 'lost_claim' });
    });

    test('a crash after dispatch is charged its reserved maximum and counts against the memo; two crashes reject it', async () => {
      const c = clock('2026-10-06T12:00:00Z');
      const store = attemptStore(engine, { ...c, leaseMs: LEASE_MS });
      const ledger = dailyLedger(engine, { scope: 'llm_repair', resolver: `test-${randomUUID()}` }, c);
      const target = candidate();
      const crashAfterDispatch = async (claim: AttemptClaim) => {
        const reserved = await ledger.reserve(0.02, { capUsd: 1, ttlMs: LEASE_MS });
        if (!reserved.ok) throw new Error(reserved.reason);
        held(await store.dispatched(claim, reserved.reservation.id));
        expect(await ledger.dispatch(reserved.reservation.id)).toBe(true);
        c.advance(LEASE_MS + 1);
      };
      await crashAfterDispatch(held(await store.claim(target, memo('a'))));
      const recovered = await store.claim(target, memo('a'));
      expect(recovered).toMatchObject({ ok: true, recovered: 'crash_after_dispatch', claim: { record: { crashes: 1, dispatches: 0 } } });
      expect(await ledger.reclaimExpired()).toEqual({ released: 0, settledUncertain: 1 });
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0, committedUsd: 0.02 });

      // A crash after the call settled loses the answer too.
      const again = held(await store.dispatched(held(recovered), randomUUID()));
      held(await store.settled(again));
      c.advance(LEASE_MS + 1);
      expect(await store.claim(target, memo('a'))).toMatchObject({ ok: false, reason: 'rejected', record: { state: 'rejected', reason: 'crash_limit', crashes: 2 } });
      expect(await store.claim(target, memo('a-edited'))).toMatchObject({ ok: true, claim: { record: { crashes: 0 } } });
    });
  });
}

if (backends.includes('pglite')) {
  test('a store error means no claim', async () => {
    const broken = { executeRaw: async () => { throw new Error('connection refused'); } } as unknown as BrainEngine;
    const store = attemptStore(broken);
    expect(await store.claim(candidate(), memo('a'))).toEqual({ ok: false, reason: 'store_unavailable' });
  });
}
