/**
 * GBRA-231 shared agents over the real `gbrain serve --http` (serve-http-mcp.ts): one bot token whose
 * may_act_for lists two members reads, per call, only what the asserted audience may read, from the
 * X-Gbrain-On-Behalf-Of header or request-level _meta.on_behalf_of, and every response names that view in
 * _meta.access.
 *
 * 1. Protects: the shared-agent read boundary on the production HTTP transport, not only dispatch.
 * 2. Fails when: serve-http drops the header or request _meta, a call reuses another call's audience, an
 *    audience outside may_act_for reads anything, or _meta.access is missing.
 * 3. Existing coverage: test/access-on-behalf-of.test.ts pins dispatch and the legacy bearer transport.
 * 4. No production seam.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test test/e2e/serve-http-on-behalf-of.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E serve-http-on-behalf-of tests (DATABASE_URL not set)');

const PORT = 19162;
const BASE = `http://localhost:${PORT}`;
const PAGES = {
  alice: { slug: 'notes/obo-alice', readers: '[alice-example]', canary: 'canaryoboealice' },
  bob: { slug: 'notes/obo-bob', readers: '[bob-example]', canary: 'canaryoboebob' },
  both: { slug: 'notes/obo-both', readers: '[alice-example, bob-example]', canary: 'canaryoboeboth' },
} as const;
type Key = keyof typeof PAGES;

describeE2E('/mcp shared agent on_behalf_of over serve --http', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let engine: PostgresEngine;
  let bot = '';

  beforeAll(async () => {
    engine = await setupDB();
    for (const id of ['alice-example', 'bob-example', 'dan-example']) await addMember(engine, id);
    for (const key of Object.keys(PAGES) as Key[]) {
      const p = PAGES[key];
      const out = await importFromContent(engine, p.slug, `---\ntype: note\nreadable_by: ${p.readers}\n---\n# Harbor plan ${key}\n\nHarbor plan notes ${p.canary}.`, { noEmbed: true });
      expect(out.status).toBe('imported');
    }
    const minted = await mintLegacyToken(engine, { name: 'obo-e2e-bot', takesHolders: ['world'], scopes: ['read'] });
    bot = minted.token;
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'dan-example', mayActFor: ['member:alice-example', 'member:bob-example', 'guest'] });
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(PORT), '--public-url', BASE], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 60_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    await teardownDB();
  }, 30_000);

  async function call(slug: string, ch: { header?: string; meta?: string[] }): Promise<{ text: string; meta: Record<string, unknown> | undefined }> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bot}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(ch.header !== undefined ? { 'X-Gbrain-On-Behalf-Of': ch.header } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_page', arguments: { slug }, ...(ch.meta ? { _meta: { on_behalf_of: ch.meta } } : {}) } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.text()).trim();
    const rpc = JSON.parse(body.startsWith('{') ? body : body.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim());
    expect(rpc.error).toBeUndefined();
    return { text: rpc.result.content.map((c: { text: string }) => c.text).join('\n'), meta: rpc.result._meta };
  }
  const reads = async (ch: { header?: string; meta?: string[] }) => {
    const seen: Key[] = [];
    for (const key of Object.keys(PAGES) as Key[]) if ((await call(PAGES[key].slug, ch)).text.includes(PAGES[key].canary)) seen.push(key);
    return seen;
  };

  test('each call reads as its own audience, from the header or request _meta, and names it in _meta.access', async () => {
    expect(await reads({})).toEqual([]);
    expect(await reads({ header: 'alice-example' })).toEqual(['alice', 'both']);
    expect(await reads({ meta: ['bob-example'] })).toEqual(['bob', 'both']);
    expect(await reads({ header: 'alice-example,bob-example' })).toEqual(['both']);
    expect(await reads({ header: 'guest' })).toEqual([]);
    const named = await call(PAGES.both.slug, { header: 'alice-example, bob-example' });
    expect((named.meta?.access as Record<string, unknown>).audience).toEqual(['member:alice-example', 'member:bob-example']);
    expect((named.meta?.access as Record<string, unknown>).member).toBeNull();
  }, 60_000);

  test('an audience outside may_act_for reads nothing and names the operator command', async () => {
    const out = await call(PAGES.alice.slug, { header: 'alice-example, eve-example' });
    expect(out.text).toContain('on_behalf_of_not_permitted');
    expect(out.text).toContain('gbrain auth rescope --token obo-e2e-bot');
    expect(out.text).not.toContain(PAGES.alice.canary);
  }, 30_000);
});
