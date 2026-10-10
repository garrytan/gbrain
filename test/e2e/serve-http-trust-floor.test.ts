/**
 * #5575 CEO-18 / ENG-14 over the wire: a legacy bearer token carrying a
 * `min_trust` floor is held by the server on `serve --http`.
 *
 *   - search returns a full page of rows at or above the floor (the floor is
 *     applied inside the arm before LIMIT, so external rows that outrank the
 *     curated ones do not eat the slots), each labeled with trust_tier;
 *   - a caller's `min_trust=external_untrusted` cannot lower the floor;
 *   - recall and context_pack drop facts below the floor; get_page of a page
 *     below the floor answers page_not_found;
 *   - an op that cannot enforce the floor (list_pages) is refused for the
 *     floored token and served to an unfloored one.
 *
 * Run: DATABASE_URL=... bun test test/e2e/serve-http-trust-floor.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getConn, hasDatabase } from './helpers.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hashToken, generateToken } from '../../src/core/utils.ts';
import { withTrustPromotion } from '../../src/core/persistence/context.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E serve-http-trust-floor tests (DATABASE_URL not set)');

const PORT = 19157;
const BASE = `http://localhost:${PORT}`;

describeE2E('serve --http holds a token min_trust floor (#5575 CEO-18)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let flooredToken: string;
  let openToken: string;

  async function insertToken(name: string, minTrust: string | null): Promise<string> {
    const token = generateToken('gbrain_');
    await getConn().unsafe(`INSERT INTO access_tokens (id, name, token_hash, permissions, min_trust) VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb, $3)`,
      [name, hashToken(token), minTrust]);
    return token;
  }
  const setTier = (engine: BrainEngine, table: string, id: number, tier: string) =>
    engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier = $1 WHERE id = $2`, [tier, id])));

  beforeAll(async () => {
    const engine = await setupDB();
    const conn = getConn();
    await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'trust-floor-e2e-%'`);
    for (let i = 0; i < 4; i++) {
      await importFromContent(engine, `floor/external-${i}`, `---\ntitle: Quillmark external ${i}\n---\n\nquillmark quillmark quillmark external copy ${i}`, { noEmbed: true });
    }
    for (let i = 0; i < 2; i++) {
      await importFromContent(engine, `floor/curated-${i}`, `---\ntitle: Quillmark curated ${i}\n---\n\nquillmark curated note ${i}`, { noEmbed: true });
    }
    const pages = await conn.unsafe(`SELECT id, slug FROM pages WHERE slug LIKE 'floor/%'`);
    for (const p of pages) await setTier(engine, 'pages', Number(p.id), String(p.slug).includes('external') ? 'external_untrusted' : 'operator_curated');
    const low = await engine.insertFact({ fact: 'Quillmark low-trust claim', kind: 'fact', entity_slug: 'floor/curated-0', visibility: 'world', source: 'test' }, { source_id: 'default' });
    const high = await engine.insertFact({ fact: 'Quillmark curated claim', kind: 'fact', entity_slug: 'floor/curated-0', visibility: 'world', source: 'test' }, { source_id: 'default' });
    await setTier(engine, 'facts', low.id, 'unknown');
    await setTier(engine, 'facts', high.id, 'operator_curated');

    flooredToken = await insertToken('trust-floor-e2e-floored', 'operator_curated');
    openToken = await insertToken('trust-floor-e2e-open', null);

    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(PORT), '--public-url', BASE],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      try { ready = (await fetch(`${BASE}/health`)).ok; } catch { /* starting */ }
      if (!ready) await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 90_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    try { await getConn().unsafe(`DELETE FROM access_tokens WHERE name LIKE 'trust-floor-e2e-%'`); } catch { /* best effort */ }
    await teardownDB();
  }, 30_000);

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).not.toBe(401);
    return res.text();
  }

  test('search gives the floored token a full page of eligible rows; a caller cannot lower the floor', async () => {
    const open = await call(openToken, 'search', { query: 'quillmark', limit: 2 });
    expect(open).toContain('floor/external-');
    const floored = await call(flooredToken, 'search', { query: 'quillmark', limit: 2, min_trust: 'external_untrusted' });
    expect(floored).toContain('floor/curated-0');
    expect(floored).toContain('floor/curated-1');
    expect(floored).not.toContain('floor/external-');
    expect(floored).toContain('operator_curated');
  }, 20_000);

  test('recall and context_pack drop facts below the floor; get_page below it is page_not_found', async () => {
    const recall = await call(flooredToken, 'recall', { entity: 'floor/curated-0' });
    expect(recall).toContain('Quillmark curated claim');
    expect(recall).not.toContain('Quillmark low-trust claim');
    const openRecall = await call(openToken, 'recall', { entity: 'floor/curated-0' });
    expect(openRecall).toContain('Quillmark low-trust claim');
    const pack = await call(flooredToken, 'context_pack', { entities: 'floor/curated-0' });
    expect(pack).not.toContain('Quillmark low-trust claim');
    const missing = await call(flooredToken, 'get_page', { slug: 'floor/external-0' });
    expect(missing).toContain('page_not_found');
  }, 20_000);

  test('an op that cannot enforce the floor is refused for the floored token only', async () => {
    const refused = await call(flooredToken, 'list_pages', { limit: 5 });
    expect(refused).toContain('permission_denied');
    expect(refused).toContain('trust floor');
    const served = await call(openToken, 'list_pages', { limit: 5 });
    expect(served).not.toContain('permission_denied');
  }, 20_000);
});
