/**
 * BrainEngine parity: the admin dashboard handlers over HTTP as `serve --http` mounts them
 * (src/commands/serve-http-admin-api.ts through `buildServeHttpApp`), on every engine arm, the Rust arm included.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm the owner signs in with the bootstrap credential (POST /admin/login), and the cookie
 *    session then reads the agents list, the counts, the health indicators, the source list and the per-client spend,
 *    changes a client's token lifetime, revokes a client (its tokens stop counting and the agents list shows it revoked),
 *    and signs out everywhere. A request with no session, a wrong owner credential and a request after sign-out are
 *    refused with 401. Every answer equals PGLite's once times and generated ids are reduced to their shape.
 *  - Regression: an admin handler that reads with raw SQL the Rust store refuses, so the dashboard answers 503 (or 500)
 *    on a Rust brain while PGLite and Postgres answer 200; a revoke or a TTL change that one engine applies differently.
 *  - Why existing coverage misses it: test/engine-parity/admin-counts.test.ts compares the members the handlers call,
 *    never the handlers; the admin endpoint tests (test/serve-http-admin-request-log-retention.test.ts,
 *    test/accepted-pending-status.test.ts, test/admin-agents-spend.test.ts) run on PGLite only.
 *  - Seam: none. Real engines and the real `buildServeHttpApp` on a loopback port; rows are written through members.
 *
 * The request list (`/admin/api/requests`) reads one filtered page of the request log and its total through
 * `readMcpRequestLogPage`: the agent, operation and status filters ('all' or none reads every row), the page, and a
 * negative page, which every engine refuses (503). The calibration routes (`/admin/api/calibration/profile`,
 * `pattern/:id`, `charts/:type`) read the latest profile, then the holder's top resolved takes
 * (`listTopResolvedTakesForHolder`) and the abandoned high-conviction takes (`listAbandonedTakes`).
 */
import { describe } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildServeHttpApp } from '../../src/commands/serve-http.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
import { getLatestProfile } from '../../src/commands/calibration.ts';
import { parityArms, seedCalibrationProfile } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A JSON answer as a caller sees it, with times and generated ids reduced to their shape. */
function shape(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => shape(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  if (typeof value === 'string' && (key.endsWith('_at') || key === 'created')) return Number.isNaN(Date.parse(value)) ? `bad time: ${value}` : 'time';
  if (typeof value === 'string' && UUID.test(value)) return 'uuid';
  if (key === 'oldest_pending_write_age_seconds' && typeof value === 'number') return value >= 0 ? 'seconds' : value;
  return value;
}

/** Serves the real admin app on a loopback port, signs the owner in, and runs `body` with a JSON-or-text GET/POST. */
async function withAdmin<T>(engine: BrainEngine, body: (call: (path: string, payload?: unknown) => Promise<{ status: number; body: unknown }>) => Promise<T>): Promise<T> {
  const app = express();
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const built = await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
    const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: built.bootstrapToken }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    if (login.status !== 200 || !cookie.startsWith('gbrain_admin=')) throw new Error(`login: ${login.status}`);
    return await body(async (path, payload) => {
      const res = await fetch(`${base}${path}`, payload === undefined ? { headers: { cookie } } : {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(payload),
      });
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: shape(json) };
    });
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  }
}

/** Ids a serial or bigserial column assigns, reduced to their type (each arm's counters start elsewhere). */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'id' ? typeof v : withoutIds(v)]));
  }
  if (typeof value === 'string') return value.replace(/\/admin\/calibration\/revisit\/\d+/g, '/admin/calibration/revisit/<id>');
  return value;
}

describe('engine parity: admin handlers over HTTP', () => {
  parityTest('the owner signs in and reads, changes and revokes through the admin API the same way on every engine; no session is 401',
    { methods: ['insertOauthClient', 'insertOauthToken', 'insertAccessToken', 'logMcpRequest', 'listOauthClients', 'listAccessTokens',
      'countOauthAccessTokens', 'countMcpRequestsLastDay', 'countMcpRequestsLastDayByToken', 'readPendingWriteHealth'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      const now = Math.floor(Date.now() / 1000);
      await engine.insertOauthClient({ client_id: 'admin-keep', client_name: 'Keep', scope: 'read write', grant_types: ['client_credentials'],
        client_secret_hash: hashToken('keep-secret'), client_secret_expires_at: 0, client_id_issued_at: 1_700_000_000,
        source_id: 'default', federated_read: ['default'] });
      await engine.insertOauthClient({ client_id: 'admin-drop', client_name: 'Drop', scope: 'read', grant_types: ['client_credentials'],
        client_secret_hash: hashToken('drop-secret'), client_secret_expires_at: 0, client_id_issued_at: 1_700_000_001 });
      const token = (raw: string, client_id: string) => engine.insertOauthToken({ token_hash: hashToken(raw), token_type: 'access', client_id,
        scopes: ['read'], expires_at: now + 3_600, resource: null, created_at: now, grant_type: 'client_credentials' });
      await token('admin-keep-token', 'admin-keep');
      await token('admin-drop-token', 'admin-drop');
      await mintLegacyToken(engine, { name: 'admin-key', scopes: ['read'], takesHolders: ['world'] });
      for (const [token_name, status] of [['admin-keep', 'success'], ['admin-keep', 'error'], ['admin-key', 'success']] as const) {
        await engine.logMcpRequest({ token_name, agent_name: null, operation: 'query', latency_ms: 1, status, created_at: new Date() });
      }

      const app = express();
      const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('expected a TCP address');
        const base = `http://127.0.0.1:${address.port}`;
        const built = await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
        let cookie = '';
        const call = async (path: string, body?: unknown) => {
          const res = await fetch(`${base}${path}`, body === undefined ? { headers: cookie ? { cookie } : {} } : {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
          });
          const text = await res.text();
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = text; }
          return { status: res.status, body: res.status === 401 ? 'unauthorized' : shape(json) };
        };
        const out: Record<string, unknown> = {};
        out.noSession = await call('/admin/api/stats');
        out.wrongOwner = (await call('/admin/login', { token: 'not-the-owner-credential-'.repeat(2) })).status;
        const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: built.bootstrapToken }) });
        cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
        out.login = { status: login.status, cookie: cookie.startsWith('gbrain_admin=') };
        out.agents = await call('/admin/api/agents');
        out.stats = await call('/admin/api/stats');
        out.health = await call('/admin/api/health-indicators');
        out.sources = await call('/admin/api/sources');
        out.spend = await call('/admin/api/agents/spend');
        out.ttl = await call('/admin/api/update-client-ttl', { clientId: 'admin-keep', tokenTtl: 600 });
        out.revoke = await call('/admin/api/revoke-client', { clientId: 'admin-drop' });
        out.agentsAfter = await call('/admin/api/agents');
        out.statsAfter = await call('/admin/api/stats');
        out.signOut = await call('/admin/api/sign-out-everywhere', {});
        out.afterSignOut = await call('/admin/api/stats');
        // Not vacuous: every read answered 200 with rows, the revoke took effect, and the session ended.
        const ok = ['agents', 'stats', 'health', 'sources', 'spend', 'ttl', 'revoke', 'agentsAfter', 'statsAfter', 'signOut']
          .filter(k => (out[k] as { status: number }).status !== 200);
        if (ok.length) throw new Error(`admin route not 200: ${ok.join(', ')}: ${JSON.stringify(out)}`);
        const stats = (out.stats as { body: Record<string, unknown> }).body;
        const after = (out.statsAfter as { body: Record<string, unknown> }).body;
        if (stats.active_tokens !== 2 || after.active_tokens !== 1 || stats.requests_today !== 3) throw new Error(`stats: ${JSON.stringify(out)}`);
        const dropped = ((out.agentsAfter as { body: Array<Record<string, unknown>> }).body).find(a => a.id === 'admin-drop');
        const kept = ((out.agentsAfter as { body: Array<Record<string, unknown>> }).body).find(a => a.id === 'admin-keep');
        if (dropped?.status !== 'revoked' || kept?.token_ttl !== 600) throw new Error(`agents after: ${JSON.stringify(out.agentsAfter)}`);
        if ((out.noSession as { status: number }).status !== 401 || out.wrongOwner !== 401 || (out.afterSignOut as { status: number }).status !== 401) {
          throw new Error(`refusals: ${JSON.stringify(out)}`);
        }
        return out;
      } finally {
        await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
      }
    });

  parityTest('the admin request list filters, pages and counts the request log the same way on every engine; a negative page is 503',
    { methods: ['logMcpRequest', 'readMcpRequestLogPage', 'getConfig', 'readMcpRollupPrunedBefore'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      const start = Date.parse('2026-11-01T00:00:00.000Z');
      const rows: Array<[string | null, string | null, string, string, number]> = [
        ['admin-key', 'agent-fork', 'search', 'success', 3],
        ['admin-key', null, 'search', 'error', 7],
        ['admin-other', null, 'get_page', 'success', 2],
        [null, null, 'search', 'auth_failed', 9],
      ];
      for (const [i, [token_name, agent_name, operation, status, latency_ms]] of rows.entries()) {
        await engine.logMcpRequest({ token_name, agent_name, operation, latency_ms, status, created_at: new Date(start + i * 1000),
          params: i === 1 ? { query: 'acme-example' } : null, error_message: status === 'error' ? 'boom' : null });
      }
      // 52 more rows, older than the four above, so the list has a second page.
      for (let i = 0; i < 52; i++) {
        await engine.logMcpRequest({ token_name: 'admin-bulk', agent_name: null, operation: 'query', latency_ms: i, status: 'success',
          created_at: new Date(start - (i + 1) * 60_000) });
      }
      return withAdmin(engine, async (call) => {
        const out: Record<string, unknown> = {};
        out.first = await call('/admin/api/requests');
        out.second = await call('/admin/api/requests?page=2');
        out.past = await call('/admin/api/requests?page=9');
        out.filtered = await call('/admin/api/requests?agent=admin-key&operation=search&status=error');
        out.byOperation = await call('/admin/api/requests?operation=search&agent=all&status=all');
        out.byStatus = await call('/admin/api/requests?status=auth_failed');
        out.notAPage = await call('/admin/api/requests?page=abc');
        out.negative = await call('/admin/api/requests?page=-1');
        // Not vacuous: the pages split the 56 rows 50 + 6, newest first, and each filter narrows the total.
        const page = (k: string) => (out[k] as { status: number; body: { rows: Array<Record<string, unknown>>; total: number; pages: number } });
        const first = page('first').body;
        if (page('first').status !== 200 || first.total !== 56 || first.pages !== 2 || first.rows.length !== 50
          || first.rows[0]!.status !== 'auth_failed' || first.rows[1]!.agent_name !== 'admin-other') throw new Error(`first page: ${JSON.stringify(out.first)}`);
        if (page('second').body.rows.length !== 6 || page('past').body.rows.length !== 0) throw new Error(`pages: ${JSON.stringify(out)}`);
        if (page('filtered').body.total !== 1 || page('byOperation').body.total !== 3 || page('byStatus').body.total !== 1) {
          throw new Error(`filters: ${JSON.stringify(out)}`);
        }
        if (page('negative').status !== 503) throw new Error(`negative page: ${JSON.stringify(out.negative)}`);
        return withoutIds(out);
      });
    });

  // The Rust arm stops on the profile read: getLatestProfile (src/commands/calibration.ts) is still raw SQL on this
  // branch, so it ends on the typed raw_sql refusal (1 stopped in rust-tally.tsv). rust-engine/main types that read
  // (a51d656180, getLatestCalibrationProfile); the stop clears at the main join, and this case is then equal on Rust.
  parityTest('the calibration admin routes read the profile, the holder\'s resolved takes and the abandoned threads the same way on every engine',
    { methods: ['putPage', 'addTakesBatch', 'resolveTake', 'getConfig', 'listTopResolvedTakesForHolder', 'listAbandonedTakes'], timeout: 120_000 },
    async (engine: BrainEngine, backend) => {
      const holder = 'alice-example';
      const pageId = async (slug: string) => (await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x' })).id;
      const bets = await pageId('calibration/bets');
      const threads = await pageId('calibration/threads');
      const take = (page_id: number, row_num: number, claim: string, weight: number, extra: Record<string, unknown> = {}) =>
        ({ page_id, row_num, claim, kind: 'bet' as const, holder, weight, ...extra });
      await engine.addTakesBatch([
        take(bets, 1, 'heaviest, dated', 0.9, { since_date: '2024-03' }),
        take(bets, 2, 'heaviest, undated', 0.9),
        take(bets, 3, 'heaviest, newer', 0.9, { since_date: '2025-06-01' }),
        take(bets, 4, 'light', 0.4, { since_date: '2026-01' }),
        take(bets, 5, 'open bet', 1),
        take(bets, 6, 'someone else', 1, { holder: 'charlie-example' }),
      ]);
      await engine.addTakesBatch([
        take(threads, 1, 'quiet for years', 0.75, { since_date: '2020-01' }),
        take(threads, 2, 'at the floor', 0.7, { since_date: '2019-01' }),
        take(threads, 3, 'quiet since mid 2023', 0.9, { since_date: '2023-06-15' }),
        take(threads, 4, 'recent', 0.9, { since_date: '2026-10' }),
        take(threads, 5, 'settled', 0.9, { since_date: '2018-01' }),
        take(threads, 6, 'replaced', 0.9, { since_date: '2018-02', superseded_by: 1 }),
        take(threads, 7, 'retired', 0.9, { since_date: '2018-03', active: false }),
        take(threads, 8, 'undated', 0.8),
      ]);
      for (const row of [1, 2, 3, 4]) await engine.resolveTake(bets, row, { quality: row === 4 ? 'incorrect' : 'correct', resolvedBy: holder });
      await engine.resolveTake(bets, 6, { quality: 'correct', resolvedBy: 'charlie-example' });
      await engine.resolveTake(threads, 5, { quality: 'correct', resolvedBy: holder });

      const before = await getLatestProfile(engine, { holder });
      if (before !== null) throw new Error(`a profile before the seed: ${JSON.stringify(before)}`);
      return withAdmin(engine, async (call) => {
        const out: Record<string, unknown> = {};
        const q = `holder=${holder}`;
        out.noProfile = await call(`/admin/api/calibration/profile?${q}`);
        out.noProfilePattern = await call(`/admin/api/calibration/pattern/1?${q}`);
        await seedCalibrationProfile(engine, backend, holder, ['You overrate speed.', 'You underrate distribution.']);
        out.profile = await call(`/admin/api/calibration/profile?${q}`);
        out.pattern = await call(`/admin/api/calibration/pattern/1?${q}`);
        out.secondPattern = await call(`/admin/api/calibration/pattern/2?${q}`);
        out.pastPatterns = await call(`/admin/api/calibration/pattern/3?${q}`);
        out.notAPattern = await call(`/admin/api/calibration/pattern/x?${q}`);
        for (const chart of ['brier-trend', 'domain-bars', 'pattern-statements', 'abandoned-threads', 'pie']) {
          out[chart] = await call(`/admin/api/calibration/charts/${chart}?${q}`);
        }
        // Not vacuous: the drill-down lists the holder's resolved takes heaviest first, a null date before a newer one,
        // and the abandoned card names the two old convictions (a stored 0.7 is below the 0.7 floor).
        const takes = ((out.pattern as { body: { takes: Array<{ claim: string; id: unknown }> } }).body.takes ?? []);
        const claims = takes.map(t => t.claim).join(' | ');
        if (claims !== 'heaviest, undated | heaviest, newer | heaviest, dated | settled | light' || takes.some(t => typeof t.id !== 'string')) {
          throw new Error(`drill-down: ${JSON.stringify(out.pattern)}`);
        }
        const card = String((out['abandoned-threads'] as { body: unknown }).body);
        if (!card.includes('quiet for years') || !card.includes('quiet since mid 2023') || card.includes('at the floor') || card.includes('settled')) {
          throw new Error(`abandoned threads: ${card}`);
        }
        const statuses = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as { status: number }).status]));
        if (JSON.stringify(statuses) !== JSON.stringify({ noProfile: 200, noProfilePattern: 404, profile: 200, pattern: 200, secondPattern: 200,
          pastPatterns: 400, notAPattern: 400, 'brier-trend': 200, 'domain-bars': 200, 'pattern-statements': 200, 'abandoned-threads': 200, pie: 400 })) {
          throw new Error(`statuses: ${JSON.stringify(statuses)}: ${JSON.stringify(out)}`);
        }
        return withoutIds(out);
      });
    });
});
