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
 */
import { describe, expect } from 'bun:test';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOUR = 3_600_000;
const NOW = 2_000_000_000; // epoch seconds of the token window; far from the request log's real clock

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
});
