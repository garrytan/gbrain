/**
 * GST-359 C1: the attested actor over the real `gbrain serve --http` (serve-http-mcp.ts), with a client-credentials
 * client granted the attest right and person links made by the real CLI (`gbrain auth rescope --attest-actor`,
 * `gbrain access member link`).
 *
 * 1. Protects: the x-qm-actor boundary on the production HTTP transport, not only dispatch: the header reaches
 *    dispatch on tools/call, initialize accepts and ignores it on a stateless server (no Mcp-Session-Id) and carries
 *    serverInfo.description, and every outcome row of the actor table answers as specified with structuredContent.
 * 2. Fails when: serve-http drops the header, a client without the right reads with it, an argument changes the
 *    person, an unlinked id reads anything, initialize issues a session id, or the CLI grant or link does not persist.
 * 3. Existing coverage: test/access-qm-actor.test.ts pins dispatch, publication, jobs and the legacy bearer transport.
 * 4. No production seam.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test test/e2e/serve-http-qm-actor.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { addMember } from '../../src/core/access/members.ts';
import { MCP_SERVER_DESCRIPTION } from '../../src/mcp/instructions.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E serve-http-qm-actor tests (DATABASE_URL not set)');

const PORT = 19163;
const BASE = `http://localhost:${PORT}`;
const PAGES = {
  alice: { slug: 'notes/qm-e2e-alice', readers: '[alice-example]', canary: 'canaryqmealice' },
  bob: { slug: 'notes/qm-e2e-bob', readers: '[bob-example]', canary: 'canaryqmebob' },
} as const;
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'oidc:3f2a:bob-example';

describeE2E('/mcp attested actor (x-qm-actor) over serve --http', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let engine: PostgresEngine;
  const tokens: Record<'qm' | 'plain', string> = { qm: '', plain: '' };
  let qmClientId = '';
  let plainClientId = '';
  const cli = (...args: string[]) => execFileSync('bun', ['run', 'src/cli.ts', ...args], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(async () => {
    engine = await setupDB();
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    for (const p of Object.values(PAGES)) {
      const out = await importFromContent(engine, p.slug, `---\ntype: note\nreadable_by: ${p.readers}\n---\n# Harbor plan\n\nHarbor plan notes ${p.canary}.`, { noEmbed: true });
      expect(out.status).toBe('imported');
    }
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const qm = await provider.registerClientManual('qm-e2e-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], 'default');
    const plain = await provider.registerClientManual('qm-e2e-plain-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], 'default');
    qmClientId = qm.clientId;
    plainClientId = plain.clientId;
    expect(cli('auth', 'rescope', '--client', qmClientId, '--attest-actor', 'qm', '--attest-ops', 'get_page,search')).toContain('attests actor: qm for get_page, search');
    expect(cli('access', 'member', 'link', 'alice-example', '--qm', ALICE_ID)).toContain('Linked qm:' + ALICE_ID);
    expect(cli('access', 'member', 'link', 'bob-example', '--qm', BOB_ID)).toContain('-> bob-example');
    expect(JSON.parse(cli('access', 'member', 'links', '--json')).links.length).toBe(2);
    expect(() => cli('access', 'member', 'link', 'alice-example', '--qm', 'L'.repeat(257))).toThrow(/invalid_external_id|access_member_invalid/);
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(PORT), '--public-url', BASE], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await new Promise(r => setTimeout(r, 500));
    }
    if (!up) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
    for (const [key, c] of [['qm', qm], ['plain', plain]] as const) {
      const res = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret! }) });
      expect(res.status).toBe(200);
      tokens[key] = (await res.json() as { access_token: string }).access_token;
    }
  }, 90_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    await teardownDB();
  }, 30_000);

  async function rpc(who: 'qm' | 'plain', body: Record<string, unknown>, actor?: string) {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(actor !== undefined ? { 'x-qm-actor': actor } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    });
    expect(res.status).toBe(200);
    const text = (await res.text()).trim();
    const parsed = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim());
    return { res, rpc: parsed as { result: Record<string, any>; error?: unknown } };
  }
  const get = async (who: 'qm' | 'plain', slug: string, actor?: string, args: Record<string, unknown> = {}) => {
    const { rpc: out } = await rpc(who, { method: 'tools/call', params: { name: 'get_page', arguments: { slug, ...args } } }, actor);
    expect(out.error).toBeUndefined();
    return { text: (out.result.content as Array<{ text: string }>).map(c => c.text).join('\n'), structured: out.result.structuredContent, meta: out.result._meta, isError: out.result.isError === true };
  };

  test('initialize accepts the header, issues no Mcp-Session-Id, and carries serverInfo.description', async () => {
    const { res, rpc: out } = await rpc('qm', { method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qm-e2e', version: '1' } } }, ALICE_ID);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(out.result.serverInfo).toMatchObject({ name: 'gbrain', description: MCP_SERVER_DESCRIPTION });
    expect(typeof out.result.instructions).toBe('string');
  }, 30_000);

  test('each call reads as the linked member; without the header the client reads no restricted page', async () => {
    expect((await get('qm', PAGES.alice.slug, ALICE_ID)).text).toContain(PAGES.alice.canary);
    expect((await get('qm', PAGES.bob.slug, ALICE_ID)).text).not.toContain(PAGES.bob.canary);
    expect((await get('qm', PAGES.bob.slug, BOB_ID)).text).toContain(PAGES.bob.canary);
    expect((await get('qm', PAGES.alice.slug)).text).not.toContain(PAGES.alice.canary);
    const named = await get('qm', PAGES.alice.slug, ALICE_ID, { acting_user: ALICE_ID });
    expect(named.text).toContain(PAGES.alice.canary);
    expect(named.meta?.access).toMatchObject({ member: 'alice-example', audience: ['member:alice-example'], actor: { system: 'qm' } });
  }, 60_000);

  test('every refusal row answers with its code and reason in the text block and structuredContent', async () => {
    const cases: Array<[Promise<Awaited<ReturnType<typeof get>>>, string, string | undefined]> = [
      [get('plain', PAGES.alice.slug, ALICE_ID), 'actor_not_attested', 'no_attest_right'],
      [rpc('qm', { method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, ALICE_ID).then(({ rpc: o }) => ({ text: o.result.content[0].text, structured: o.result.structuredContent, meta: undefined, isError: true })), 'actor_not_attested', 'op_not_attested'],
      [get('qm', PAGES.alice.slug, ALICE_ID, { acting_user: BOB_ID }), 'actor_not_attested', 'argument_mismatch'],
      [get('qm', PAGES.alice.slug, undefined, { acting_user: ALICE_ID }), 'actor_not_attested', 'argument_without_attestation'],
      [get('qm', PAGES.alice.slug, 'L'.repeat(257)), 'actor_not_attested', 'invalid_actor_id'],
      [get('qm', PAGES.alice.slug, 'u0alice'), 'actor_unlinked', undefined],
    ];
    for (const [pending, code, reason] of cases) {
      const out = await pending;
      const json = JSON.parse(out.text);
      expect({ code: json.code, reason: json.reason }).toEqual({ code, reason });
      expect(out.structured.error).toMatchObject({ code, ...(reason ? { reason } : {}) });
      expect(out.text).not.toContain(PAGES.alice.canary);
    }
    const fix = (await get('plain', PAGES.alice.slug, ALICE_ID)).structured.error.fix;
    expect(fix.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', plainClientId, '--attest-actor', 'qm']);
  }, 60_000);

  test('under the header tools/list lists only the attested operations and resources/read refuses', async () => {
    const list = async (actor?: string) => ((await rpc('qm', { method: 'tools/list', params: {} }, actor)).rpc.result.tools as Array<{ name: string }>).map(t => t.name).sort();
    expect(await list(ALICE_ID)).toEqual(['get_page', 'search']);
    const plainList = await list();
    expect(plainList).toContain('get_page');
    expect(plainList.length).toBeGreaterThan(2);
    const read = async (actor?: string) => (await rpc('qm', { method: 'resources/read', params: { uri: 'gbrain://capabilities' } }, actor)).rpc as { result?: { contents: unknown[] }; error?: { message: string; data?: { code?: string } } };
    const refused = await read(ALICE_ID);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.data?.code).toBe('actor_not_attested');
    expect((await read()).result?.contents.length).toBe(1);
  }, 60_000);

  test('unlinking with the CLI refuses the next call', async () => {
    expect(cli('access', 'member', 'unlink', '--qm', BOB_ID, '--dry-run')).toContain('Would unlink');
    expect((await get('qm', PAGES.bob.slug, BOB_ID)).text).toContain(PAGES.bob.canary);
    cli('access', 'member', 'unlink', '--qm', BOB_ID);
    const out = await get('qm', PAGES.bob.slug, BOB_ID);
    expect(out.structured.error.code).toBe('actor_unlinked');
    expect(out.text).not.toContain(PAGES.bob.canary);
    expect(qmClientId).not.toBe('');
  }, 60_000);
});
