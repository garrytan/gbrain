/**
 * GBRA-156: per-principal private pages (`private_pages: granted_sources`).
 *
 * 1. Protects: a remote token or OAuth client whose grant carries
 *    `private_pages: granted_sources` reads `visibility: private` pages only in
 *    the sources that grant names explicitly; every other remote caller keeps
 *    hiding them on every read path (search hybrid and keyword, query, recall,
 *    entity, get_page, list_pages, get_chunks, get_versions,
 *    get_timeline, get_links, get_backlinks, traverse_graph, resolve_slugs);
 *    context_pack and delta stay world-only for every remote caller, as they
 *    are for a local caller without include_private.
 * 2. Fails when: a private page leaks to a token left at `none`, to another
 *    member's token, through the no-grant floor or a federated source, through
 *    an OAuth client's bound source, through request `source_id`/`source_ids`,
 *    or after a rescope back to `none`; or when the owner's own token cannot
 *    read the page on a read path.
 * 3. Existing coverage (remote-privacy-sweep) pins only the `none` behaviour.
 * 4. Real seams: tokens and clients minted and rescoped through the grant
 *    service, verified by the serve --http verifier, dispatched through MCP
 *    dispatch with the options serve-http-mcp passes; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { parseClientRescopeArgs } from '../src/core/grants/cli.ts';
import { readClientGrant, rescopeClientGrant } from '../src/core/grants/service.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, withPrivateReadableSources } from '../src/core/search/private-visibility.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';
import { prepareSemanticCache, resolveCacheSearchMode } from '../src/core/search/hybrid/cache-stages.ts';
import { cacheScopeKey } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const ALICE = 'pp-alice';
const BOB = 'pp-bob';
const TEAM = 'pp-team';
const FED = 'pp-fed';
const SECRET = { [ALICE]: 'canaryalicepriv', [BOB]: 'canarybobpriv', [FED]: 'canaryfedpriv' } as const;
const PRIVATE_SLUG = 'notes/renewal-thoughts';
const ENTITY_SLUG = 'people/carol-example';
const TARGET_SLUG = 'notes/team-roadmap';

function privatePage(source: keyof typeof SECRET): string {
  return ['---', 'type: note', 'title: Renewal thoughts', 'visibility: private', '---',
    '# Renewal thoughts', '', `Quarry ledger renewal thoughts ${SECRET[source]} for the roadmap.`].join('\n');
}
function privateEntity(source: keyof typeof SECRET): string {
  return ['---', 'type: person', 'title: Carol Example', 'visibility: private', '---',
    '# Carol Example', '', `Carol Example runs the quarry ledger, ${SECRET[source]}.`].join('\n');
}

/** Each read path, with the arguments the private page in `source` answers. */
function reads(): Array<[string, string, Record<string, unknown>]> {
  return [
    ['search hybrid', 'search', { query: 'quarry ledger renewal thoughts', fields: 'full' }],
    ['search keyword', 'search', { query: 'renewal thoughts', match: 'keyword', fields: 'full' }],
    ['query', 'query', { query: 'quarry ledger renewal thoughts', expand: false, fields: 'full' }],
    ['recall', 'recall', { query: 'quarry ledger renewal thoughts' }],
    ['entity', 'entity', { name: 'Carol Example' }],
    ['get_page', 'get_page', { slug: PRIVATE_SLUG }],
    ['list_pages', 'list_pages', { slug_prefix: 'notes/' }],
    ['get_chunks', 'get_chunks', { slug: PRIVATE_SLUG }],
    ['get_versions', 'get_versions', { slug: PRIVATE_SLUG, include_body: true }],
    ['get_timeline', 'get_timeline', { slug: PRIVATE_SLUG }],
    ['get_links', 'get_links', { slug: PRIVATE_SLUG }],
    ['get_backlinks', 'get_backlinks', { slug: TARGET_SLUG }],
    ['traverse_graph', 'traverse_graph', { slug: PRIVATE_SLUG, depth: 1 }],
    ['resolve_slugs', 'resolve_slugs', { partial: 'renewal-thoughts' }],
  ];
}

for (const kind of testBackends()) {
  describe(`private_pages grant axis (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const tokenIds: Record<string, string> = {};
    const clients: Record<string, string> = {};

    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (token: string) => await provider().verifyAccessToken(token) as unknown as AuthInfo;

    async function rescopeToken(name: string, ...args: string[]): Promise<void> {
      await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, ...args]));
    }
    async function rescopeClient(clientId: string, ...args: string[]): Promise<void> {
      const parsed = parseClientRescopeArgs(clientId, args);
      await rescopeClientGrant(engine, clientId, parsed.patch, { actor: 'test', expectedRevision: (await readClientGrant(engine, clientId)).revision });
    }

    /** One MCP call as serve --http makes it: the verifier's AuthInfo, read live, and the transport's dispatch options. */
    async function call(token: string, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      const auth = await verify(token);
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    async function local(op: string, params: Record<string, unknown>): Promise<string> {
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: ALICE });
      return out.content.map(c => c.text).join('\n');
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [ALICE, BOB, TEAM]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`, [FED]);
      await engine.executeRaw(`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb) WHERE id = 'default'`);
      for (const source of [ALICE, BOB, FED] as const) {
        await importFromContent(engine, TARGET_SLUG, '---\ntype: note\ntitle: Team roadmap\n---\n# Team roadmap\n\nThe shared roadmap.', { sourceId: source });
        await importFromContent(engine, PRIVATE_SLUG, privatePage(source), { sourceId: source });
        await importFromContent(engine, PRIVATE_SLUG, privatePage(source) + '\n\nSecond draft.', { sourceId: source });
        await importFromContent(engine, ENTITY_SLUG, privateEntity(source), { sourceId: source });
        await engine.addLink(PRIVATE_SLUG, TARGET_SLUG, 'roadmap', 'mentions', 'manual', undefined, undefined, { fromSourceId: source, toSourceId: source });
        await engine.addTimelineEntry(PRIVATE_SLUG, { date: '2026-09-01', summary: `Renewal call ${SECRET[source]}` }, { sourceId: source });
        await engine.createVersion(PRIVATE_SLUG, { sourceId: source });
      }
      const mint = async (name: string, sources?: string[]) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], ...(sources ? { sourceGrant: sources } : {}) });
        tokens[name] = minted.token;
        tokenIds[name] = minted.id;
      };
      await mint('alice-example', [ALICE, TEAM]);
      await mint('bob-example', [BOB, TEAM]);
      await mint('bot-all', [ALICE, BOB, TEAM, FED]);
      await mint('floor');
      await mint('alice-none', [ALICE, TEAM]);
      await rescopeToken('alice-example', '--private-pages', 'granted-sources');
      await rescopeToken('bob-example', '--private-pages', 'granted-sources');
      await rescopeToken('floor', '--private-pages', 'granted-sources');
      const register = async (name: string, sourceId: string, read: string[]) => {
        const p = provider();
        const { clientId, clientSecret } = await p.registerClientManual(name, ['client_credentials'], 'read', [], sourceId, read);
        clients[name] = clientId;
        tokens[name] = (await p.exchangeClientCredentials(clientId, clientSecret!)).access_token;
      };
      await register('client-alice', ALICE, [ALICE, TEAM]);
      await register('client-bound', 'default', ['default']);
      await rescopeClient(clients['client-alice'], '--private-pages', 'granted-sources');
      await rescopeClient(clients['client-bound'], '--private-pages', 'granted-sources');
      await engine.executeRaw('UPDATE oauth_clients SET bound_source_id = $2 WHERE client_id = $1', [clients['client-bound'], ALICE]);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('fixture control: a trusted local caller reads the private page on every read path', async () => {
      for (const [label, op, params] of reads()) {
        const text = await local(op, params);
        expect({ label, seen: text.includes(SECRET[ALICE]) || text.includes(PRIVATE_SLUG) }).toEqual({ label, seen: true });
      }
    }, 120_000);

    test('existing rows read as none: a fresh column defaults every token and client', async () => {
      const rows = await engine.executeRaw<{ private_pages: string }>("SELECT private_pages FROM access_tokens WHERE name IN ('bot-all', 'alice-none')");
      expect(rows.map(r => r.private_pages)).toEqual(['none', 'none']);
      expect((await verify(tokens['bot-all'])).privatePages).toBeUndefined();
      expect((await verify(tokens['alice-example'])).privatePages).toEqual({ mode: 'granted_sources', sources: [ALICE, TEAM] });
      expect((await verify(tokens['client-alice'])).privatePages).toEqual({ mode: 'granted_sources', sources: [ALICE, TEAM] });
      expect((await verify(tokens['floor'])).privatePages).toBeUndefined();
      expect((await verify(tokens['client-bound'])).privatePages).toEqual({ mode: 'granted_sources', sources: ['default'] });
    });

    for (const [label, op, params] of reads()) {
      test(`${label}: the owner's granted token and client see their private page; nobody else does`, async () => {
        for (const owner of ['alice-example', 'client-alice']) {
          const out = await call(tokens[owner], op, params);
          expect({ owner, isError: out.isError, seen: out.text.includes(SECRET[ALICE]) || out.text.includes(PRIVATE_SLUG) })
            .toEqual({ owner, isError: false, seen: true });
          expect(out.text).not.toContain(SECRET[BOB]);
          expect(out.text).not.toContain(SECRET[FED]);
        }
        const bob = await call(tokens['bob-example'], op, params);
        expect(bob.text).not.toContain(SECRET[ALICE]);
        for (const other of ['bot-all', 'alice-none', 'floor', 'client-bound']) {
          const out = await call(tokens[other], op, params);
          for (const secret of Object.values(SECRET)) expect({ other, leaked: out.text.includes(secret) }).toEqual({ other, leaked: false });
        }
      }, 120_000);
    }

    test('context_pack stays world-only for every remote caller, the owner included', async () => {
      expect(await local('context_pack', { entities: 'Carol Example', include_private: true })).toContain(SECRET[ALICE]);
      expect(await local('context_pack', { entities: 'Carol Example' })).not.toContain(SECRET[ALICE]);
      for (const who of ['alice-example', 'client-alice', 'bot-all', 'floor']) {
        const out = await call(tokens[who], 'context_pack', { entities: 'Carol Example', include_private: true });
        for (const secret of Object.values(SECRET)) expect({ who, leaked: out.text.includes(secret) }).toEqual({ who, leaked: false });
      }
    });

    test("source_id and source_ids naming a private source outside the grant are refused and never widen", async () => {
      for (const op of ['search', 'query'] as const) {
        for (const args of [{ source_ids: [BOB] }, { source_ids: [ALICE, BOB] }, { source_id: BOB }, { source_ids: [FED] }]) {
          const out = await call(tokens['alice-example'], op, { query: 'quarry ledger renewal thoughts', ...(op === 'query' ? { expand: false } : {}), ...args });
          expect({ op, args, isError: out.isError, denied: out.text.includes('permission_denied') }).toEqual({ op, args, isError: true, denied: true });
          expect(out.text).not.toContain(SECRET[BOB]);
        }
      }
      const narrowed = await call(tokens['alice-example'], 'search', { query: 'quarry ledger renewal thoughts', source_ids: [TEAM] });
      expect(narrowed.text).not.toContain(SECRET[ALICE]);
      const page = await call(tokens['alice-example'], 'get_page', { slug: PRIVATE_SLUG, source_id: BOB });
      expect(page.isError).toBe(true);
      expect(page.text).not.toContain(SECRET[BOB]);
    }, 120_000);

    test('the env escape hatch still shows every private page to every remote caller', async () => {
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        const out = await call(tokens['bot-all'], 'get_page', { slug: PRIVATE_SLUG, source_id: BOB });
        expect(out.text).toContain(SECRET[BOB]);
      });
    });

    test('writes keep hiding private pages: a write to the private page stays refused for the owner while a world page takes it', async () => {
      await rescopeToken('alice-example', '--scopes', 'read,write');
      try {
        const control = await call(tokens['alice-example'], 'add_tag', { slug: TARGET_SLUG, tag: 'renewal' });
        expect({ isError: control.isError, text: control.text.slice(0, 200) }).toMatchObject({ isError: false });
        const out = await call(tokens['alice-example'], 'add_tag', { slug: PRIVATE_SLUG, tag: 'renewal' });
        expect({ isError: out.isError, refused: out.text.includes('"code": "page_not_found"') }).toEqual({ isError: true, refused: true });
        expect(out.text).not.toContain(SECRET[ALICE]);
      } finally {
        await rescopeToken('alice-example', '--scopes', 'read');
      }
    });

    test('delta stays world-only for every remote caller, the owner included', async () => {
      const since = '2000-01-01T00:00:00Z';
      expect(await local('delta', { since, include_private: true })).toContain(PRIVATE_SLUG);
      expect(await local('delta', { since })).not.toContain(PRIVATE_SLUG);
      for (const who of ['alice-example', 'client-alice', 'bot-all', 'floor']) {
        const out = await call(tokens[who], 'delta', { since, include_private: true });
        expect({ who, isError: out.isError, listed: out.text.includes(PRIVATE_SLUG) }).toEqual({ who, isError: false, listed: false });
        if (who === 'alice-example') expect({ who, world: out.text.includes(TARGET_SLUG) }).toEqual({ who, world: true });
        for (const secret of Object.values(SECRET)) expect({ who, leaked: out.text.includes(secret) }).toEqual({ who, leaked: false });
      }
    });

    test('in a granted source the grant opens privacy-alias pages and derived atoms, never a pinned question', async () => {
      const extra: Array<[string, string, string]> = [
        ['drafts/harbor-memo', 'canaryaliaspriv', ['---', 'type: note', 'title: Harbor memo', 'confidentiality: secret', '---', '# Harbor memo', '', 'Harbor memo canaryaliaspriv.'].join('\n')],
        ['atoms/harbor-atom', 'canaryatompriv', ['---', 'type: atom', 'title: Harbor atom', '---', '# Harbor atom', '', 'Harbor atom canaryatompriv.'].join('\n')],
        ['questions/harbor-pin', 'canarypinpriv', ['---', 'type: question', 'title: Harbor pin', 'visibility: private', 'pinned_question: pin-example', '---', '# Harbor pin', '', 'Owner note canarypinpriv.'].join('\n')],
      ];
      for (const [slug, , body] of extra) await importFromContent(engine, slug, body, { sourceId: ALICE });
      for (const [slug, canary] of extra) expect({ slug, seen: (await local('get_page', { slug })).includes(canary) }).toEqual({ slug, seen: true });
      for (const owner of ['alice-example', 'client-alice']) {
        for (const [slug, canary] of extra) {
          const out = await call(tokens[owner], 'get_page', { slug });
          expect({ owner, slug, seen: out.text.includes(canary) }).toEqual({ owner, slug, seen: !slug.startsWith('questions/') });
        }
        const listed = await call(tokens[owner], 'list_pages', { slug_prefix: 'questions/' });
        expect({ owner, isError: listed.isError, listed: listed.text.includes('questions/harbor-pin') }).toEqual({ owner, isError: false, listed: false });
      }
      for (const other of ['bob-example', 'floor', 'alice-none']) {
        for (const [slug, canary] of extra) {
          const out = await call(tokens[other], 'get_page', { slug, source_id: ALICE });
          expect({ other, slug, leaked: out.text.includes(canary) }).toEqual({ other, slug, leaked: false });
        }
      }
    });

    // Value: protects=#8104: get_versions in a granted source hides an older version that carried the pinned_question marker even when the
    // live page no longer carries it; fails_when=the widened arm checks the marker on the live page only; why_new=the pinned-question case
    // above keeps the marker on the live page; seam=none (owner edits through importFromContent); no_claim=how a marker leaves a question page
    test('get_versions in a granted source hides a version that carried the pinned_question marker after the live page dropped it', async () => {
      const slug = 'questions/harbor-unpinned';
      const page = (marker: boolean, canary: string) => ['---', 'type: question', 'title: Harbor unpinned', 'visibility: private',
        ...(marker ? ['pinned_question: pin-example'] : []), '---', '# Harbor unpinned', '', `Owner note ${canary}.`].join('\n');
      await importFromContent(engine, slug, page(true, 'canarypinnedversion'), { sourceId: ALICE });
      await engine.createVersion(slug, { sourceId: ALICE });
      await importFromContent(engine, slug, page(false, 'canaryunpinnedversion'), { sourceId: ALICE });
      await engine.createVersion(slug, { sourceId: ALICE });
      const all = await local('get_versions', { slug, include_body: true });
      expect({ pinned: all.includes('canarypinnedversion'), unpinned: all.includes('canaryunpinnedversion') }).toEqual({ pinned: true, unpinned: true });
      for (const owner of ['alice-example', 'client-alice']) {
        const out = await call(tokens[owner], 'get_versions', { slug, include_body: true });
        expect({ owner, isError: out.isError, pinned: out.text.includes('canarypinnedversion'), unpinned: out.text.includes('canaryunpinnedversion') })
          .toEqual({ owner, isError: false, pinned: false, unpinned: true });
      }
    });

    test('a rescope back to none hides the pages on the next call (token and client)', async () => {
      expect((await call(tokens['alice-example'], 'get_page', { slug: PRIVATE_SLUG })).text).toContain(SECRET[ALICE]);
      await rescopeToken('alice-example', '--private-pages', 'none');
      await rescopeClient(clients['client-alice'], '--private-pages', 'none');
      try {
        for (const owner of ['alice-example', 'client-alice']) {
          for (const [label, op, params] of reads()) {
            const out = await call(tokens[owner], op, params);
            expect({ owner, label, leaked: out.text.includes(SECRET[ALICE]) }).toEqual({ owner, label, leaked: false });
          }
        }
      } finally {
        await rescopeToken('alice-example', '--private-pages', 'granted-sources');
        await rescopeClient(clients['client-alice'], '--private-pages', 'granted-sources');
      }
      expect((await call(tokens['alice-example'], 'get_page', { slug: PRIVATE_SLUG })).text).toContain(SECRET[ALICE]);
    }, 120_000);

    test('the semantic result cache keys on the private-readable set: a granted caller\'s stored private result never serves an ungranted caller with the same scope and query', async () => {
      const query = 'renewal thoughts for the quarter';
      const opts = { excludePrivate: true, sourceIds: [ALICE, TEAM] };
      const scope = cacheScopeKey(opts);
      const [{ atttypmod: dims }] = await engine.executeRaw<{ atttypmod: number }>(
        "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'query_cache'::regclass AND attname = 'embedding'");
      const embedding = new Float32Array(dims).fill(1 / Math.sqrt(dims));
      const keyFor = async () => {
        const { resolvedForCache, knobsHash } = await resolveCacheSearchMode(engine, opts);
        return (await prepareSemanticCache(engine, query, opts, resolvedForCache, knobsHash)).cacheKnobsHash;
      };
      const granted = await withPrivateReadableSources([ALICE, TEAM], keyFor);
      const ungranted = await keyFor();
      const cache = new SemanticQueryCache(engine, { enabled: true });
      const row = { slug: PRIVATE_SLUG, page_id: 1, title: 'Renewal thoughts', type: 'note', chunk_text: SECRET[ALICE], chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 1, stale: false, source_id: ALICE } as SearchResult;
      await engine.executeRaw('DELETE FROM query_cache');
      try {
        await cache.store(query, embedding, [row], { vector_enabled: true, detail_resolved: 'medium', expansion_applied: false, intent: 'general' } as HybridSearchMeta, { sourceId: scope, knobsHash: granted });
        expect((await cache.lookup(embedding, { sourceId: scope, knobsHash: granted, queryText: query })).hit).toBe(true);
        const served = await cache.lookup(embedding, { sourceId: scope, knobsHash: ungranted, queryText: query });
        expect({ hit: served.hit, leaked: JSON.stringify(served).includes(SECRET[ALICE]) }).toEqual({ hit: false, leaked: false });
        expect(await withPrivateReadableSources([], keyFor)).toBe(ungranted);
        expect(await withPrivateReadableSources([TEAM, ALICE], keyFor)).toBe(granted);
      } finally {
        await engine.executeRaw('DELETE FROM query_cache');
      }
    });

    test('concurrent calls from two members never cross', async () => {
      const calls: Array<Promise<void>> = [];
      for (let round = 0; round < 6; round++) {
        for (const [member, own, other] of [['alice-example', ALICE, BOB], ['bob-example', BOB, ALICE]] as const) {
          for (const [, op, params] of reads().slice(0, 9)) {
            calls.push(call(tokens[member], op, params).then(out => {
              expect(out.text).not.toContain(SECRET[other as keyof typeof SECRET]);
              if (op === 'get_page') expect(out.text).toContain(SECRET[own as keyof typeof SECRET]);
            }));
          }
        }
      }
      await Promise.all(calls);
    }, 120_000);
  });
}
