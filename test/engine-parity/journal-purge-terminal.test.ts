/**
 * BrainEngine parity — a purge cancels the queued writes that would publish a staged body holding purged content, and
 * each cancelled write keeps no copy of its intent.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: cancelRequestsHoldingStagings (persistence/intent-redaction.ts) locks the affected requests in id order,
 *    cancels each one still queued with error code `purged_content` and returns how many it cancelled; a request already
 *    terminal is left as it was. completeWrite's terminal step (persistence/journal.ts finishTerminal) then compacts the
 *    cancelled request: its intent is gone, it reads `compacted`, and its terminal reservation is released down to what
 *    the receipt keeps. The same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: both steps ran raw SQL through executeRaw (the request lock `SELECT * ... FOR UPDATE` and the
 *    compaction's `WITH effects ... UPDATE persistence_requests ...`), so on a Rust brain the purge stopped on the raw_sql
 *    refusal at the first of them.
 *    redactRequestIntents locks the affected requests through the same typed lock: a pending request refuses the purge
 *    with purge_blocked_pending_recovery and changes nothing; a page purge (skipPending) leaves it and redacts nothing.
 *  - Why existing coverage misses it: write-request-cancel.test.ts cancels through cancel_write_request, whose error code
 *    is `cancelled` and never compacts; the purge parity files stop before the journal cancel.
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
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { cancelRequestsHoldingStagings, redactRequestIntents } from '../../src/core/persistence/intent-redaction.ts';

const { parityTest } = parityArms(testBackends());

const QUEUED = 'b0000000-0000-4000-8000-0000000000d1';
const SECOND = 'b0000000-0000-4000-8000-0000000000d2';
const RESERVATION = 65536;

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-purge-cancel-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function remote(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/** Admits queued put_page requests of the remote caller in source default; returns the counter keys and the principal. */
async function admit(engine: BrainEngine, requests: Array<{ requestId: string; slug: string }>) {
  await registerServeLocalWriters(engine);
  const principal = await requestPrincipalForContext(remote(engine));
  const source = await engine.readSourceMembership('default');
  const keys = ['brain', `principal:${principal.kind}:${principal.id}`];
  for (const { requestId, slug } of requests) {
    const authority = await submissionAuthority(remote(engine), 'put_page', 'default', source!.incarnation, slug);
    await engine.transaction(async (tx) => {
      await tx.lockPersistenceCounters(keys);
      await tx.insertWriteRequest({
        principalKind: principal.kind, principalId: principal.id, requestId, operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
        digest: 'd'.repeat(64), intent: { kind: 'put_page', slug, body: 'a staged body that holds purged content' }, authority,
        intentBytes: 200, terminalReservation: RESERVATION, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity',
        admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
      });
    });
  }
  return { keys, principal };
}

/** The stored request without its generated values. */
async function stored(engine: BrainEngine, principal: { kind: string; id: string }, requestId: string) {
  const row = await engine.readWriteRequest(principal.kind as never, principal.id, requestId);
  return row && {
    state: row.state, error_code: row.error_code, intent: row.intent, compacted: row.compacted,
    shrunk: Number(row.terminal_reservation) < RESERVATION,
  };
}

describe('engine parity: a purge cancels the writes that would publish purged content', () => {
  parityTest('the queued writes are cancelled with purged_content in id order and keep no copy of their intent; a terminal one is left',
    { methods: ['readLocalWriterRow', 'insertWriteRequest', 'readWriteRequest', 'lockWriteRequest', 'completeWriteRow', 'lockPersistenceCounters', 'readCounterRows', 'transaction'] },
    (engine) => inFreshHome(async () => {
      const { keys, principal } = await admit(engine, [{ requestId: SECOND, slug: 'notes/second' }, { requestId: QUEUED, slug: 'notes/first' }]);
      const ids = await Promise.all([QUEUED, SECOND].map(async (r) => (await engine.readWriteRequest(principal.kind as never, principal.id, r))!.id));
      const targets = ids.map((id) => ({ id, principal_kind: principal.kind, principal_id: principal.id }));
      const before = (await engine.readCounterRows(keys)).map((r) => Number(r.outstanding_count));
      const cancelled = await engine.transaction((tx) => cancelRequestsHoldingStagings(tx, targets));
      const after = (await engine.readCounterRows(keys)).map((r) => Number(r.outstanding_count));
      // A second purge over the same requests finds both terminal and cancels nothing.
      const again = await engine.transaction((tx) => cancelRequestsHoldingStagings(tx, targets));
      const result = {
        cancelled, again, before, after,
        first: await stored(engine, principal, QUEUED),
        second: await stored(engine, principal, SECOND),
      };
      const done = { state: 'cancelled', error_code: 'purged_content', intent: null, compacted: true, shrunk: true };
      expect(result as unknown).toEqual({ cancelled: 2, again: 0, before: [2, 2], after: [0, 0], first: done, second: done });
      return result;
    }));
  parityTest('a purge that meets a pending write refuses before redacting, and a page purge leaves the pending write',
    { methods: ['readLocalWriterRow', 'insertWriteRequest', 'readWriteRequest', 'lockPersistenceCounters', 'transaction'] },
    (engine) => inFreshHome(async () => {
      const { principal } = await admit(engine, [{ requestId: QUEUED, slug: 'notes/first' }]);
      const id = (await engine.readWriteRequest(principal.kind as never, principal.id, QUEUED))!.id;
      const targets = [{ id, principal_kind: principal.kind, principal_id: principal.id }];
      let refused: unknown = null;
      try { await engine.transaction((tx) => redactRequestIntents(tx, targets)); }
      catch (error) { refused = (error as { code?: unknown }).code ?? String(error); }
      const skipped = await engine.transaction((tx) => redactRequestIntents(tx, targets, undefined, { skipPending: true }));
      const row = await engine.readWriteRequest(principal.kind as never, principal.id, QUEUED);
      const result = { refused, skipped, left: { state: row?.state, compacted: row?.compacted, intent: row?.intent !== null } };
      expect(result as unknown).toEqual({ refused: 'purge_blocked_pending_recovery', skipped: 0, left: { state: 'queued', compacted: false, intent: true } });
      return result;
    }));
});
