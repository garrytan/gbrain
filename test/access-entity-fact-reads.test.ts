/**
 * Observations are never wider than the page they are about (moved from GBRA-431 to GBRA-434).
 *
 * 1. Protects: a `world` observation about a restricted or private entity page is withheld from every remote caller
 *    who cannot read that page (ontology_get, volunteer_chronicle, delta, find_trajectory, the hot-memory `_meta`),
 *    while a member the page names still reads it and trusted local callers keep every answer.
 * 2. Fails when: a remote caller who cannot read the entity page reads its observation, or a reader loses it.
 * 3. Existing coverage: none for the entity page; the provenance page gate is pinned by the facts read tests.
 * 4. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier,
 *    dispatched through MCP dispatch on a repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

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

const SRC = 'hp-team';
const OPEN = 'notes/open-plan';
const HUB = 'notes/shared-roadmap';
const RESTRICTED = 'people/vesper-example';
const PRIVATE = 'notes/quiet-plan';
const note = (title: string, body: string, extra: string[] = []) => ['---', ...extra, 'title: ' + title, '---', '# ' + title, '', body].join('\n');
const json = (text: string): Record<string, unknown> => { try { return JSON.parse(text); } catch { return {}; } };

type Call = { isError: boolean; text: string; json: Record<string, unknown> };

for (const kind of testBackends()) {
  describe('observations follow their entity page (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<Call> {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default',
        takesHoldersAllowList: ['world'], metaHook: getBrainHotMemoryMeta, sessionId: 'hp-' + who + '-' + randomUUID() } as never);
      const text = out.content.map(c => c.text).join('\n');
      const hot = (out._meta as Record<string, unknown> | undefined)?.brain_hot_memory;
      return { isError: out.isError === true, text: text + (hot ? '\n_META_HOT: ' + JSON.stringify(hot) : ''), json: json(text) };
    }
    async function local(op: string, params: Record<string, unknown>): Promise<Call> {
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: SRC });
      const text = out.content.map(c => c.text).join('\n');
      return { isError: out.isError === true, text, json: json(text) };
    }
    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } } as never);
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, HUB, note('Shared roadmap', 'The shared roadmap.', ['type: note']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, OPEN, note('Open plan', 'Open planning notes.', ['type: note']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, RESTRICTED, note('Vesper Example', 'Person notes.', ['type: person', 'readable_by: [alice-example]']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, PRIVATE, note('Quiet plan', 'Quiet planning notes.', ['type: note', 'visibility: private']), { sourceId: SRC, noEmbed: true });
      for (const slug of [OPEN, RESTRICTED, PRIVATE]) {
        await engine.addLink(slug, HUB, 'roadmap', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC }); // gbrain-allow-direct-insert: test fixture edges
        if (slug !== OPEN) await engine.addLink(OPEN, slug, 'context', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC }); // gbrain-allow-direct-insert: test fixture edges
        await engine.putRawData(slug, 'acme-example', { note: 'fixture' }, { sourceId: SRC });
      }
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      for (const [name, scopes, member] of [['reader', ['read'], null], ['writer', ['read', 'write'], null], ['bob', ['read', 'write'], 'bob-example'],
        ['alice', ['read', 'write'], 'alice-example'], ['admin', ['read', 'write', 'admin'], null]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: [...scopes], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); }, 60_000);

    test('a world observation about a restricted or private page reaches only the callers who can read that page', async () => {
      await local('ontology_propose', { entity: RESTRICTED, dimension: 'employer', value: 'band canaryhpband', visibility: 'world' });
      await local('ontology_propose', { entity: PRIVATE, dimension: 'location', value: 'stage canaryhpstage', visibility: 'world' });
      await local('ontology_propose', { entity: OPEN, dimension: 'location', value: 'stage canaryhpopen', visibility: 'world' });
      const paths: Array<[string, string, Record<string, unknown>]> = [
        ['ontology_get restricted', 'ontology_get', { entity: RESTRICTED }], ['ontology_get private', 'ontology_get', { entity: PRIVATE }],
        ['volunteer_chronicle', 'volunteer_chronicle', { entities: RESTRICTED + ',' + PRIVATE }], ['delta', 'delta', { since: '2000-01-01' }],
        ['find_trajectory restricted', 'find_trajectory', { entity_slug: RESTRICTED }], ['find_trajectory private', 'find_trajectory', { entity_slug: PRIVATE }],
        ['hot memory on an unrelated call', 'get_tags', { slug: OPEN }],
      ];
      for (const who of ['reader', 'bob', 'writer']) {
        const seen: Record<string, boolean> = {};
        for (const [label, op, params] of paths) {
          const out = await call(who, op, params);
          seen[label] = out.text.includes('canaryhpband') || out.text.includes('canaryhpstage');
        }
        expect({ who, seen }).toEqual({ who, seen: Object.fromEntries(paths.map(([label]) => [label, false])) });
      }
      expect((await call('reader', 'ontology_get', { entity: OPEN })).text).toContain('canaryhpopen');
      expect((await call('alice', 'ontology_get', { entity: RESTRICTED })).text).toContain('canaryhpband');
      expect((await local('ontology_get', { entity: RESTRICTED })).text).toContain('canaryhpband');
      expect((await local('ontology_get', { entity: PRIVATE })).text).toContain('canaryhpstage');
    }, 240_000);

  });
}
