/**
 * BrainEngine parity: the admin dashboard's counts (src/commands/serve-http-admin-api.ts: `/admin/api/stats`,
 * `/admin/api/health-indicators`, `/admin/api/agents`), through the members `countOauthAccessTokens`,
 * `countMcpRequestsLastDay` and `countMcpRequestsLastDayByToken` (engine-sql/access-credentials.ts, engine-sql/telemetry.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same stored tokens and request log rows give the same counts on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts). `countOauthAccessTokens` counts the
 *    OAuth access tokens that expire inside an inclusive window, or after a moment with no upper bound; a refresh token
 *    never counts. `countMcpRequestsLastDay` counts the last 24 hours: `all` every row, `traffic`
 *    without the `surface_change` audit rows, `errors` the traffic whose status is not a success, a success with warnings or
 *    an admitted pending write. `countMcpRequestsLastDayByToken` groups the last day per asked token and leaves a token with
 *    no request out.
 *  - Regression: a count that includes an expired or refresh token, an old request, a surface audit row, or a request of
 *    a token nobody asked for; a kind that answers differently on one engine.
 *  - Why existing coverage misses it: the admin endpoint tests (test/serve-http-admin-request-log-retention.test.ts,
 *    test/accepted-pending-status.test.ts) run on PGLite only and none compares an arm with another.
 *  - Seam: none. Real engines; rows are written through `insertOauthClient`, `insertOauthToken` and `logMcpRequest`.
 *    The pending-write case also admits write requests through `insertWriteRequest` and cancels them through the
 *    cancel_write_request handler, under a fresh GBRAIN_HOME (withEnv: the local writer registration lives there).
 *  - `readPendingWriteHealth` (engine-sql/telemetry.ts) feeds `queryHealthIndicators`: the writes still in flight and the
 *    age of the oldest, and the distinct writes an `accepted_pending` log row of the last 24 hours names that later ended
 *    without committing. Regression: the served query was raw SQL, so `/admin/api/health-indicators` failed on a Rust brain.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { queryHealthIndicators } from '../../src/commands/serve-http-admin-api.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { persistenceOperations } from '../../src/core/ops/persistence.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOUR = 3_600_000;
const NOW = 2_000_000_000; // epoch seconds of the token window; far from the request log's real clock

function remote(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/** Admits one queued put_page request of the remote caller in source default. */
async function admit(engine: BrainEngine, requestId: string, slug: string): Promise<void> {
  const principal = await requestPrincipalForContext(remote(engine));
  const source = await engine.readSourceMembership('default');
  const keys = ['brain', `principal:${principal.kind}:${principal.id}`];
  const authority = await submissionAuthority(remote(engine), 'put_page', 'default', source!.incarnation, slug);
  await engine.transaction(async (tx) => {
    await tx.lockPersistenceCounters(keys);
    await tx.insertWriteRequest({
      principalKind: principal.kind, principalId: principal.id, requestId, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug }, authority, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
  });
}

describe('engine parity: admin dashboard counts', () => {
  parityTest('an access token is counted by its expiry window; a refresh token never is',
    { methods: ['insertOauthClient', 'insertOauthToken', 'countOauthAccessTokens'] }, async engine => {
      await engine.insertOauthClient({ client_id: 'c1', client_name: 'c1', scope: 'read' });
      const put = (raw: string, type: 'access' | 'refresh', expires_at: number) =>
        engine.insertOauthToken({ token_hash: hashToken(raw), token_type: type, client_id: 'c1', scopes: ['read'], expires_at, resource: null, created_at: NOW - 10 });
      await put('expired', 'access', NOW - 1);
      await put('edge-from', 'access', NOW);
      await put('soon', 'access', NOW + 3_600);
      await put('edge-to', 'access', NOW + 86_400);
      await put('later', 'access', NOW + 86_401);
      await put('refresh', 'refresh', NOW + 60);
      const counts = {
        between: await engine.countOauthAccessTokens(NOW, NOW + 86_400),
        after: await engine.countOauthAccessTokens(NOW, null),
        afterExclusive: await engine.countOauthAccessTokens(NOW + 3_600, null),
        none: await engine.countOauthAccessTokens(NOW + 1_000_000, null),
      };
      expect(counts).toEqual({ between: 3, after: 3, afterExclusive: 2, none: 0 }); // the values themselves, not only agreement
      return counts;
    });

  parityTest('request counts cover the last 24 hours by kind and by token',
    { methods: ['logMcpRequest', 'countMcpRequestsLastDay', 'countMcpRequestsLastDayByToken'] }, async engine => {
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      const log = (token_name: string | null, operation: string, status: string, created_at: string) =>
        engine.logMcpRequest({ token_name, agent_name: null, operation, latency_ms: 1, status, created_at });
      await log('alice', 'search', 'success', at(HOUR));
      await log('alice', 'search', 'success_with_warnings', at(2 * HOUR));
      await log('alice', 'put_page', 'accepted_pending', at(3 * HOUR));
      await log('alice', 'search', 'error', at(12 * HOUR));
      await log('alice', 'search', 'error', at(3 * 24 * HOUR));
      await log('bob', 'query', 'rate_limited', at(HOUR));
      await log('bob', 'surface_change', 'error', at(HOUR));
      await log('carol', 'surface_change', 'success', at(HOUR));
      await log(null, 'query', 'success', at(HOUR));
      const counts = {
        all: await engine.countMcpRequestsLastDay('all'),
        traffic: await engine.countMcpRequestsLastDay('traffic'),
        errors: await engine.countMcpRequestsLastDay('errors'),
        byToken: await engine.countMcpRequestsLastDayByToken(['alice', 'bob', 'carol', 'nobody']),
        oneToken: await engine.countMcpRequestsLastDayByToken(['bob']),
        noNames: await engine.countMcpRequestsLastDayByToken([]),
      };
      expect(counts.all).toBe(8);
      expect(counts.traffic).toBe(6);
      expect(counts.errors).toBe(2);
      expect(counts.byToken).toEqual([{ token_name: 'alice', requests: 4 }, { token_name: 'bob', requests: 2 }, { token_name: 'carol', requests: 1 }]);
      expect(counts.noNames).toEqual([]);
      return counts;
    });

  parityTest('the health indicators count the writes in flight and the pending writes of the last day that later ended without committing',
    { methods: ['logMcpRequest', 'countMcpRequestsLastDay', 'countOauthAccessTokens', 'readPendingWriteHealth', 'insertWriteRequest', 'lockPersistenceCounters', 'cancelWriteRow'] }, async engine => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-health-'));
      try {
        return await withEnv({ GBRAIN_HOME: home }, async () => {
          const empty = await queryHealthIndicators(engine);
          await registerServeLocalWriters(engine);
          const [live, failed, old] = ['b0000000-0000-4000-8000-0000000000e1', 'b0000000-0000-4000-8000-0000000000e2', 'b0000000-0000-4000-8000-0000000000e3'];
          await admit(engine, live, 'notes/health-live');
          await admit(engine, failed, 'notes/health-failed');
          await admit(engine, old, 'notes/health-old');
          const cancel = persistenceOperations.find(o => o.name === 'cancel_write_request')!;
          for (const id of [failed, old]) await cancel.handler(remote(engine), { request_id: id });
          const at = (ms: number) => new Date(Date.now() - ms).toISOString();
          const log = (status: string, params: Record<string, unknown> | null, created_at: string) =>
            engine.logMcpRequest({ token_name: 'alice', agent_name: null, operation: 'put_page', latency_ms: 1, status, created_at, params });
          await log('accepted_pending', { write_request_id: live }, at(HOUR));
          await log('accepted_pending', { write_request_id: failed }, at(HOUR));
          await log('accepted_pending', { write_request_id: failed }, at(2 * HOUR));
          await log('success', { write_request_id: old }, at(HOUR));
          await log('accepted_pending', { write_request_id: old }, at(3 * 24 * HOUR));
          await log('accepted_pending', null, at(HOUR));
          const { oldest_pending_write_age_seconds: age, ...health } = await queryHealthIndicators(engine);
          // Not vacuous: one write is still queued, and only the cancelled write a recent pending row names counts, once.
          expect(health.pending_writes).toBe(1);
          expect(health.pending_writes_later_failed).toBe(1);
          expect(age).toBeGreaterThanOrEqual(0);
          expect(age).toBeLessThan(600);
          return { empty, health, ageIsWholeSeconds: Number.isInteger(age) };
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
