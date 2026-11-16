/**
 * #9266: under `mcp.default_surface_dcr = starter`, the server gives a legacy
 * bearer token the server ceiling (it has no oauth_clients row to pre-seed)
 * and gives a NULL-surface OAuth client the starter default. The doctor
 * `grant_new_ops_available` check and the advisor `mcp-client-fit` collector
 * must give the same answer. The server side is pinned over real HTTP by
 * test/e2e/mcp-legacy-token-dcr-surface-9266.test.ts.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { checkGrantNewOps } from '../src/commands/doctor/checks/grant-new-ops.ts';
import { collectMcpClientFit, __setUsageNagStatePathForTests, MIN_CALLS_FOR_FIT } from '../src/core/advisor/collect-mcp-client-fit.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
let nagDir: string;
const cfg = { engine: 'pglite' } as any;
const OPS = ['whoami', 'add_link'];

type Finding = { kind: string; id: string; name: string; blockers: Array<Record<string, unknown>>; excluded_operations: { server_ceiling: string[] } };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  nagDir = mkdtempSync(join(tmpdir(), 'gbrain-9266-nag-'));
  __setUsageNagStatePathForTests(join(nagDir, 'nag.json'));
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  await engine.setConfig('mcp.default_surface_dcr', 'starter');
  await mintLegacyToken(engine, { name: 'legacy-a', scopes: ['read', 'write'], takesHolders: ['world'], allowedOperations: OPS });
  await provider.registerClientManual('oauth-a', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
    { allowedOperations: OPS });
  for (let i = 0; i < MIN_CALLS_FOR_FIT + 5; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status) VALUES ('legacy-a', 'legacy-a', 'whoami', 5, 'success')`);
  }
}, 60_000);

afterAll(async () => {
  __setUsageNagStatePathForTests(null);
  await engine?.disconnect();
  rmSync(nagDir, { recursive: true, force: true });
}, 15_000);

describe('#9266 doctor and advisor agree with the server for a legacy token under the starter default', () => {
  test('doctor grant_new_ops: the token keeps the server ceiling, the NULL-surface client gets the starter default', async () => {
    const check = await checkGrantNewOps(engine, { cfg });
    const found = (check.details?.grants ?? []) as Finding[];
    const token = found.find(f => f.kind === 'legacy_token' && f.name === 'legacy-a')!;
    const client = found.find(f => f.kind === 'oauth_client' && f.name === 'oauth-a')!;
    expect(check.details?.server_surface).toBe('full');

    expect(token).toBeDefined();
    expect(token.excluded_operations.server_ceiling).toEqual([]);
    expect(token.blockers.map(b => b.blocker)).not.toContain('server_ceiling');

    expect(client).toBeDefined();
    expect(client.excluded_operations.server_ceiling).toContain('add_link');
    expect(client.blockers).toContainEqual(expect.objectContaining({ blocker: 'server_ceiling', surface: 'starter' }));
  });

  test('advisor mcp-client-fit proposes no client rescope for the legacy token', async () => {
    const ctx: AdvisorContext = { engine, config: {} as AdvisorContext['config'], version: '0.0.0.0', workspace: null, skillsDir: null, now: new Date(), remote: false };
    const findings = await collectMcpClientFit.collect(ctx);
    expect(findings.map(f => f.id)).not.toContain('mcp_starter_fit:legacy-a');
    expect(JSON.stringify(findings)).not.toContain('rescope-client legacy-a');
  });
});
