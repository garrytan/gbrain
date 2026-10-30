/**
 * GBRA-156: every vector path of `search` and `query` reads exactly the source
 * scope the keyword path reads, for a remote caller.
 *
 * 1. Protects: a token's grant (default floor plus federated sources, a
 *    scalar OAuth binding, a multi-source grant, no grant at all) and the
 *    per-call `source_id` / `source_ids` narrowing hold on the hybrid vector
 *    arm, the embed-failure keyword fallback (searchVectorFallback), the
 *    no-provider keyword path, `match: "keyword"`, query's text path and
 *    query's image branch, not only on keyword search.
 * 2. Fails when: any path returns a page from a source outside the caller's
 *    scope, or a path misses a source the caller may read (every page is
 *    equally similar to the query, so a correct path returns them all).
 * 3. Existing coverage: keyword search under member grants
 *    (e2e/serve-http-member-tokens), local federation
 *    (local-federated-search-scope); none drove the vector arm, the vector
 *    fallback, the no-provider path or the image branch under each grant.
 * 4. No production seam: the production serve-http app and real tokens; the
 *    embedding providers are a deterministic in-process transport and a
 *    loopback stand-in for the multimodal endpoint.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { callTool, clientCredentialsToken, envelopeOf, legacyToken, ownerCookie, registerOAuthClient, startServeHttp, type LiveServeHttp, type ToolResultWire } from './helpers/live-mcp-servers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SOURCES = ['default', 'source-a', 'source-b', 'source-c'] as const;
const FEDERATED = 'source-a';
const QUERY = 'quillmarsh ledger';
// Matches no page lexically, so only the vector arm can return a row.
const VECTOR_QUERY = 'saltpan orbit';
const TEXT_VEC = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0.01));
const IMAGE_VEC = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0.01));
const IMAGE = Buffer.from('fixture image bytes').toString('base64');

type Provider = 'vector' | 'embed_fails' | 'no_provider';

let voyage: ReturnType<typeof Bun.serve>;

function useProvider(provider: Provider): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    base_urls: { voyage: `http://127.0.0.1:${voyage.port}/v1` },
    env: provider === 'no_provider' ? {} : { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'vk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => {
    if (provider === 'embed_fails') throw new Error('embedding provider unavailable (fixture)');
    return { embeddings: args.values.map(() => TEXT_VEC) } as any;
  });
}

function sourcesOf(out: ToolResultWire): string[] {
  const rows = JSON.parse(out.content[0]!.text) as Array<{ slug: string }>;
  return [...new Set(rows.map(r => r.slug.split('/')[1]!.replace(/^(?:note|image)-/, '')))].sort();
}

for (const kind of testBackends()) {
  describe(`vector paths read the keyword path's source scope (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let serve: LiveServeHttp;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      voyage = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
        const body = await req.json() as { inputs?: unknown[]; documents?: unknown[] };
        if (new URL(req.url).pathname.endsWith('/rerank')) {
          return Response.json({ data: (body.documents ?? []).map((_, index) => ({ index, relevance_score: 0.5 })), usage: { total_tokens: 1 } });
        }
        return Response.json({ data: (body.inputs ?? []).map(() => ({ embedding: IMAGE_VEC })), usage: { total_tokens: 1 } });
      } });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of SOURCES.slice(1)) {
        await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb) ON CONFLICT (id) DO NOTHING`,
          [id, JSON.stringify(id === FEDERATED ? { federated: true } : {})]);
      }
      for (const sourceId of SOURCES) {
        const text = `The quillmarsh ledger kept by ${sourceId}.`;
        await engine.putPage(`notes/note-${sourceId}`, { type: 'note', title: `Ledger ${sourceId}`, compiled_truth: text, timeline: '' }, { sourceId });
        await installFixtureChunks(engine, `notes/note-${sourceId}`, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: new Float32Array(TEXT_VEC), modality: 'text' }], { sourceId });
        await engine.putPage(`photos/image-${sourceId}`, { type: 'image', page_kind: 'image', title: `Photo ${sourceId}`, compiled_truth: '', timeline: '' } as never, { sourceId });
        await installFixtureChunks(engine, `photos/image-${sourceId}`, [{ chunk_index: 0, chunk_text: `photo ${sourceId}`, chunk_source: 'image_asset', embedding_image: new Float32Array(IMAGE_VEC), modality: 'image' } as never], { sourceId });
      }
      serve = await startServeHttp(engine, { surface: 'full' });
      tokens.floor = await legacyToken(engine, ['read']);
      tokens.granted = (await mintLegacyToken(engine, { name: 'granted-bc', takesHolders: ['world'], scopes: ['read'], sourceGrant: ['source-b', 'source-c'] })).token;
      tokens.none = (await mintLegacyToken(engine, { name: 'granted-none', takesHolders: ['world'], scopes: ['read'], sourceGrant: [] })).token;
      const client = await registerOAuthClient(serve, await ownerCookie(serve), 'read');
      tokens.oauth = await clientCredentialsToken(serve, client.clientId, client.clientSecret, 'read');
    }, 180_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await serve?.close();
      await close?.();
      voyage?.stop(true);
    }, 60_000);

    // Each case: the token, the per-call scope params, and the sources it must read (null: refused).
    const CASES: Array<{ name: string; token: string; scope: Record<string, unknown>; reads: string[] | null }> = [
      { name: 'no grant: the default source plus federated sources', token: 'floor', scope: {}, reads: ['default', 'source-a'] },
      { name: 'no grant, source_id names a federated source', token: 'floor', scope: { source_id: 'source-a' }, reads: ['source-a'] },
      { name: 'no grant, source_id names a non-federated source', token: 'floor', scope: { source_id: 'source-b' }, reads: null },
      { name: 'OAuth client: its scalar bound source', token: 'oauth', scope: {}, reads: ['default'] },
      { name: 'granted two sources', token: 'granted', scope: {}, reads: ['source-b', 'source-c'] },
      { name: 'granted two sources, source_ids narrows to one', token: 'granted', scope: { source_ids: ['source-c'] }, reads: ['source-c'] },
      { name: 'granted two sources, source_ids names one outside the grant', token: 'granted', scope: { source_ids: ['source-a'] }, reads: null },
      { name: 'granted two sources, source_id and source_ids intersect', token: 'granted', scope: { source_id: 'source-b', source_ids: ['source-b', 'source-c'] }, reads: ['source-b'] },
      { name: 'grant naming no source', token: 'none', scope: {}, reads: null },
    ];
    const PATHS: Array<{ name: string; provider: Provider; tool: 'search' | 'query'; args: Record<string, unknown> }> = [
      { name: 'search, hybrid vector arm', provider: 'vector', tool: 'search', args: { query: VECTOR_QUERY } },
      { name: 'search, hybrid with both arms', provider: 'vector', tool: 'search', args: { query: QUERY } },
      { name: 'search, embed failure keyword fallback', provider: 'embed_fails', tool: 'search', args: { query: QUERY } },
      { name: 'search, no-provider keyword path', provider: 'no_provider', tool: 'search', args: { query: QUERY } },
      { name: 'search, match keyword', provider: 'vector', tool: 'search', args: { query: QUERY, match: 'keyword' } },
      { name: 'query, text vector arm', provider: 'vector', tool: 'query', args: { query: VECTOR_QUERY, expand: false } },
      { name: 'query, embed failure keyword fallback', provider: 'embed_fails', tool: 'query', args: { query: QUERY, expand: false } },
      { name: 'query, image branch', provider: 'vector', tool: 'query', args: { image: IMAGE, image_mime: 'image/png' } },
    ];

    for (const path of PATHS) {
      test(`${path.name}: every grant and per-call scope reads exactly its sources`, async () => {
        useProvider(path.provider);
        for (const c of CASES) {
          const out = await callTool(serve.base, tokens[c.token]!, path.tool, { ...path.args, ...c.scope, limit: 50 });
          if (c.reads === null) {
            expect({ case: c.name, isError: out.isError, code: envelopeOf(out).code }).toEqual({ case: c.name, isError: true, code: 'permission_denied' });
            expect(JSON.stringify(out.content)).not.toContain('quillmarsh ledger kept');
            continue;
          }
          expect({ case: c.name, isError: out.isError === true, sources: sourcesOf(out) }).toEqual({ case: c.name, isError: false, sources: c.reads });
        }
      }, 120_000);
    }
  });
}
