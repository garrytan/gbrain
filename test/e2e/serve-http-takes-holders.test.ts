/**
 * E2E regression for #2529: `serve --http` honors a legacy bearer token's
 * stored `access_tokens.permissions.takes_holders` grant end-to-end.
 *
 * The seam under test — verifyAccessToken (oauth-provider.ts legacy branch)
 * → AuthInfo.takesHoldersAllowList → /mcp dispatch → engine holder filter —
 * had NO end-to-end pin before this file; that absence is how #2529 shipped
 * (the OAuth provider never read the grant, so every remote caller was
 * pinned to ['world'] regardless of what the operator configured).
 *
 * Spins up a real `gbrain serve --http` against real Postgres, seeds a page
 * with a brain-held and a world-held take, inserts legacy tokens with three
 * different grants directly (the same rows `gbrain auth create/permissions`
 * writes), and asserts `takes_list` over POST /mcp filters per grant:
 *
 *   ['world','brain'] → sees both takes
 *   ['world']         → world take only (brain take invisible)
 *   []                → explicit deny-all: sees neither
 *
 * Run: DATABASE_URL=... bun test test/e2e/serve-http-takes-holders.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getConn, hasDatabase } from './helpers.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hashToken, generateToken } from '../../src/core/utils.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-takes-holders tests (DATABASE_URL not set)');
}

const PORT = 19141; // unique per e2e file — avoid collision with serve-http-oauth (19131)
const BASE = `http://localhost:${PORT}`;

const BRAIN_CLAIM = 'brain-held regression claim for issue 2529';
const WORLD_CLAIM = 'world-held regression claim for issue 2529';

describeE2E('serve --http honors permissions.takes_holders for legacy bearer tokens (#2529)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let fullToken: string;
  let worldToken: string;
  let denyAllToken: string;
  let noGrantToken: string;

  async function insertLegacyToken(name: string, takesHolders: string[]): Promise<string> {
    const token = generateToken('gbrain_');
    const conn = getConn();
    await conn.unsafe(
      `INSERT INTO access_tokens (id, name, token_hash, permissions)
       VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb)`,
      [name, hashToken(token), JSON.stringify({ takes_holders: takesHolders })],
    );
    return token;
  }

  // A token whose permissions carry NO takes_holders key — the shape an
  // OAuth-client token or a pre-`set-takes-holders` legacy token has. The
  // dispatch site must coalesce the undefined grant to the fail-closed
  // ['world'] default over the wire (serve-http.ts `?? ['world']`).
  async function insertNoGrantToken(name: string): Promise<string> {
    const token = generateToken('gbrain_');
    await getConn().unsafe(
      `INSERT INTO access_tokens (id, name, token_hash, permissions)
       VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb)`,
      [name, hashToken(token)],
    );
    return token;
  }

  beforeAll(async () => {
    const engine = await setupDB();
    const conn = getConn();

    // access_tokens is not in helpers' truncate list — clear prior runs' rows
    // so the unique name constraint can't collide.
    await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'takes-e2e-%'`);

    // Seed a page + two takes (one per holder tier).
    await importFromContent(engine, 'e2e/takes-regression', '# Takes Regression\n\nSeed page for #2529.', { noEmbed: true });
    const [page] = await conn.unsafe(`SELECT id FROM pages WHERE slug = 'e2e/takes-regression'`);
    await engine.addTakesBatch([
      { page_id: page.id as number, row_num: 1, claim: BRAIN_CLAIM, kind: 'take', holder: 'brain', weight: 0.75, active: true, superseded_by: null },
      { page_id: page.id as number, row_num: 2, claim: WORLD_CLAIM, kind: 'take', holder: 'world', weight: 0.5, active: true, superseded_by: null },
    ]);

    // Legacy bearer tokens with three grant shapes — the same permissions
    // rows `gbrain auth create --takes-holders` / `set-takes-holders` write.
    fullToken = await insertLegacyToken('takes-e2e-full', ['world', 'brain']);
    worldToken = await insertLegacyToken('takes-e2e-world', ['world']);
    denyAllToken = await insertLegacyToken('takes-e2e-denyall', []);
    noGrantToken = await insertNoGrantToken('takes-e2e-nogrant');

    // Start the HTTP server (same pattern as serve-http-oauth.test.ts).
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
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
      await getConn().unsafe(`DELETE FROM access_tokens WHERE name LIKE 'takes-e2e-%'`);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[afterAll] token cleanup failed: ${e.message}`);
    }
    await teardownDB();
  }, 30_000);

  async function takesListBody(token: string): Promise<string> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'takes_list', arguments: {} },
      }),
    });
    expect(res.status).not.toBe(401);
    return res.text();
  }

  // The MCP transport can answer as JSON or SSE (text/event-stream). Assert
  // the body carries a successful tool result, not a JSON-RPC error envelope,
  // so a negative-only content check can't pass vacuously on a broken pipeline.
  function expectToolResultOk(body: string): void {
    expect(body).toContain('"result"');
    expect(body).not.toContain('"error"');
  }

  test("['world','brain'] grant sees the brain-held take (the #2529 repro)", async () => {
    const body = await takesListBody(fullToken);
    expect(body).toContain(BRAIN_CLAIM);
    expect(body).toContain(WORLD_CLAIM);
  }, 15_000);

  test("['world'] grant sees only world-held takes — brain take stays invisible", async () => {
    const body = await takesListBody(worldToken);
    expect(body).toContain(WORLD_CLAIM);
    expect(body).not.toContain(BRAIN_CLAIM);
  }, 15_000);

  test('[] grant is explicit deny-all — sees neither take (not silently world)', async () => {
    const body = await takesListBody(denyAllToken);
    expectToolResultOk(body); // a successful empty result, not an error envelope
    expect(body).not.toContain(BRAIN_CLAIM);
    expect(body).not.toContain(WORLD_CLAIM);
  }, 15_000);

  test('no takes_holders grant → fail-closed to world-only over the wire (?? default)', async () => {
    // Pins serve-http.ts `authInfo.takesHoldersAllowList ?? ['world']`: an
    // undefined grant (OAuth clients, pre-set-takes-holders legacy tokens)
    // must see world-held takes and NOT brain-held ones through /mcp dispatch.
    const body = await takesListBody(noGrantToken);
    expect(body).toContain(WORLD_CLAIM);
    expect(body).not.toContain(BRAIN_CLAIM);
  }, 15_000);
});
