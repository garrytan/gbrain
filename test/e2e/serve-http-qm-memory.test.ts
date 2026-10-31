/**
 * GST-359 D: memory_recall and memory_write over the real keyless `gbrain serve --http`, with a client-credentials client
 * granted the attest right by the real CLI (default attested operations) and alice-example and bob-example linked by
 * `gbrain access member link`.
 *
 * 1. Protects: QM's two tools on the production HTTP transport of a keyless brain: a committed write and its replay,
 *    recall that leads with the person's own facts and never shows another member's, the unlinked recall success
 *    (codes in structuredContent only), a write refused without an attested person, forget keyed to the own page.
 * 2. Fails when: serve-http drops structuredContent or puts the receipt in text, a replay writes twice, Bob reads or
 *    forgets Alice's fact, an unlinked recall is an error, or the write runs without x-qm-actor.
 * 3. Existing coverage: test/qm-memory-tools.test.ts pins the same behaviour through dispatch on PGLite and Postgres.
 * 4. No production seam; provider keys are removed from the server's and the CLI's environment.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test test/e2e/serve-http-qm-memory.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { addMember } from '../../src/core/access/members.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E serve-http-qm-memory tests (DATABASE_URL not set)');

const PORT = 19164;
const BASE = 'http://localhost:' + PORT;
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'oidc:3f2a:bob-example';
const KEYLESS: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/_API_(KEY|TOKEN)$/.test(k)) as Array<[string, string]>);

describeE2E('/mcp memory_recall and memory_write over keyless serve --http', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let engine: PostgresEngine;
  const tokens: Record<'qm' | 'plain', string> = { qm: '', plain: '' };
  const cli = (...args: string[]) => execFileSync('bun', ['run', 'src/cli.ts', ...args], { cwd: process.cwd(), env: KEYLESS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(async () => {
    engine = await setupDB();
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const qm = await provider.registerClientManual('qm-mem-e2e-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
    const plain = await provider.registerClientManual('qm-mem-e2e-plain-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
    expect(cli('auth', 'rescope', '--client', qm.clientId, '--attest-actor', 'qm')).toContain('attests actor: qm for memory_recall, memory_write');
    expect(cli('auth', 'rescope', '--client', qm.clientId, '--attest-actor', 'qm', '--attest-ops', 'forget,memory_recall,memory_write')).toContain('forget, memory_recall, memory_write');
    expect(cli('access', 'member', 'link', 'alice-example', '--qm', ALICE_ID)).toContain('Linked qm:' + ALICE_ID);
    expect(cli('access', 'member', 'link', 'bob-example', '--qm', BOB_ID)).toContain('-> bob-example');
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(PORT), '--public-url', BASE], {
      cwd: process.cwd(), env: KEYLESS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      try { up = (await fetch(BASE + '/health')).ok; } catch { /* not up yet */ }
      if (!up) await new Promise(r => setTimeout(r, 500));
    }
    if (!up) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
    for (const [key, c] of [['qm', qm], ['plain', plain]] as const) {
      const res = await fetch(BASE + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

  async function tool(who: 'qm' | 'plain', name: string, args: Record<string, unknown>, actor?: string) {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(actor !== undefined ? { 'x-qm-actor': actor } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const text = (await res.text()).trim();
    const parsed = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim()) as { result: Record<string, any> };
    const r = parsed.result;
    const body = (r.content as Array<{ text: string }>).map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(body); } catch { /* plain text */ }
    return { isError: r.isError === true, content: r.content, text: body, json, structured: r.structuredContent as Record<string, any> | undefined };
  }

  test('a committed write, its replay, and recall that leads with the person\'s own facts and hides the other member\'s', async () => {
    const key = randomUUID();
    const facts = [{ fact: 'Alice keeps the harbor ledger canarye2ealice', provenance: 'slack:C0123/p1' }];
    const first = await tool('qm', 'memory_write', { facts, idempotency_key: key }, ALICE_ID);
    expect(first.isError).toBe(false);
    expect(first.content).toEqual([{ type: 'text', text: 'Saved 1 fact(s).' }]);
    expect(first.structured).toMatchObject({ status: 'committed', request_id: expect.any(String), fact_ids: [expect.any(String)] });
    expect((await tool('qm', 'memory_write', { facts, idempotency_key: key }, ALICE_ID)).structured).toEqual(first.structured);
    const bobWrite = await tool('qm', 'memory_write', { facts: [{ fact: 'Bob audits the harbor ledger canarye2ebob', provenance: 'turn 1' }], idempotency_key: key }, BOB_ID);
    expect(bobWrite.structured!.request_id).not.toBe(first.structured!.request_id);
    const alice = await tool('qm', 'memory_recall', { query: 'harbor ledger' }, ALICE_ID);
    expect(alice.isError).toBe(false);
    expect(alice.text.split('\n')[0]).toMatch(/^- Alice keeps the harbor ledger canarye2ealice \(\d{4}-\d{2}-\d{2}; fact\)$/);
    expect(alice.structured).toMatchObject({ truncated: false, facts: [expect.objectContaining({ text: 'Alice keeps the harbor ledger canarye2ealice', kind: 'fact' })] });
    expect(JSON.stringify(alice)).not.toContain('canarye2ebob');
    expect(JSON.stringify(await tool('qm', 'memory_recall', { query: 'harbor ledger' }, BOB_ID))).not.toContain('canarye2ealice');
    expect(JSON.stringify(await tool('qm', 'memory_recall', { query: 'harbor ledger', max_chars: 200 }))).not.toContain('canarye2e');
  }, 60_000);

  test('an unlinked person gets an empty success; a write needs an attested person', async () => {
    const unlinked = await tool('qm', 'memory_recall', { query: 'harbor ledger' }, 'U0NOBODY');
    expect(unlinked.isError).toBe(false);
    expect(unlinked.content).toEqual([{ type: 'text', text: '' }]);
    expect(unlinked.structured).toEqual({ facts: [], truncated: false, code: 'actor_unlinked' });
    for (const [who, actor, code, reason] of [['qm', undefined, 'actor_not_attested', 'actor_required'], ['plain', ALICE_ID, 'actor_not_attested', 'no_attest_right'], ['qm', 'U0NOBODY', 'actor_unlinked', undefined]] as const) {
      const out = await tool(who, 'memory_write', { facts: [{ fact: 'x canarye2erefused', provenance: 'y' }], idempotency_key: randomUUID() }, actor);
      expect({ isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ isError: true, code, reason });
      expect(out.structured?.error).toMatchObject({ code });
    }
    expect(await engine.executeRaw("SELECT 1 FROM facts WHERE fact LIKE '%canarye2erefused%'")).toHaveLength(0);
  }, 60_000);

  test('forget withdraws only the person\'s own fact', async () => {
    const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact LIKE '%canarye2ealice%'");
    const bobTry = await tool('qm', 'forget', { id: String(row!.id) }, BOB_ID);
    expect(bobTry.isError).toBe(true);
    expect(bobTry.json.code).toBe('not_found');
    expect((await tool('qm', 'forget', { id: String(row!.id) }, ALICE_ID)).isError).toBe(false);
    expect(JSON.stringify(await tool('qm', 'memory_recall', { query: 'harbor ledger' }, ALICE_ID))).not.toContain('canarye2ealice');
    expect(JSON.stringify(await tool('qm', 'memory_recall', { query: 'harbor ledger' }, BOB_ID))).toContain('canarye2ebob');
  }, 60_000);
});
