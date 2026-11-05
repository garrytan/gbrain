/**
 * GST-359 train C: writers that dedup by similarity never match a fact on a member page.
 *
 * 1. Protects: a member's fact lives on memory/members/<member>, readable by that member alone, with the entity kept as
 *    metadata. extract_facts' cosine dedup and the capture lanes' exact dedup read candidates by entity, so without a
 *    member-page exclusion another caller's world fact is dropped as a "duplicate" of a fact it may not read, and the
 *    reply hands it that fact's id (an existence oracle on a page its read filter hides).
 * 2. Fails when: bob-example's extract_facts reports alice-example's member fact id as its duplicate and inserts nothing,
 *    or findCaptureDuplicate matches the member fact, or member facts fill the candidate cap so a visible world
 *    duplicate is never compared (the reply then flips on how many hidden facts exist).
 * 3. Existing coverage: test/access-member-facts.test.ts pins decideSingleFact (remember) and supersession on member pages.
 * 4. Real seams: member-bound OAuth client-credentials tokens through MCP dispatch on a repo-less PGLite brain; chat and
 *    embeddings stubbed (one constant vector, so every candidate is a cosine match), a calibrated threshold set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { findCaptureDuplicate } from '../src/core/facts/capture-dedup.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const DIMS = 1536;
const VEC = (() => { const v = new Array<number>(DIMS).fill(0); v[7] = 1; return v; })();
const SRC = 'member-dedup';
const ACME = 'companies/acme-example';
const CLAIM = 'Acme Example is quietly preparing a sale to a larger harbor firm';

describe('similarity dedup never matches a member-page fact (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const tokens: Record<string, string> = {};
  let aliceFactId = '';
  const call = async (who: string, op: string, params: Record<string, unknown>) => {
    const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* prose */ }
    return { isError: out.isError === true, text, json };
  };

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, chat_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'test' } } as never);
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => VEC) })) as never);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ facts: [{ fact: CLAIM, kind: 'fact', entity: ACME, confidence: 1.0, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }) as never);
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'openai:text-embedding-3-small@1536': 0.95 }));
    await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
    for (const who of ['alice', 'bob']) {
      const c = await provider().registerClientManual('dedup-' + who + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: who + '-example' });
      tokens[who] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    }
    const saved = await call('alice', 'remember', { fact: CLAIM, entity: ACME, provenance: 'alice dm' });
    expect(saved.isError).toBe(false);
    const [row] = await engine.executeRaw<{ id: number | string }>('SELECT id FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', [SRC, 'memory/members/alice-example']);
    aliceFactId = String(row!.id);
  }, 120_000);

  afterAll(async () => { __setEmbedTransportForTests(null); __setChatTransportForTests(null); resetGateway(); await engine.disconnect(); });

  test('extract_facts saves its own world fact instead of reporting another member\'s private fact as its duplicate', async () => {
    const out = await call('bob', 'extract_facts', { turn_text: 'In our call today: ' + CLAIM + '. Worth remembering for the deal review next week.', visibility: 'world', entity_hints: [ACME] });
    expect(out.isError).toBe(false);
    expect((out.json.fact_ids ?? []).map(String)).not.toContain(aliceFactId);
    expect(out.text).not.toContain('"duplicate":1');
    const world = await engine.executeRaw('SELECT id FROM facts WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3', [SRC, 'world', ACME]);
    expect(world.length).toBe(1);
  }, 60_000);

  test('the capture lanes\' exact dedup never matches a member-page fact', async () => {
    for (const visibility of ['private', 'world'] as const) {
      const match = await findCaptureDuplicate({ engine, sourceId: SRC, lane: 'cli:extract-conversation-facts', sessionId: null, anchor: null }, { fact: CLAIM, entitySlug: ACME, visibility });
      expect(match?.id === undefined ? null : String(match.id)).not.toBe(aliceFactId);
    }
  }, 60_000);
});

const V_WORLD = (() => { const v = new Array<number>(DIMS).fill(0); v[7] = 1; v[8] = 0.2; return v; })();
const WORLD = 'Acme Example is preparing a quiet sale to a bigger harbor company';
const CROWD = ['alice-example', 'carol-example', 'dave-example', 'erin-example', 'frank-example'];

describe('member-page facts never crowd the dedup candidate cap (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const tokens: Record<string, string> = {};
  const call = async (who: string | null, op: string, params: Record<string, unknown>) => {
    const out = who === null
      ? await dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC })
      : await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth: await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo, sourceId: SRC, takesHoldersAllowList: ['world'] });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  };

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, chat_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'test' } } as never);
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(t => t.includes('bigger harbor company') ? V_WORLD : VEC) })) as never);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ facts: [{ fact: CLAIM, kind: 'fact', entity: ACME, confidence: 1.0, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }) as never);
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    for (const id of [...CROWD, 'bob-example']) await addMember(engine, id);
    await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'openai:text-embedding-3-small@1536': 0.95 }));
    await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
    for (const who of [...CROWD, 'bob-example']) {
      const c = await provider().registerClientManual('crowd-' + who + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: who });
      tokens[who] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    }
    expect((await call(null, 'remember', { fact: WORLD, entity: ACME, visibility: 'world', provenance: 'owner note' })).isError).toBe(false);
  }, 180_000);

  afterAll(async () => { __setEmbedTransportForTests(null); __setChatTransportForTests(null); resetGateway(); await engine.disconnect(); });

  test('another caller\'s extract_facts still finds the world duplicate however many member facts sit closer to the claim', async () => {
    const worldRows = async () => (await engine.executeRaw('SELECT id FROM facts WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3 AND expired_at IS NULL', [SRC, 'world', ACME])).length;
    for (const member of CROWD) {
      expect((await call(member, 'remember', { fact: CLAIM, entity: ACME, provenance: 'dm' })).isError).toBe(false);
      const out = await call('bob-example', 'extract_facts', { turn_text: 'In our call today: ' + CLAIM + '. Worth remembering.', visibility: 'world', entity_hints: [ACME] });
      expect({ member, isError: out.isError, worldRows: await worldRows() }).toEqual({ member, isError: false, worldRows: 1 });
    }
  }, 180_000);
});

const V_OLD = (() => { const v = new Array<number>(DIMS).fill(0); v[7] = 1; v[9] = 0.25; return v; })();

describe('a member updates its own facts whatever other members saved (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const tokens: Record<string, string> = {};
  const remember = async (who: string, params: Record<string, unknown>) => {
    const out = await dispatchToolCall(engine, 'remember', { provenance: 'dm', ...params }, { remote: true, transport: 'http', auth: await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo, sourceId: SRC, takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* prose */ }
    return { isError: out.isError === true, text, json };
  };
  const active = async (needle: string) => (await engine.executeRaw<{ id: number | string }>('SELECT id FROM facts WHERE source_id = $1 AND fact LIKE $2 AND expired_at IS NULL', [SRC, '%' + needle + '%'])).map(r => String(r.id));

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } } as never);
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(t => t.includes('canaryoldbob') ? V_OLD : VEC) })) as never);
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    for (const id of [...CROWD, 'bob-example']) await addMember(engine, id);
    await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'openai:text-embedding-3-small@1536': 0.95 }));
    await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
    for (const who of [...CROWD, 'bob-example']) {
      const c = await provider().registerClientManual('own-' + who + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: who });
      tokens[who] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    }
  }, 180_000);

  afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });

  test('five closer facts on other members\' pages never hide the caller\'s own earlier fact from supersession', async () => {
    expect((await remember('bob-example', { fact: 'Acme Example plans a harbor sale canaryoldbob', entity: ACME })).isError).toBe(false);
    for (const member of CROWD) expect((await remember(member, { fact: 'Acme Example plans a harbor sale soon ' + member, entity: ACME })).isError).toBe(false);
    const out = await remember('bob-example', { fact: 'Acme Example plans a harbor sale this quarter canarynewbob', entity: ACME });
    expect(out.isError).toBe(false);
    expect(await active('canaryoldbob')).toEqual([]);
    expect(await active('canarynewbob')).toHaveLength(1);
  }, 120_000);

  test('a member replaces its own fact by id', async () => {
    const saved = await remember('bob-example', { fact: 'Acme Example ships ledgers on Fridays canaryreplaceold', entity: ACME });
    expect(saved.isError).toBe(false);
    const [old] = await active('canaryreplaceold');
    const out = await remember('bob-example', { fact: 'Acme Example ships ledgers on Thursdays canaryreplacenew', entity: ACME, replaces: old });
    expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
    expect(await active('canaryreplaceold')).toEqual([]);
    expect(await active('canaryreplacenew')).toHaveLength(1);
  }, 120_000);
});
