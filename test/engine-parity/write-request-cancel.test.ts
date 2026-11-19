/**
 * BrainEngine parity — cancelling a pending write request: MCP cancel_write_request of the caller's own queued
 * request, and two cancels of one request at the same time.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: cancel_write_request of the caller's own queued request answers the cancelled receipt (state
 *    `cancelled`, error code `cancelled`) on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts) and releases the request's outstanding counters. A second cancel answers
 *    the same terminal receipt. Of two cancels that run at the same time, exactly one ends the request; both answer
 *    `cancelled`, and the counters are released once.
 *  - Regression: cancelWriteRequest (persistence/control.ts) locked the request row with a raw `SELECT ... FOR UPDATE`
 *    through executeRaw, so on a Rust brain every cancel of an existing request stopped on the raw_sql refusal.
 *  - Why existing coverage misses it: write-request-reads.test.ts cancels only an unknown request id, which ends
 *    before the transaction; persistence.test.ts drives completeWrite directly, not the cancel step.
 *  - Seam: GBRAIN_HOME through withEnv (the registration files live under it). Typed members only (no executeRaw: D18).
 *    Generated values (journal ids, sequences, timestamps) are left out of the returned values.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { persistenceOperations } from '../../src/core/ops/persistence.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';

const { parityTest } = parityArms(testBackends());

const REQUEST = 'b0000000-0000-4000-8000-0000000000c1';

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-cancel-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function remote(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/** The handler's receipt without its timestamps, or the code it refused with. */
async function cancel(engine: BrainEngine, requestId: string): Promise<unknown> {
  const op = persistenceOperations.find(o => o.name === 'cancel_write_request')!;
  try {
    const receipt = await op.handler(remote(engine), { request_id: requestId }) as Record<string, unknown>;
    const { created_at: _created, updated_at: _updated, ...rest } = receipt;
    return rest;
  } catch (err) {
    return { code: (err as { code?: unknown }).code ?? String(err) };
  }
}

/** Admits one queued request of the remote caller in source default and returns the counter keys it charged. */
async function admitOwn(engine: BrainEngine): Promise<string[]> {
  await registerServeLocalWriters(engine);
  const principal = await requestPrincipalForContext(remote(engine));
  const source = await engine.readSourceMembership('default');
  const keys = ['brain', `principal:${principal.kind}:${principal.id}`];
  const authority = await submissionAuthority(remote(engine), 'put_page', 'default', source!.incarnation, 'notes/cancel-me');
  await engine.transaction(async (tx) => {
    await tx.lockPersistenceCounters(keys);
    await tx.insertWriteRequest({
      principalKind: principal.kind, principalId: principal.id, requestId: REQUEST, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/cancel-me', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/cancel-me' }, authority, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
  });
  return keys;
}

/** Outstanding counts in key order; the principal key holds a generated id, so it is left out. */
async function outstanding(engine: BrainEngine, keys: string[]): Promise<number[]> {
  const rows = await engine.readCounterRows(keys);
  return keys.map(k => Number(rows.find(r => r.key === k)?.outstanding_count));
}

const CANCELLED = expect.objectContaining({ request_id: REQUEST, state: 'cancelled', write_error: 'cancelled', outcome: {}, effects: [] });

describe('engine parity: cancelling a write request', () => {
  parityTest('a remote caller cancels its own queued request, and a second cancel answers the same receipt', { methods: ['readLocalWriterRow', 'readWriteRequest', 'lockWriteRequest', 'cancelWriteRow', 'readRequestEffects', 'lockPersistenceCounters'] },
    (engine) => inFreshHome(async () => {
      const keys = await admitOwn(engine);
      const before = await outstanding(engine, keys);
      const first = await cancel(engine, REQUEST);
      const after = await outstanding(engine, keys);
      const again = await cancel(engine, REQUEST);
      const principal = await requestPrincipalForContext(remote(engine));
      const stored = await engine.readWriteRequest(principal.kind, principal.id, REQUEST);
      const result = { before, first, after, again, stored: { state: stored?.state, error_code: stored?.error_code } };
      expect(result.first).toEqual(CANCELLED);
      expect(result.again).toEqual(result.first);
      expect(result.before).toEqual([1, 1]);
      expect(result.after).toEqual([0, 0]);
      expect(result.stored).toEqual({ state: 'cancelled', error_code: 'cancelled' });
      return result;
    }));

  parityTest('two cancels of one request at the same time: exactly one ends it, and the counters are released once', { methods: ['readLocalWriterRow', 'readWriteRequest', 'lockWriteRequest', 'cancelWriteRow', 'readRequestEffects', 'lockPersistenceCounters'] },
    (engine) => inFreshHome(async () => {
      const keys = await admitOwn(engine);
      const answers = await Promise.all([cancel(engine, REQUEST), cancel(engine, REQUEST)]);
      const principal = await requestPrincipalForContext(remote(engine));
      const stored = await engine.readWriteRequest(principal.kind, principal.id, REQUEST);
      const result = {
        answers,
        stored: { state: stored?.state, error_code: stored?.error_code },
        outstanding: await outstanding(engine, keys),
      };
      expect(result.answers).toEqual([
        CANCELLED,
        CANCELLED,
      ]);
      expect(result.stored).toEqual({ state: 'cancelled', error_code: 'cancelled' });
      expect(result.outstanding).toEqual([0, 0]);
      return result;
    }));
});
