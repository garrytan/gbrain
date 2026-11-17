/**
 * GST-2951 (second part): the brain owner's own remote agents read private facts on the entity card (its facts and
 * their count), in search's entity facts and saved-facts match, in the unattributed-facts list and in forget's
 * similar-facts check, as they already do through recall, query, find_trajectory and the ontology reads.
 *
 * 1. Protects: a credential bound to the member access.owner_member names gets its private facts from each of those
 *    reads. Every other caller reads exactly what it read before: another member, a labelled-only member, an unbound
 *    token, a call with no credential and the owner's credential speaking for an audience of several get world-only
 *    facts, and a private-facts grant keeps admitting a private fact on a world page where it already did. Page rules
 *    stay: the owner reads no fact taken from another person's readable_by page, and no caller reads a withdrawn fact.
 * 2. Fails when: these reads decide fact visibility from the raw remote flag again (the owner gets world-only facts),
 *    or a non-owner caller reads a private fact.
 * 3. Existing coverage: access-owner-reads and access-owner-fact-ops-gst2951 pin the other fact reads; none of these.
 * 4. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch as serve-http-mcp does (remote: true), on a repo-less brain; embeddings stubbed; PGLite, and Postgres
 *    when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

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

const SRC = 'own-src';
const OWNER = 'owner-example';
const ENTITY = 'people/erin-example';
const WORLD_PAGE = 'notes/open-harbor';
const BOBS_PAGE = 'notes/bob-harbor';
/** Fact canaries: the owner's private fact, one from another person's readable_by page, a withdrawn one, a private fact on a world page (the private-facts grant admits it) and a world one. */
const OWN = 'canaryownmore';
const BOBS = 'canarybobmore';
const GONE = 'canarygonemore';
const GRANTED = 'canarygrantedmore';
const WORLD = 'canaryworldmore';
/** The same kinds of fact saved with no entity, for the unattributed list. */
const LOOSE = { own: 'canaryownloose', bobs: 'canarybobloose', gone: 'canarygoneloose' } as const;

type Surface = 'entity card' | 'search entity facts' | 'search saved facts' | 'unattributed';
const SURFACES: Surface[] = ['entity card', 'search entity facts', 'search saved facts', 'unattributed'];

for (const kind of testBackends()) {
  describe(`owner fact reads, second part (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const ids: Record<string, number> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    /** One MCP call as serve --http makes it; `anonymous` carries no credential at all. */
    async function call(who: string, op: string, params: Record<string, unknown>, header?: string): Promise<{ isError: boolean; text: string; meta: string }> {
      __resetPrivateVisibilityCacheForTests();
      let out;
      if (who === 'anonymous') {
        out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', sourceId: SRC, takesHoldersAllowList: ['world'] });
      } else {
        const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? 'default';
        const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
        out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(header ? { onBehalfOf: { header } } : {}),
        });
      }
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n'), meta: JSON.stringify(out._meta ?? null) };
    }

    /** The entity card's active fact count, or null when the caller gets no card. */
    async function cardCount(who: string, header?: string): Promise<number | null> {
      const m = /"active_fact_count":(\d+)/.exec((await call(who, 'entity', { name: ENTITY }, header)).text);
      return m ? Number(m[1]) : null;
    }

    /** Where `who` reads the fact with `canary` (`loose`: its kind saved with no entity, for the unattributed list). */
    async function seenBy(who: string, canary: string, loose: string, header?: string): Promise<Surface[]> {
      const seen: Surface[] = [];
      if ((await call(who, 'entity', { name: ENTITY }, header)).text.includes(canary)) seen.push('entity card');
      if ((await call(who, 'search', { query: 'Erin Example', limit: 5 }, header)).meta.includes(canary)) seen.push('search entity facts');
      if ((await call(who, 'search', { query: canary, limit: 5 }, header)).meta.includes(canary)) seen.push('search saved facts');
      if ((await call(who, 'extraction_pending', { include: ['unattributed'] }, header)).text.includes(loose)) seen.push('unattributed');
      return seen;
    }

    /** The fact ids forget's similar-facts check names after `who` forgets fact `id`. */
    async function similarAfterForget(who: string, id: number): Promise<number[]> {
      const out = await call(who, 'forget', { id: String(id) });
      if (out.isError) throw new Error(`${who} forget: ${out.text}`);
      return [...out.text.matchAll(/"fact_id":\s*"(\d+)"/g)].map(m => Number(m[1])).sort((a, b) => a - b);
    }

    const insertFact = async (canary: string, entity: string | null, visibility: 'private' | 'world', provenance: string | null) => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug)
        VALUES ($1, $2, $3, 'fact', $4, 'fixture', $5) RETURNING id`, [SRC, entity, `Keeps the ferry timetable ${canary}`, visibility, provenance]);
      return Number(row!.id);
    };
    const skiff = async (canary: string, visibility: 'private' | 'world') => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source)
        VALUES ($1, 'people/gail-example', $2, 'fact', $3, 'fixture') RETURNING id`, [SRC, `Rows the river skiff ${canary}`, visibility]);
      return Number(row!.id);
    };
    /** One shared embedding per group; `step` keeps the groups far apart. */
    const sameEmbedding = async (list: number[], step: number) => {
      const [col] = await engine.executeRaw<{ t: string }>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`);
      const dims = Number(/\((\d+)\)/.exec(col!.t)![1]);
      const literal = `[${Array.from({ length: dims }, (_, i) => (i % step) / 10).join(',')}]`;
      await engine.executeRaw(`UPDATE facts SET embedding = $1::text::${col!.t.replace(/\(.*$/, '')}, embedding_model = 'test-model' WHERE id = ANY($2::bigint[])`, [literal, list]);
    };

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      const page = (title: string, fm: string[] = []) => ['---', 'type: note', `title: ${title}`, ...fm, '---', `# ${title}`, '', 'Harbor notes.'].join('\n');
      await importFromContent(engine, ENTITY, ['---', 'type: person', 'title: Erin Example', '---', '# Erin Example', '', 'Erin is a founder.'].join('\n'), { sourceId: SRC });
      await importFromContent(engine, WORLD_PAGE, page('Open harbor'), { sourceId: SRC });
      await importFromContent(engine, BOBS_PAGE, page('Bob harbor', ['readable_by: [bob-example]']), { sourceId: SRC });

      ids.own = await insertFact(OWN, ENTITY, 'private', null);
      ids.bobs = await insertFact(BOBS, ENTITY, 'private', BOBS_PAGE);
      ids.gone = await insertFact(GONE, ENTITY, 'private', null);
      ids.granted = await insertFact(GRANTED, ENTITY, 'private', WORLD_PAGE);
      ids.world = await insertFact(WORLD, ENTITY, 'world', null);
      await insertFact(LOOSE.own, null, 'private', null);
      await insertFact(LOOSE.bobs, null, 'private', BOBS_PAGE);
      ids.goneLoose = await insertFact(LOOSE.gone, null, 'private', null);
      for (const id of [ids.gone, ids.goneLoose]) {
        const out = await dispatchToolCall(engine, 'forget_fact', { id }, { remote: false, sourceId: SRC });
        if (out.isError) throw new Error(`fixture forget: ${out.content.map(c => c.text).join(' ')}`);
      }
      // forget's similar-facts check: anchors and their near twins, about an entity with no page, worded apart from the rest.
      ids.ownAnchor = await skiff('canaryanchorown', 'private');
      ids.ownTwin = await skiff('canarytwinown', 'private');
      ids.bobAnchor = await skiff('canaryanchorbob', 'world');
      ids.bobPrivateTwin = await skiff('canarytwinprivbob', 'private');
      ids.bobWorldTwin = await skiff('canarytwinworldbob', 'world');
      await sameEmbedding([ids.ownAnchor, ids.ownTwin], 7);
      await sameEmbedding([ids.bobAnchor, ids.bobPrivateTwin, ids.bobWorldTwin], 2);

      for (const id of [OWNER, 'bob-example', 'lab-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await setMemberLabelledOnly(engine, 'lab-example', true, { remote: false });
      const mint = async (name: string, scopes: string[], member?: string, mayActFor?: string[]) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member, ...(mayActFor ? { mayActFor } : {}) });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner', ['read', 'write'], OWNER, [`member:${OWNER}`, 'member:bob-example']);
      await mint('delegate', ['read'], OWNER);
      await mint('bob', ['read', 'write'], 'bob-example');
      await mint('lab', ['read'], 'lab-example');
      await mint('unbound', ['read']);
      await mint('unbound-write', ['read', 'write']);
      await mint('granted', ['read']);
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['granted', '--private-facts', 'granted-sources']));
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    const AUDIENCE = `member:${OWNER},member:bob-example`;

    test('fixture control: a trusted local caller reads the private facts but the withdrawn ones', async () => {
      const local = async (op: string, params: Record<string, unknown>) => {
        const out = await dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC });
        return out.content.map(c => c.text).join('\n') + JSON.stringify(out._meta ?? null);
      };
      const card = await local('entity', { name: ENTITY });
      expect({ own: card.includes(OWN), bobs: card.includes(BOBS), gone: card.includes(GONE) }).toEqual({ own: true, bobs: true, gone: false });
      const list = await local('extraction_pending', { include: ['unattributed'] });
      expect({ own: list.includes(LOOSE.own), bobs: list.includes(LOOSE.bobs), gone: list.includes(LOOSE.gone) }).toEqual({ own: true, bobs: true, gone: false });
    }, 120_000);

    test('the owner and a delegate bound to the owner read their private facts on every surface', async () => {
      for (const who of ['owner', 'delegate']) expect({ who, seen: await seenBy(who, OWN, LOOSE.own) }).toEqual({ who, seen: SURFACES });
      expect(await seenBy('owner', OWN, LOOSE.own, `member:${OWNER}`)).toEqual(SURFACES);
    }, 240_000);

    test('the entity card counts the owner\'s own private fact and the one on a world page with the world one, never a hidden or withdrawn one', async () => {
      for (const who of ['owner', 'delegate']) expect({ who, count: await cardCount(who) }).toEqual({ who, count: 3 });
      for (const who of ['bob', 'unbound', 'granted', 'anonymous']) expect({ who, count: await cardCount(who) }).toEqual({ who, count: 1 });
      expect(await cardCount('owner', AUDIENCE)).toBe(1);
      expect(await cardCount('lab')).toBeNull();
    }, 240_000);

    test('another member, a labelled-only member, an unbound token, no credential, a private-facts grant and the owner for an audience read no private fact of the owner\'s', async () => {
      for (const who of ['bob', 'lab', 'unbound', 'anonymous', 'granted']) expect({ who, seen: await seenBy(who, OWN, LOOSE.own) }).toEqual({ who, seen: [] });
      expect(await seenBy('owner', OWN, LOOSE.own, AUDIENCE)).toEqual([]);
      expect((await call('bob', 'entity', { name: ENTITY })).text).toContain(WORLD);
    }, 240_000);

    test('the private-facts grant still admits a private fact on a world page where it already did, and only for its credential', async () => {
      expect(await seenBy('granted', GRANTED, 'none')).toEqual(['entity card', 'search entity facts', 'search saved facts']);
      expect(await seenBy('bob', GRANTED, 'none')).toEqual([]);
    }, 240_000);

    test('member access stays mandatory for the owner, and no caller reads a withdrawn fact', async () => {
      expect(await seenBy('owner', BOBS, LOOSE.bobs)).toEqual([]);
      for (const who of ['owner', 'delegate', 'bob', 'unbound']) expect({ who, seen: await seenBy(who, GONE, LOOSE.gone) }).toEqual({ who, seen: [] });
    }, 240_000);

    test('forget\'s similar-facts check names the owner\'s private twin to the owner, and only world twins to an unbound credential', async () => {
      expect(await similarAfterForget('owner', ids.ownAnchor!)).toEqual([ids.ownTwin!]);
      expect(await similarAfterForget('unbound-write', ids.bobAnchor!)).toEqual([ids.bobWorldTwin!]);
    }, 120_000);
  });
}
