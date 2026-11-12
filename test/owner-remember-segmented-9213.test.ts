/**
 * #9213: an owner-bound remember onto a segmented entity page commits like the unbound one.
 *
 * 1. Protects: the owner's visibility checks read the page's labels, never its body, so a page stored in segments takes
 *    the fact for an explicit visibility "world" and for the default visibility.
 * 2. Fails when: the owner branch spreads the snapshot page and refuses page_body_segmented.
 * 3. Real seams: an OAuth token bound to the owner, MCP dispatch as a remote caller, PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const SRC = 'source-a';
const OWNER = 'carol-example';
const PAGE = 'companies/rules-example';

describe('owner remember onto a segmented page (#9213)', () => {
  let engine: BrainEngine;
  let auth: AuthInfo;

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    __resetPrivateVisibilityCacheForTests();
    await addMember(engine, OWNER);
    await setOwner(engine, OWNER);
    const prose = Array.from({ length: 16000 }, (_, i) => `Line ${i} of a long standing rule kept on the page so it is stored in segments.`).join('\n');
    await importFromContent(engine, PAGE, `---\ntype: company\ntitle: Rules Example\n---\n# Rules Example\n\n${prose}\n`, { sourceId: SRC });
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const c = await provider.registerClientManual('owner-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
    await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: OWNER });
    const token = (await provider.exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  }, 120_000);

  afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine?.disconnect(); });

  async function remember(extra: Record<string, unknown>) {
    const out = await dispatchToolCall(engine, 'remember', { fact: 'Standing rule ' + JSON.stringify(extra), entity: PAGE, provenance: 'test', ...extra }, {
      remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'],
    });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  }

  test('the page is stored in segments', async () => {
    const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id = $1 AND slug = $2', [SRC, PAGE]);
    expect(row?.body_storage).toBe('segmented');
  }, 120_000);

  test('an explicit visibility world is saved', async () => {
    const out = await remember({ visibility: 'world' });
    expect(out.text).not.toContain('page_body_segmented');
    expect(out.isError).toBe(false);
  }, 120_000);

  test('the default visibility is saved', async () => {
    const out = await remember({});
    expect(out.text).not.toContain('page_body_segmented');
    expect(out.isError).toBe(false);
  }, 120_000);
});
