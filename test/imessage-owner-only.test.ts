/**
 * Owner-only sources (access/owner-only.ts): an imessage source, and any source flagged `owner_only: true`, is read
 * only by the trusted local CLI and by credentials bound to the brain owner speaking for itself.
 *
 * 1. Protects: every other remote caller (another member, an unbound token, the owner's credential speaking for a
 *    shared room or a guest, an attested call linked to the owner) gets not_found for a page in an owner-only source
 *    (private or not), for pages and facts derived from one (recorded derivation inputs, followed transitively, and
 *    synthesized concepts), and for its timeline, through get_page, search, query, recall, list_pages, get_timeline and
 *    delta, under each operator relaxation alone and all together: granted-sources private pages and facts on the
 *    token, search.remote_private_pages visible, access.members_read_lineage, access.owner_reads_restricted and
 *    visibility.honor_aliases off. A remote write into an owner-only source from any credential but the owner's is
 *    refused like a page it may not see.
 * 2. Fails when: any of those callers sees a canary, or the owner, its delegate or the local CLI loses one.
 * 3. Real seams: the imessage sync against a synthetic helper writes the pages; tokens minted by the token service and
 *    verified by the serve --http verifier, dispatched through MCP dispatch with remote: true, on a repo-less brain;
 *    embeddings stubbed.
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
import { linkMember } from '../src/core/access/actor.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { runIMessageSync } from '../src/core/imessage/imessage-source.ts';
import { parseIMessageSourceConfig } from '../src/core/imessage/source-config.ts';
import { imessageHelper } from '../src/core/apple/helper-client.ts';
import { imessageChatKey, imessagePagePath } from '../src/core/imessage/render.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { HELPER_TEST_TOKEN, helperFetch } from './helpers/imessage-helper-fixture.ts';
import { options } from './helpers/connector-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { OWNER_ONLY_FLAG, OWNER_ONLY_KINDS, ownerOnlyFactSql, ownerOnlyPageSql, type OwnerOnlyForm } from '../src/core/access/owner-only.ts';
import { v320 } from '../src/core/schema-migrations/v320-owner-only-lineage.ts';

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

const OPEN_SRC = 'own-src';
const IMSG = 'messages';
const FLAGGED = 'flagged-src';
const OWNER = 'owner-example';
const NOW = Date.parse('2026-06-15T12:00:00Z');
const PHRASE = 'harbor ledger planning notes';
const CHAT_CANARY = 'canaryooday';
const CHAT_SLUG = slugifyPath(imessagePagePath(imessageChatKey('+15555550100'), '2026-06-14'));
/** Owner-only pages, by how they reach an owner-only source. */
const HIDDEN = {
  chat: { slug: CHAT_SLUG, canary: CHAT_CANARY },
  plain: { slug: 'notes/plain-in-messages', canary: 'canaryooplain' },
  flagged: { slug: 'notes/flagged-plan', canary: 'canaryooflag' },
  derived: { slug: 'notes/derived-from-chat', canary: 'canaryooderived' },
  derived2: { slug: 'notes/derived-twice', canary: 'canaryooderived2' },
  concept: { slug: 'concepts/harbor-chat', canary: 'canaryooconcept' },
} as const;
type Hidden = keyof typeof HIDDEN;
const OPEN = { slug: 'notes/open-plan', canary: 'canaryooopen' };
const FACT_IN_SOURCE = 'canaryoofact';
const FACT_DERIVED = 'canaryoofactderived';
const TIMELINE = 'canaryootimeline';
const ALL_CANARIES = [...Object.values(HIDDEN).map(h => h.canary), FACT_IN_SOURCE, FACT_DERIVED, TIMELINE];

const pageText = (title: string, canary: string, fm: readonly string[] = []) =>
  ['---', ...(fm.some(l => l.startsWith('type:')) ? [] : ['type: note']), `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary} for the roadmap.`].join('\n');

/** Every read path a non-owner might reach an owner-only artifact through. */
function reads(): Array<[string, string, Record<string, unknown>]> {
  return [
    ...Object.entries(HIDDEN).map(([key, h]) => [`get_page ${key}`, 'get_page', { slug: h.slug }] as [string, string, Record<string, unknown>]),
    ['get_timeline', 'get_timeline', { slug: CHAT_SLUG }],
    ['search', 'search', { query: PHRASE, fields: 'full', limit: 50 }],
    ['search keyword', 'search', { query: 'planning notes', match: 'keyword', fields: 'full', limit: 50 }],
    ['query', 'query', { query: PHRASE, expand: false, fields: 'full', limit: 50 }],
    ['recall', 'recall', { query: PHRASE }],
    ['recall question', 'recall', { question: `Harbor ledger planning notes ${FACT_DERIVED}` }],
    ['list_pages', 'list_pages', { limit: 100 }],
    ['delta', 'delta', { since: '2000-01-01T00:00:00Z' }],
  ];
}

const RELAXATIONS: Record<string, Array<[string, string]>> = {
  none: [],
  'search.remote_private_pages': [['search.remote_private_pages', 'visible']],
  'access.members_read_lineage': [['access.members_read_lineage', '1']],
  'access.owner_reads_restricted': [['access.owner_reads_restricted', '1']],
  'visibility.honor_aliases off': [['visibility.honor_aliases', 'false']],
};
RELAXATIONS.all = Object.values(RELAXATIONS).flat();

for (const kind of testBackends()) {
  describe(`owner-only sources (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>, ch: { header?: string; actor?: string } = {}): Promise<{ isError: boolean; text: string }> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? OPEN_SRC;
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(ch.header ? { onBehalfOf: { header: ch.header } } : {}),
        ...(ch.actor ? { actor: { header: ch.actor } } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** The owner-only canaries `who` sees on each read path, in every source its grant names. */
    async function seenBy(who: string, ch: { header?: string; actor?: string } = {}): Promise<Record<string, string[]>> {
      const out: Record<string, string[]> = {};
      for (const sourceId of [OPEN_SRC, IMSG, FLAGGED]) {
        for (const [label, op, params] of reads()) {
          const { text } = await call(who, op, { ...params, ...(op === 'get_page' || op === 'get_timeline' ? {} : { source_id: sourceId }) }, ch);
          const seen = ALL_CANARIES.filter(c => text.includes(c));
          if (seen.length) out[label] = [...new Set([...(out[label] ?? []), ...seen])].sort();
        }
      }
      return out;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [OPEN_SRC]);
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"imessage","federated":true}'::jsonb)`, [IMSG]);
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"owner_only":true,"federated":true}'::jsonb)`, [FLAGGED]);

      // The chat day, written by the sync from a synthetic helper.
      const fake = { token: HELPER_TEST_TOKEN, calls: [], chats: [{ threadId: '+15555550100', displayName: 'Alice Example', participants: ['+15555550100'],
        messages: [{ rowid: 1, at: Date.parse('2026-06-14T09:00:00Z'), text: `Harbor ledger planning notes ${CHAT_CANARY} for the roadmap.` }] }] };
      const synced = await runIMessageSync(engine, IMSG, parseIMessageSourceConfig({ kind: 'imessage' }), { ...options, noEmbed: false },
        { helper: imessageHelper({ sourceId: IMSG, port: 47001, token: HELPER_TEST_TOKEN, fetchImpl: helperFetch(fake) }), now: () => NOW });
      if (synced.added !== 1) throw new Error(`fixture sync added ${synced.added}`);
      // A page in the imessage source that is not marked private is owner-only all the same.
      await importFromContent(engine, HIDDEN.plain.slug, pageText('Plain', HIDDEN.plain.canary), { sourceId: IMSG });
      await importFromContent(engine, HIDDEN.flagged.slug, pageText('Flagged', HIDDEN.flagged.canary), { sourceId: FLAGGED });
      await importFromContent(engine, OPEN.slug, pageText('Open', OPEN.canary), { sourceId: OPEN_SRC });
      await importFromContent(engine, HIDDEN.derived.slug, pageText('Derived', HIDDEN.derived.canary), { sourceId: OPEN_SRC });
      await importFromContent(engine, HIDDEN.derived2.slug, pageText('Derived twice', HIDDEN.derived2.canary), { sourceId: OPEN_SRC });
      await importFromContent(engine, HIDDEN.concept.slug, pageText('Harbor chat', HIDDEN.concept.canary, ['type: concept']), { sourceId: OPEN_SRC });
      const id = async (slug: string, sourceId: string) => String((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]))[0]!.id);
      const chatId = await id(CHAT_SLUG, IMSG);
      const derivedId = await id(HIDDEN.derived.slug, OPEN_SRC);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES
        ('pages', $1, 'pages', $2, $4), ('pages', $3, 'pages', $1, $4)`, [derivedId, chatId, await id(HIDDEN.derived2.slug, OPEN_SRC), OPEN_SRC]);
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'synthesized_from', 'concept-provenance')`,
        [Number(await id(HIDDEN.concept.slug, OPEN_SRC)), Number(chatId)]);
      await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-06-14', $2)`, [Number(chatId), `Harbor ledger planning notes ${TIMELINE}`]);
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, $2, $3, 'fact', 'world', 'fixture')`,
        [IMSG, OPEN.slug, `Harbor ledger planning notes ${FACT_IN_SOURCE}`]);
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, $2, $3, 'fact', 'world', 'fixture') RETURNING id`,
        [OPEN_SRC, OPEN.slug, `Harbor ledger planning notes ${FACT_DERIVED}`]);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('facts', $1, 'pages', $2, $3)`, [String(fact!.id), chatId, OPEN_SRC]);

      for (const member of [OWNER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [member]);
      const grant = [OPEN_SRC, IMSG, FLAGGED];
      const mint = async (name: string, bind: Parameters<typeof bindCredential>[2] | null, scopes = ['read'], sourceGrant = grant) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant });
        tokens[name] = minted.token;
        if (bind) await bindCredential(engine, { kind: 'token', id: minted.id }, bind);
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner', { member: OWNER, mayActFor: [`member:${OWNER}`, 'member:bob-example', 'guest'] }, ['read', 'write']);
      await mint('delegate', { member: OWNER });
      await mint('bob', { member: 'bob-example' }, ['read', 'write']);
      await mint('unbound', null);
      // Writers whose write floor (the grant's first source) is an owner-only source.
      await mint('owner-writes-messages', { member: OWNER }, ['read', 'write'], [IMSG, OPEN_SRC]);
      await mint('bob-writes-messages', { member: 'bob-example' }, ['read', 'write'], [IMSG, OPEN_SRC]);
      await mint('bob-writes-flagged', { member: 'bob-example' }, ['read', 'write'], [FLAGGED, OPEN_SRC]);
      await mint('unbound-writes-messages', null, ['read', 'write'], [IMSG, OPEN_SRC]);
      await mint('attested', { attestActor: 'qm', attestOps: ['get_page', 'list_pages', 'search', 'query', 'recall', 'get_timeline', 'delta'], readsUnscoped: true });
      await linkMember(engine, OWNER, 'qm', 'U0OWNER');
      // Every relaxation a token can carry: private pages and private facts of its granted sources.
      await engine.executeRaw(`UPDATE access_tokens SET private_pages = 'granted_sources', private_facts = 'granted_sources'`);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('fixture control: the trusted local CLI reads every owner-only page, fact and timeline row', async () => {
      const local = (op: string, params: Record<string, unknown>, sourceId = OPEN_SRC) =>
        dispatchToolCall(engine, op, params, { remote: false, sourceId }).then(o => o.content.map(c => c.text).join('\n'));
      for (const [key, h] of Object.entries(HIDDEN)) {
        const sourceId = key === 'chat' || key === 'plain' ? IMSG : key === 'flagged' ? FLAGGED : OPEN_SRC;
        expect({ key, seen: (await local('get_page', { slug: h.slug }, sourceId)).includes(h.canary) }).toEqual({ key, seen: true });
      }
      expect(await local('get_timeline', { slug: CHAT_SLUG }, IMSG)).toContain(TIMELINE);
      expect(await local('recall', { question: `Harbor ledger planning notes ${FACT_DERIVED}` })).toContain(FACT_DERIVED);
    }, 120_000);

    test('the owner and its delegate read the owner-only pages and facts remotely', async () => {
      for (const who of ['owner', 'delegate']) {
        const seen = new Set(Object.values(await seenBy(who)).flat());
        expect({ who, missing: ALL_CANARIES.filter(c => !seen.has(c)) }).toEqual({ who, missing: [] });
      }
    }, 240_000);

    for (const [name, settings] of Object.entries(RELAXATIONS)) {
      test(`relaxation ${name}: no other caller reads an owner-only page, a page or fact derived from one, or its timeline`, async () => {
        for (const [key, value] of settings) await engine.setConfig(key, value);
        __resetPrivateVisibilityCacheForTests();
        try {
          const callers: Array<[string, string, { header?: string; actor?: string }]> = [
            ['another member', 'bob', {}],
            ['an unbound token', 'unbound', {}],
            ['the owner for a shared room', 'owner', { header: `member:${OWNER},member:bob-example` }],
            ['the owner for a guest', 'owner', { header: 'guest' }],
            ['an attested call linked to the owner', 'attested', { actor: 'U0OWNER' }],
          ];
          for (const [label, who, ch] of callers) expect({ caller: label, seen: await seenBy(who, ch) }).toEqual({ caller: label, seen: {} });
          // The open page stays readable, so the empty result above is the rule and not a dead fixture.
          expect((await call('bob', 'get_page', { slug: OPEN.slug })).text).toContain(OPEN.canary);
        } finally {
          for (const [key] of settings) await engine.unsetConfig(key);
          __resetPrivateVisibilityCacheForTests();
        }
      }, 600_000);
    }

    test('a remote write into an owner-only source is refused for every credential but the owner\'s', async () => {
      const put = (who: string, sourceId: string, slug: string) => call(who, 'put_page', { slug, source_id: sourceId, content: pageText('Planted', 'canaryooplanted') });
      for (const [who, sourceId, slug] of [['bob-writes-messages', IMSG, HIDDEN.plain.slug], ['bob-writes-messages', IMSG, 'notes/planted'],
        ['unbound-writes-messages', IMSG, 'notes/planted'], ['bob-writes-flagged', FLAGGED, 'notes/planted']] as const) {
        const out = await put(who, sourceId, slug);
        expect({ who, slug, refused: out.isError, code: out.text.match(/"code": "([a-z_]+)"/)?.[1] }).toEqual({ who, slug, refused: true, code: 'page_not_found' });
        expect(out.text).not.toContain(HIDDEN.plain.canary);
      }
      // The control: the same credential writes its open source.
      expect((await put('bob', OPEN_SRC, 'notes/bob-wrote')).isError).toBe(false);
      expect((await dispatchToolCall(engine, 'get_page', { slug: HIDDEN.plain.slug }, { remote: false, sourceId: IMSG })).content.map(c => c.text).join('\n')).toContain(HIDDEN.plain.canary);
      const own = await put('owner-writes-messages', IMSG, 'notes/owner-wrote');
      expect({ refused: own.isError, text: own.isError ? own.text : '' }).toEqual({ refused: false, text: '' });
    }, 120_000);
    test('the v320 functions mark exactly the owner-only rows, the fail-closed form marks every row, and the migration names the same kinds', async () => {
      const verdicts = async (table: 'pages' | 'facts', sql: (alias: string, form: OwnerOnlyForm) => string) => engine.executeRaw<{ id: number; fn: boolean; closed: boolean }>(
        `SELECT r.id, ${sql('r', 'fn')} AS fn, ${sql('r', 'closed')} AS closed FROM ${table} r ORDER BY r.id`);
      const pages = await verdicts('pages', ownerOnlyPageSql);
      const facts = await verdicts('facts', ownerOnlyFactSql);
      const hiddenIds = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = ANY($1::text[])', [Object.values(HIDDEN).map(h => h.slug)])).map(r => r.id);
      const openId = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [OPEN.slug, OPEN_SRC]))[0]!.id;
      expect(hiddenIds.length).toBe(Object.keys(HIDDEN).length);
      expect(pages.filter(r => hiddenIds.includes(r.id) && !r.fn)).toEqual([]);
      expect(pages.find(r => r.id === openId)?.fn).toBe(false);
      expect(facts.some(r => r.fn)).toBe(true);
      // Without the functions (a schema below v320, or none recorded) a brain holding an owner-only source hides every row.
      expect([...pages, ...facts].every(r => r.closed)).toBe(true);
      // The function's kinds and flag are frozen in the migration; a new owner-only kind needs a new migration.
      expect(v320.sql).toContain(`IN (${OWNER_ONLY_KINDS.map(k => `'${k}'`).join(', ')})`);
      expect(v320.sql).toContain(`config->>'${OWNER_ONLY_FLAG}' = 'true'`);
    }, 120_000);
  });
}
