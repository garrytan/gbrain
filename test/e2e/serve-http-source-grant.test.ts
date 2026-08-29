/**
 * E2E for the /mcp SDK-transport source-grant wiring (#3242 parity; filed as
 * TODOS "chennai test debt" item (a)).
 *
 * The resolver DECISION (which callers may widen) is unit-pinned in
 * test/no-grant-federated-scope.test.ts — this suite deliberately does not
 * duplicate it. What had no pin is the TRANSPORT wiring in
 * src/commands/serve-http.ts + src/core/oauth-provider.ts:
 *
 *   verifyAccessToken (legacy access_tokens branch)
 *     → AuthInfo.hasSourceGrant (false ONLY for a legacy bearer token whose
 *       permissions.source_id is absent)
 *     → /mcp dispatch site: noGrantFederatedScope(engine, hasSourceGrant, sourceId)
 *     → OperationContext.localFederatedSourceIds
 *     → federatedSearchScope (get_page / list_pages / search / query).
 *
 * Wire-visible consequences asserted over a real `gbrain serve --http` on
 * real Postgres:
 *   - a LEGACY token WITHOUT a source grant sees exactly the set
 *     localFederatedSourceIds computes (default + federated sources; the
 *     non-federated source stays invisible);
 *   - the CONTRAST pair (anti-vacuity): a legacy token WITH an operator
 *     source grant is confined to its grant — the same federated machinery
 *     must NOT widen it, and its own grant still works.
 *
 * AuthInfo.hasSourceGrant itself is pinned at the provider construction site
 * (GBrainOAuthProvider.verifyAccessToken) — the wire cannot surface the flag,
 * only its consequences, so the flag gets a direct assertion here too.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 \
 *        bun test test/e2e/serve-http-source-grant.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getConn, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hashToken, generateToken } from '../../src/core/utils.ts';
import { localFederatedSourceIds } from '../../src/core/source-resolver.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-source-grant tests (DATABASE_URL not set)');
}

const PORT = 19143; // unique per e2e file (oauth 19131, multi-agent 19133, ingest 19138, takes-holders 19141)
const BASE = `http://localhost:${PORT}`;

// Fixture topology after setupDB (which wipes non-default sources + pages):
//   default      — the resolved anchor for a no-grant legacy token
//   e2e-sg-fed   — config.federated = true  → in the widened set
//   e2e-sg-priv  — config {}                → NOT in the widened set
const FED_SOURCE = 'e2e-sg-fed';
const PRIV_SOURCE = 'e2e-sg-priv';
const DEFAULT_PAGE = 'e2e-sg-default-page';
const FED_PAGE = 'e2e-sg-fed-page';
const PRIV_PAGE = 'e2e-sg-priv-page';

describeE2E('/mcp source-grant wiring — legacy no-grant widening vs granted confinement (#3242)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let engine: PostgresEngine;
  let noGrantToken: string;
  let grantedToken: string;
  /** The transport-side expectation, computed by the SAME resolver the /mcp
   * dispatch site calls (localFederatedSourceIds via noGrantFederatedScope). */
  let expectedFederated: string[] | undefined;

  async function insertLegacyToken(name: string, permissions: Record<string, unknown>): Promise<string> {
    const token = generateToken('gbrain_');
    // $N::text::jsonb — the sanctioned positional JSONB bind (binds as text,
    // the cast parses it); same shape as serve-http-takes-holders.test.ts.
    await getConn().unsafe(
      `INSERT INTO access_tokens (id, name, token_hash, permissions)
       VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb)`,
      [name, hashToken(token), JSON.stringify(permissions)],
    );
    return token;
  }

  beforeAll(async () => {
    engine = await setupDB();
    const conn = getConn();

    // access_tokens is not in helpers' truncate list — clear prior runs' rows
    // so the unique name constraint can't collide.
    await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'sg-e2e-%'`);

    // Normalize the seeded default source: a prior suite may have left
    // config.federated = false (which would legitimately suppress widening,
    // #2928) or archived = true. The widening anchor must be clean.
    await conn.unsafe(
      `UPDATE sources
          SET config = COALESCE(config, '{}'::jsonb) - 'federated', archived = false
        WHERE id = 'default'`,
    );

    // One federated source, one non-federated source (constant jsonb
    // literals, matching the unit fixture in no-grant-federated-scope).
    await conn.unsafe(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{"federated": true}'::jsonb)`,
      [FED_SOURCE, `/tmp/${FED_SOURCE}`],
    );
    await conn.unsafe(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      [PRIV_SOURCE, `/tmp/${PRIV_SOURCE}`],
    );

    // One page per source — the wire-visible probes.
    await engine.putPage(DEFAULT_PAGE, {
      type: 'note', title: 'SG default-source page', compiled_truth: 'Body of the default-source probe page.',
    }, { sourceId: 'default' });
    await engine.putPage(FED_PAGE, {
      type: 'note', title: 'SG federated-source page', compiled_truth: 'Body of the federated-source probe page.',
    }, { sourceId: FED_SOURCE });
    await engine.putPage(PRIV_PAGE, {
      type: 'note', title: 'SG non-federated-source page', compiled_truth: 'Body of the non-federated-source probe page.',
    }, { sourceId: PRIV_SOURCE });

    // Legacy bearer tokens. permissions WITHOUT source_id is the historical
    // no-grant floor (`gbrain auth create` writes {takes_holders:[...]});
    // permissions WITH a scalar source_id is an operator source grant.
    noGrantToken = await insertLegacyToken('sg-e2e-nogrant', { takes_holders: ['world'] });
    grantedToken = await insertLegacyToken('sg-e2e-granted', { takes_holders: ['world'], source_id: FED_SOURCE });

    // Compute the transport-side expectation with the same resolver +
    // arguments the /mcp dispatch site uses for a no-grant legacy token
    // (anchor 'default', tier 'seed_default' — see noGrantFederatedScope).
    expectedFederated = await localFederatedSourceIds(engine, 'default', 'seed_default');

    // Start the HTTP server (same pattern as serve-http-oauth.test.ts).
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 60_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    try {
      const conn = getConn();
      await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'sg-e2e-%'`);
      // Pages first (FK), then the fixture sources.
      await conn.unsafe(
        `DELETE FROM pages WHERE slug IN ($1, $2, $3)`,
        [DEFAULT_PAGE, FED_PAGE, PRIV_PAGE],
      );
      await conn.unsafe(`DELETE FROM sources WHERE id IN ($1, $2)`, [FED_SOURCE, PRIV_SOURCE]);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[afterAll] fixture cleanup failed: ${e.message}`);
    }
    await teardownDB();
  }, 30_000);

  // ── /mcp helpers (same JSON-or-SSE handling as serve-http-oauth.test.ts) ──

  function parseJsonRpc(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const dataLines = trimmed.split('\n').filter(l => l.startsWith('data:'));
    if (dataLines.length === 0) {
      throw new Error('No JSON-RPC payload in /mcp response: ' + trimmed.slice(0, 200));
    }
    return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
  }

  async function mcpToolResult(token: string, toolName: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const rpc = parseJsonRpc(await res.text());
    expect(rpc.error).toBeUndefined();
    return rpc.result;
  }

  function parseToolJson(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  // =========================================================================
  // Provider construction site — AuthInfo.hasSourceGrant
  // =========================================================================

  test('verifyAccessToken: legacy no-grant token gets hasSourceGrant === false; granted token gets true (construction-site pin)', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });

    const noGrant = (await provider.verifyAccessToken(noGrantToken)) as unknown as AuthInfo;
    // Strict === false — this is the ONLY value noGrantFederatedScope widens
    // on (undefined would mean an OAuth client and must never widen; the
    // unit suite pins that gate, this pins that the legacy branch SETS it).
    expect(noGrant.hasSourceGrant).toBe(false);
    expect(noGrant.sourceId).toBe('default'); // the historical no-grant floor
    expect(noGrant.allowedSources).toBeUndefined();

    const granted = (await provider.verifyAccessToken(grantedToken)) as unknown as AuthInfo;
    expect(granted.hasSourceGrant).toBe(true);
    expect(granted.sourceId).toBe(FED_SOURCE);
  }, 15_000);

  // =========================================================================
  // Wire: legacy no-grant token widens to exactly localFederatedSourceIds
  // =========================================================================

  test('no-grant legacy token: unqualified list_pages over /mcp spans exactly the localFederatedSourceIds set', async () => {
    // The set the transport must attach: anchor 'default' + federated
    // sources, non-federated excluded. Asserted here so a fixture regression
    // (e.g. default accidentally isolated) fails loudly, not vacuously.
    expect(expectedFederated).toEqual(['default', FED_SOURCE]);

    const result = await mcpToolResult(noGrantToken, 'list_pages');
    expect(result.isError).not.toBe(true);
    const rows: Array<{ slug: string; source_id: string }> = parseToolJson(result);

    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain(DEFAULT_PAGE);
    expect(slugs).toContain(FED_PAGE);   // the #3242 fix: federated pages visible over /mcp
    expect(slugs).not.toContain(PRIV_PAGE); // widening stops at the federated set

    // The wire-visible source list IS the resolver's list — no more, no less.
    const distinctSources = [...new Set(rows.map(r => r.source_id))].sort();
    expect(distinctSources).toEqual([...(expectedFederated ?? [])].sort());
  }, 15_000);

  test('no-grant legacy token: get_page reads the federated source\'s page but not the non-federated one', async () => {
    const found = await mcpToolResult(noGrantToken, 'get_page', { slug: FED_PAGE });
    expect(found.isError).not.toBe(true);
    const page = parseToolJson(found);
    expect(page.slug).toBe(FED_PAGE);
    expect(page.source_id).toBe(FED_SOURCE);

    const miss = await mcpToolResult(noGrantToken, 'get_page', { slug: PRIV_PAGE });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain('page_not_found');
  }, 15_000);

  // =========================================================================
  // Contrast pair (anti-vacuity): a grant-bearing legacy token is CONFINED
  // =========================================================================

  test('granted legacy token: confined to its grant — list_pages returns only the granted source, never the federated set', async () => {
    const result = await mcpToolResult(grantedToken, 'list_pages');
    expect(result.isError).not.toBe(true);
    const rows: Array<{ slug: string; source_id: string }> = parseToolJson(result);

    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain(FED_PAGE);       // its own grant works (anti-vacuity control)
    expect(slugs).not.toContain(DEFAULT_PAGE); // NOT widened to the anchor
    expect(slugs).not.toContain(PRIV_PAGE);

    const distinctSources = [...new Set(rows.map(r => r.source_id))];
    expect(distinctSources).toEqual([FED_SOURCE]);
  }, 15_000);

  test('granted legacy token: get_page misses the default-source page (confinement) yet reads its own grant (control)', async () => {
    // The granted source is ITSELF federated: true — proving the confinement
    // comes from hasSourceGrant === true suppressing the widening, not from
    // the source's federation flag.
    const miss = await mcpToolResult(grantedToken, 'get_page', { slug: DEFAULT_PAGE });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain('page_not_found');

    const found = await mcpToolResult(grantedToken, 'get_page', { slug: FED_PAGE });
    expect(found.isError).not.toBe(true);
    expect(parseToolJson(found).slug).toBe(FED_PAGE);
  }, 15_000);
});
