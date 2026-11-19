/**
 * BrainEngine parity — a whole forget of one fact (forgetFactInFence, src/core/facts/forget.ts) on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: forgetting an active fact that sits on no page withdraws its claim (the ledger covers it), expires it and
 *    reports the legacy path; forgetting it again reports already_expired; a supersession and a retirement expire it
 *    without a withdrawal (the claim stays savable) and a supersession with a date ends it there; an id of another
 *    source or a missing id is not_found and changes nothing. The outcomes are equal on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: readFactForForget, expireFactSuperseded and expireFactAtDate refused on a Rust brain, so the first read
 *    of a forget stopped before any decision.
 *  - Why existing coverage misses it: test/engine-parity/withdrawal-forget.test.ts drives recordFactWithdrawal only, after
 *    the reads this function makes first, and forget-members.test.ts drives the members one by one.
 *  - Seam: none. Facts come from typed members; the forget runs whole on the arm's engine. Ids differ between arms, so
 *    facts are named by text.
 */
import { afterAll, describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'default';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// The operation case configures the process-global gateway; put back the preload's baseline for the next file.
afterAll(() => resetGateway());

describe('engine parity: a whole forget of one fact', () => {
  parityTest('forgets, supersedes and retires facts that sit on no page, and refuses what is out of scope', {
    methods: ['readFactForForget', 'expireFactSuperseded', 'insertFact', 'listFactsByEntity', 'hasCoveringFactWithdrawal', 'readWithdrawalAnchor'],
  }, async (engine: BrainEngine, backend) => {
    await createSource(engine, backend, 'other');
    const mk = async (fact: string, sourceId = SRC) => (await engine.insertFact(
      { fact, source: 'mcp:remember', entity_slug: 'people/a', visibility: 'world', valid_from: new Date('2026-01-01T00:00:00Z') } as never,
      { source_id: sourceId })).id;
    const ids = {
      forgotten: await mk('forgotten claim'), superseded: await mk('superseded claim'), retired: await mk('retired claim'),
      elsewhere: await mk('claim in other source', 'other'),
    };
    const out = {
      forget: await forgetFactInFence(engine, ids.forgotten, { sourceId: SRC }),
      again: await forgetFactInFence(engine, ids.forgotten, { sourceId: SRC }),
      superseded: await forgetFactInFence(engine, ids.superseded, { sourceId: SRC, supersededBy: { rowNum: null, validUntil: new Date('2026-02-01T00:00:00Z') } }),
      retired: await forgetFactInFence(engine, ids.retired, { sourceId: SRC, retired: 'source changed' }),
      wrongSource: await forgetFactInFence(engine, ids.elsewhere, { sourceId: SRC }),
      missing: await forgetFactInFence(engine, 999_999, { sourceId: SRC }),
    };
    const rows = await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false, limit: 100 } as never);
    const state = rows.map(r => ({ fact: r.fact, expired: r.expired_at != null, valid_until: r.valid_until == null ? null : new Date(r.valid_until as never).toISOString().slice(0, 10) }))
      .sort((a, b) => a.fact.localeCompare(b.fact));
    const otherRows = await engine.listFactsByEntity('other', 'people/a', { activeOnly: false, limit: 100 } as never);
    const today = new Date().toISOString().slice(0, 10);
    const anchors = { forgotten: await engine.readWithdrawalAnchor(ids.forgotten, SRC), superseded: await engine.readWithdrawalAnchor(ids.superseded, SRC), retired: await engine.readWithdrawalAnchor(ids.retired, SRC) };
    expect(out.forget).toEqual({ ok: true, path: 'legacy_db', reason: 'forgotten' });
    expect(out.again.path).toBe('already_expired');
    expect([out.wrongSource.path, out.missing.path]).toEqual(['not_found', 'not_found']);
    expect(anchors).toEqual({ forgotten: { withdrawn: true }, superseded: { withdrawn: false }, retired: { withdrawn: false } });
    expect(state).toEqual([
      { fact: 'forgotten claim', expired: true, valid_until: today },
      { fact: 'retired claim', expired: true, valid_until: today },
      { fact: 'superseded claim', expired: true, valid_until: '2026-02-01' },
    ]);
    return { out, state, anchors, otherExpired: otherRows.map(r => r.expired_at != null) };
  });
  parityTest('the forget_fact operation forgets a fact end to end, and answers not_found for a missing one', {
    methods: ['insertFact', 'listFactsByEntity', 'readWithdrawalAnchor'],
    timeout: 180_000,
  }, async (engine: BrainEngine) => {
    configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
    const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
    try {
      const { id } = await engine.insertFact(
        { fact: 'an operation claim', source: 'mcp:remember', entity_slug: 'people/a', visibility: 'world', valid_from: new Date('2026-01-01T00:00:00Z') } as never,
        { source_id: SRC });
      const forget = (await operationsByName.forget_fact.handler(ctx, { id } as never)) as Record<string, unknown>;
      const missing = await operationsByName.forget_fact.handler(ctx, { id: 999_999 } as never).then((r) => r as Record<string, unknown>, (e: Error & { code?: string }) => ({ refused: e.code ?? e.message }));
      const rows = await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false, limit: 10 } as never);
      const out = {
        forget: { ok: forget.expired, path: forget.path, reason: forget.reason, persistence: forget.persistence, writeThrough: forget.write_through },
        missing: 'refused' in missing ? missing : { path: missing.path, expired: missing.expired },
        expired: rows.map((r) => r.expired_at != null),
        withdrawn: await engine.readWithdrawalAnchor(id, SRC),
      };
      expect(out.forget).toMatchObject({ ok: true, path: 'legacy_db', persistence: { mode: 'database' } });
      expect(out.expired).toEqual([true]);
      expect(out.withdrawn).toEqual({ withdrawn: true });
      return out;
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
    }
  });
});
