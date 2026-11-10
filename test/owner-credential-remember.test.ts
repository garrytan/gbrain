/**
 * 1. Protects: a credential bound to the brain owner saves a remote `remember` with the visibility it passes
 *    (world) on the entity page, as an unbound operator credential does, and can forget it.
 * 2. Fails when: the owner's fact is forced private onto memory/members/<owner>.
 * 3. Existing coverage: test/access-member-facts.test.ts pins non-owner member facts (still private).
 * 4. Real seams: OAuth client credentials, MCP dispatch, PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const SRC = 'owner-cred';
const ACME = 'companies/acme-owner';

describe('owner-bound credential remember', () => {
  let engine: PGLiteEngine;
  let token = '';
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const call = async (op: string, params: Record<string, unknown>) => {
    const out = await dispatchToolCall(engine, op, { ...params }, {
      remote: true, transport: 'http', auth: await provider().verifyAccessToken(token) as unknown as AuthInfo, sourceId: SRC, takesHoldersAllowList: ['world'],
    });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* prose */ }
    return { isError: out.isError === true, text, json };
  };

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    await addMember(engine, 'boss-example');
    await setOwner(engine, 'boss-example');
    await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Owner\n---\n# Acme Owner\n\nAcme owner builds ledgers.', { sourceId: SRC });
    const c = await provider().registerClientManual('own-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
    await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: 'boss-example' });
    token = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
  }, 120_000);

  afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });

  test("the owner's world fact stays world on its entity page and can be forgotten", async () => {
    const out = await call('remember', { fact: 'Owner fact about harbor ledgers zebra', entity: ACME, visibility: 'world', provenance: 'test' });
    expect(out.isError ? out.text : 'ok').toBe('ok');
    const rows = await engine.executeRaw<{ id: number; visibility: string; source_markdown_slug: string | null }>(
      "SELECT id, visibility, source_markdown_slug FROM facts WHERE fact LIKE '%zebra%' AND expired_at IS NULL");
    expect(rows.map(r => ({ v: r.visibility, p: r.source_markdown_slug }))).toEqual([{ v: 'world', p: expect.not.stringContaining('memory/members/') }]);
    const forgot = await call('forget', { id: String(rows[0]!.id) });
    expect(forgot.isError ? forgot.text : 'ok').toBe('ok');
  });
});
