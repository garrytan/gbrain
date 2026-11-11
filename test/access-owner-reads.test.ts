/**
 * GST-2059: the brain owner reads the whole personal brain over remote MCP.
 *
 * 1. Protects: a credential bound to the member config access.owner_member names (`gbrain access owner set`),
 *    and every delegate credential bound to the same member, reads visibility: private pages, privacy-alias pages
 *    (access: private), derived pages that default to private and private facts through get_page, search, query and
 *    recall. Every other caller keeps exactly the read policy it had: another member, an unbound token, the owner's
 *    credential speaking for a channel audience, and the owner after `gbrain access owner clear`. Member access
 *    (readable_by) stays mandatory for the owner too.
 * 2. Fails when: the owner's agent gets not_found for its own private pages, or any non-owner caller sees one.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch as serve-http-mcp does (remote: true), on a repo-less brain (no git checkout); embeddings stubbed.
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
import { __resetPrivateVisibilityCacheForTests, currentCallerAccess, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { clearOwner, ownerView, setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { accessCheck } from '../src/commands/access.ts';
import { openAsPreview } from '../src/cli/as-preview.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
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

const SRC = 'own-src';
const OWNER = 'owner-example';
/** Pages the owner reads and no other remote caller does. */
const PRIVATE = {
  flagged: { slug: 'notes/flagged-plan', canary: 'canaryownflag', fm: ['visibility: private'] },
  aliased: { slug: 'notes/aliased-plan', canary: 'canaryownalias', fm: ['access: private'] },
  derived: { slug: 'atoms/derived-plan', canary: 'canaryownatom', fm: ['type: atom', 'source_slug: notes/open-plan'] },
} as const;
type PrivateKey = keyof typeof PRIVATE;
const OPEN = { slug: 'notes/open-plan', canary: 'canaryownopen' };
/** Another person's page: member access keeps it from the owner too. */
const BOBS = { slug: 'notes/bob-plan', canary: 'canaryownbob' };
const PRIVATE_FACT = 'canaryownfact';
/** GST-2089: a private dated fact about a person, which think's trajectory reads. */
const PERSON = 'people/carol-example';
const PRIVATE_TRAJECTORY = 'canaryowntraj';
/** Private facts the owner must not read: one taken from another person's readable_by page, one in a source its grant does not read. */
const BOBS_FACT = 'canaryownbobfact';
const UNGRANTED_FACT = 'canaryownungranted';

const pageText = (title: string, canary: string, fm: readonly string[]) =>
  ['---', ...(fm.some(l => l.startsWith('type:')) ? [] : ['type: note']), `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary} for the roadmap.`].join('\n');

/** The four read paths the owner must have, each with arguments the page answers. */
function reads(slug: string): Array<[string, string, Record<string, unknown>]> {
  return [
    ['get_page', 'get_page', { slug }],
    ['search', 'search', { query: 'harbor ledger planning notes', fields: 'full', limit: 20 }],
    ['search keyword', 'search', { query: 'planning notes', match: 'keyword', fields: 'full', limit: 20 }],
    ['query', 'query', { query: 'harbor ledger planning notes', expand: false, fields: 'full', limit: 20 }],
    ['recall', 'recall', { query: 'harbor ledger planning notes' }],
  ];
}

for (const kind of testBackends()) {
  describe(`owner reads (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>, header?: string, extra: { metaHook?: typeof getBrainHotMemoryMeta } = {}): Promise<{ isError: boolean; text: string; meta: Record<string, unknown> | undefined }> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(header ? { onBehalfOf: { header } } : {}), ...extra,
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n'), meta: out._meta as Record<string, unknown> | undefined };
    }

    /** Which private pages `who` sees, per read path (get_page echoes the slug in its not_found, so content decides). */
    async function privateSeenBy(who: string, header?: string): Promise<Record<string, PrivateKey[]>> {
      const out: Record<string, PrivateKey[]> = {};
      for (const key of Object.keys(PRIVATE) as PrivateKey[]) {
        for (const [label, op, params] of reads(PRIVATE[key].slug)) {
          const { text } = await call(who, op, params, header);
          if (text.includes(PRIVATE[key].canary)) (out[label] ??= []).push(key);
        }
      }
      return out;
    }

    const ALL: Record<string, PrivateKey[]> = Object.fromEntries(reads('x').map(([label]) => [label, label === 'get_page' ? ['flagged', 'aliased', 'derived'] : ['flagged', 'aliased', 'derived']]));

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, OPEN.slug, pageText('Open plan', OPEN.canary, []), { sourceId: SRC });
      for (const key of Object.keys(PRIVATE) as PrivateKey[]) {
        await importFromContent(engine, PRIVATE[key].slug, pageText(`${key} plan`, PRIVATE[key].canary, PRIVATE[key].fm), { sourceId: SRC });
      }
      await importFromContent(engine, BOBS.slug, pageText('Bob plan', BOBS.canary, ['readable_by: [bob-example]']), { sourceId: SRC });
      const fact = await dispatchToolCall(engine, 'remember', { fact: `Harbor ledger planning notes ${PRIVATE_FACT}`, provenance: 'fixture', entity: OPEN.slug, visibility: 'private' }, { remote: false, sourceId: SRC });
      if (fact.isError) throw new Error(`fixture remember: ${fact.content.map(c => c.text).join(' ')}`);
      // think resolves trajectory entities in its scalar source, which is default for a caller with a source grant.
      for (const sourceId of [SRC, 'default']) await importFromContent(engine, PERSON, ['---', 'type: person', 'title: Carol Example', '---', '# Carol Example', '', 'Carol is a founder.'].join('\n'), { sourceId });
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, event_type)
        VALUES ($1, $2, $3, 'event', 'private', '2026-05-01T00:00:00Z', 'fixture', 'job_change')`, [SRC, PERSON, `Carol switched jobs ${PRIVATE_TRAJECTORY}`]);
      for (const [sourceId, canary, provenance] of [[SRC, BOBS_FACT, BOBS.slug], ['default', UNGRANTED_FACT, null]] as const) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, event_type, source_markdown_slug)
          VALUES ($1, $2, $3, 'event', 'private', '2026-06-01T00:00:00Z', 'fixture', 'job_change', $4)`, [sourceId, PERSON, `Harbor ledger planning notes ${canary}`, provenance]);
      }
      for (const id of [OWNER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string, mayActFor?: string[]) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member, ...(mayActFor ? { mayActFor } : {}) });
      };
      await mint('owner', OWNER, [`member:${OWNER}`, 'member:bob-example']);
      await mint('delegate', OWNER);
      await mint('bob', 'bob-example');
      await mint('unbound');
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('fixture control: a trusted local caller reads every private page and the private fact', async () => {
      for (const key of Object.keys(PRIVATE) as PrivateKey[]) {
        const out = await dispatchToolCall(engine, 'get_page', { slug: PRIVATE[key].slug }, { remote: false, sourceId: SRC });
        expect({ key, seen: out.content.map(c => c.text).join('\n').includes(PRIVATE[key].canary) }).toEqual({ key, seen: true });
      }
      const recall = await dispatchToolCall(engine, 'recall', { query: 'harbor ledger planning notes' }, { remote: false, sourceId: SRC });
      expect(recall.content.map(c => c.text).join('\n')).toContain(PRIVATE_FACT);
    });

    test('the owner and a delegate bound to the owner read every private page through get_page, search, query and recall', async () => {
      expect(await privateSeenBy('owner')).toEqual(ALL);
      expect(await privateSeenBy('delegate')).toEqual(ALL);
    }, 240_000);

    test('the owner recalls private facts; no other caller does', async () => {
      for (const who of ['owner', 'delegate']) expect({ who, seen: (await call(who, 'recall', { query: 'harbor ledger planning notes' })).text.includes(PRIVATE_FACT) }).toEqual({ who, seen: true });
      for (const who of ['bob', 'unbound']) expect({ who, seen: (await call(who, 'recall', { query: 'harbor ledger planning notes' })).text.includes(PRIVATE_FACT) }).toEqual({ who, seen: false });
    }, 120_000);

    /** GST-2089: which fact surfaces show `who` a private fact: the query facts arm, ranked recall, hot memory, delta, context_pack and think's trajectory. */
    async function privateFactsSeenBy(who: string, header?: string, canary = PRIVATE_FACT): Promise<string[]> {
      const seen: string[] = [];
      const surfaces: Array<[string, () => Promise<string>, string]> = [
        ['query', async () => (await call(who, 'query', { query: 'harbor ledger planning notes', expand: false, limit: 20 }, header)).text, canary],
        ['recall question', async () => (await call(who, 'recall', { question: `Harbor ledger planning notes ${canary}` }, header)).text, canary],
        ['recall entity question', async () => (await call(who, 'recall', { entity: OPEN.slug, question: `Harbor ledger planning notes ${canary}` }, header)).text, canary],
        ['hot memory', async () => JSON.stringify((await call(who, 'get_page', { slug: OPEN.slug }, header, { metaHook: getBrainHotMemoryMeta })).meta?.brain_hot_memory ?? null), canary],
        ['delta', async () => (await call(who, 'delta', { since: '2000-01-01T00:00:00Z' }, header)).text, canary],
        ['context_pack', async () => (await call(who, 'context_pack', { entities: OPEN.slug }, header)).text, canary],
        ['think trajectory', async () => (await call(who, 'think', { question: 'When did Carol last switch jobs?' }, header)).text.match(/TRAJECTORY_INJECTED_\d+_POINTS/)?.[0] ?? '', 'TRAJECTORY_INJECTED'],
      ];
      for (const [label, read, shown] of surfaces) if ((await read()).includes(shown)) seen.push(label);
      return seen;
    }
    const FACT_SURFACES = ['query', 'recall question', 'recall entity question', 'hot memory', 'delta', 'context_pack', 'think trajectory'];

    test('fixture control: a trusted local caller gets the private facts on every fact surface', async () => {
      const local = (op: string, params: Record<string, unknown>) => dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC }).then(o => o.content.map(c => c.text).join('\n'));
      expect(await local('recall', { question: `Harbor ledger planning notes ${PRIVATE_FACT}` })).toContain(PRIVATE_FACT);
      expect(await local('think', { question: 'When did Carol last switch jobs?' })).toMatch(/TRAJECTORY_INJECTED_\d+_POINTS/);
      expect(await local('recall', { question: `Harbor ledger planning notes ${BOBS_FACT}` })).toContain(BOBS_FACT);
      expect((await dispatchToolCall(engine, 'recall', { question: `Harbor ledger planning notes ${UNGRANTED_FACT}` }, { remote: false, sourceId: 'default' })).content.map(c => c.text).join('\n')).toContain(UNGRANTED_FACT);
    }, 120_000);

    test('GST-2089: the owner and its delegate get private facts on every fact surface; another member and an unbound token get world-only facts', async () => {
      __resetHotMemoryCacheForTests();
      for (const who of ['owner', 'delegate']) expect({ who, seen: await privateFactsSeenBy(who) }).toEqual({ who, seen: FACT_SURFACES });
      for (const who of ['bob', 'unbound']) expect({ who, seen: await privateFactsSeenBy(who) }).toEqual({ who, seen: [] });
    }, 240_000);

    test('GST-2089: the owner reads no private fact taken from another person\'s readable_by page or kept in a source its grant does not read', async () => {
      __resetHotMemoryCacheForTests();
      for (const canary of [BOBS_FACT, UNGRANTED_FACT]) expect({ canary, seen: (await privateFactsSeenBy('owner', undefined, canary)).filter(s => s !== 'think trajectory') }).toEqual({ canary, seen: [] });
      expect((await call('owner', 'think', { question: 'When did Carol last switch jobs?' })).text).toContain('TRAJECTORY_INJECTED_1_POINTS');
    }, 240_000);

    test('GST-2089: the owner speaking for itself alone keeps private facts; for a channel audience it gets world-only facts', async () => {
      __resetHotMemoryCacheForTests();
      expect(await privateFactsSeenBy('owner', `member:${OWNER}`)).toEqual(FACT_SURFACES);
      expect(await privateFactsSeenBy('owner', `member:${OWNER},member:bob-example`)).toEqual([]);
    }, 240_000);

    test('GST-2089: hot memory keys on the caller: after the owner warms the entry, the next caller with the same session reads world-only facts', async () => {
      const hot = async (who: string, header?: string) => JSON.stringify((await call(who, 'get_page', { slug: OPEN.slug }, header, { metaHook: getBrainHotMemoryMeta })).meta?.brain_hot_memory ?? null);
      for (const next of [['bob'], ['unbound'], ['owner', `member:${OWNER},member:bob-example`]] as const) {
        __resetHotMemoryCacheForTests();
        expect(await hot('owner')).toContain(PRIVATE_FACT);
        expect({ next, seen: (await hot(next[0], next[1])).includes(PRIVATE_FACT) }).toEqual({ next, seen: false });
      }
      // With privacy relaxed by the operator, the same credential after `gbrain access owner clear` shares the owner's
      // page tier and identity; the fact tier still keeps it off the owner's cached private facts.
      await engine.setConfig('search.remote_private_pages', 'visible');
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      try {
        expect(await hot('owner')).toContain(PRIVATE_FACT);
        await clearOwner(engine);
        expect(await hot('owner')).not.toContain(PRIVATE_FACT);
      } finally {
        await setOwner(engine, OWNER);
        await engine.unsetConfig('search.remote_private_pages');
        __resetPrivateVisibilityCacheForTests();
      }
    }, 120_000);

    test('another member and an unbound token still see no private page on any path, after the owner read them', async () => {
      expect(await privateSeenBy('bob')).toEqual({});
      expect(await privateSeenBy('unbound')).toEqual({});
    }, 240_000);

    test('member access stays mandatory for the owner: another person\'s readable_by page is not_found', async () => {
      const own = await call('owner', 'get_page', { slug: BOBS.slug });
      expect(own.text).not.toContain(BOBS.canary);
      expect((await call('bob', 'get_page', { slug: BOBS.slug })).text).toContain(BOBS.canary);
    });

    test('the owner speaking for a channel audience reads no private page; for itself alone it keeps the relaxation', async () => {
      expect(await privateSeenBy('owner', `member:${OWNER},member:bob-example`)).toEqual({});
      expect((await call('owner', 'get_page', { slug: PRIVATE.flagged.slug }, `member:${OWNER}`)).text).toContain(PRIVATE.flagged.canary);
    }, 240_000);

    test('_meta.access names the owner relaxation only for owner reads', async () => {
      const relaxation = async (who: string) => ((await call(who, 'get_page', { slug: OPEN.slug })).meta?.access as { relaxation?: string } | undefined)?.relaxation;
      expect(await relaxation('owner')).toBe('owner');
      expect(await relaxation('bob')).toBe('none');
      expect(await relaxation('unbound')).toBe('none');
    });

    test('access check and --as preview report the owner view', async () => {
      expect((await accessCheck(engine, { token: 'owner' })).owner).toBe(true);
      expect((await accessCheck(engine, { token: 'bob' })).owner).toBe(false);
      const asOwner = await openAsPreview(engine, OWNER, 'get');
      const page = await asOwner.run(() => dispatchToolCall(engine, 'get_page', { slug: PRIVATE.aliased.slug }, asOwner.context({ remote: false, sourceId: SRC })));
      expect(page.content.map(c => c.text).join('\n')).toContain(PRIVATE.aliased.canary);
      const asBob = await openAsPreview(engine, 'bob-example', 'get');
      const hidden = await asBob.run(() => dispatchToolCall(engine, 'get_page', { slug: PRIVATE.aliased.slug }, asBob.context({ remote: false, sourceId: SRC })));
      expect(hidden.content.map(c => c.text).join('\n')).not.toContain(PRIVATE.aliased.canary);
    });

    test('with no owner named, the owner\'s credential reads like any member again', async () => {
      expect((await ownerView(engine)).bound_credentials.map(c => c.name).sort()).toEqual(['delegate', 'owner']);
      await clearOwner(engine);
      try {
        expect(await privateSeenBy('owner')).toEqual({});
      } finally {
        await setOwner(engine, OWNER);
      }
    }, 240_000);

    test('setting a disabled or unknown member as owner is refused and leaves the owner unchanged', async () => {
      await expect(setOwner(engine, 'nobody-example')).rejects.toThrow();
      await expect(setOwner(engine, 'Not Valid')).rejects.toThrow();
      expect((await ownerView(engine)).owner).toBe(OWNER);
    });
  });
}

test('a fresh identity nested under the owner hides private pages unless it says otherwise', () => {
  const nested = withCallerAccess({ identity: ['member:owner-example'], hidePrivate: false, owner: true }, () =>
    withCallerAccess({ identity: ['member:bob-example'] }, () => currentCallerAccess()));
  expect(nested.owner).toBe(false);
  expect(nested.hidePrivate).toBe(true);
});
