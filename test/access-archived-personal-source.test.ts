/**
 * Sync 17 privacy proof for the member-floor port (member-sources.ts hiddenPersonalSources reads the owners through the typed
 * readSharedSourceRows member, which lists live sources only): another member's key still cannot read, list or search an
 * ARCHIVED personal source of a different member, through any read path of test/access-member-personal-sources.test.ts, and
 * `--as` (openAsPreview) lists no archived source among what the member reads.
 * Fails when: a member key reads (get_page named or unnamed, search, search __all__, query, find_pages) a page whose personal
 * source is archived; or the --as preview of a member counts the archived source as visible.
 * Seams: the same real tokens and MCP dispatch as the live-source test; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { explicitReadBinding, localFederatedSourceIds, noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource, unbindMemberSource } from '../src/core/access/member-sources.ts';
import { accessCheck } from '../src/commands/access.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { OWNER_MEMBER, PERSONAL_KEYS, PERSONAL_PAGES, personalPageText, personalReads, readNames, readingExactly, type PersonalKey } from './helpers/personal-sources-fixture.ts';

const DIMS = 1536;
const PAGES = PERSONAL_PAGES;

for (const kind of testBackends()) {
  describe(`member keys and personal sources (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** Per read path, the pages `who` reads. */
    async function seenBy(who: string): Promise<Record<string, PersonalKey[]>> {
      const out: Record<string, PersonalKey[]> = {};
      for (const key of PERSONAL_KEYS) {
        for (const [label, op, params] of personalReads(key)) {
          const { text } = await call(who, op, params);
          (out[label] ??= []);
          if (readNames(label, text, key)) out[label]!.push(key);
        }
      }
      return out;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const key of PERSONAL_KEYS) {
        const p = PAGES[key];
        await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [p.source]);
        await importFromContent(engine, p.slug, personalPageText(key), { sourceId: p.source });
      }
      for (const p of Object.values(PAGES)) if (p.member) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [p.member]);
      await setOwner(engine, OWNER_MEMBER);
      for (const p of Object.values(PAGES)) if (p.member) await bindMemberSource(engine, p.member, p.source);
      const keys: Array<[string, string, string[] | undefined]> = [
        ['owner', 'owner-example', undefined], ['owner-delegate', 'owner-example', undefined],
        ['pat', 'pat-example', undefined], ['quin', 'quin-example', undefined],
        ['quin-named', 'quin-example', [PAGES.team.source, PAGES.pat.source]],
      ];
      for (const [name, member, sourceGrant] of keys) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], ...(sourceGrant ? { sourceGrant } : {}) });
        tokens[name] = minted.token;
        await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    const archivedReads = async (who: string) => {
      const seen: Record<string, boolean> = {};
      for (const [label, op, params] of personalReads('pat')) {
        const { text } = await call(who, op, params);
        seen[label] = readNames(label, text, 'pat');
      }
      return seen;
    };
    const noneRead = Object.fromEntries(personalReads('pat').map(([label]) => [label, false]));

    test('control: before the archive, quin reads none of pat\'s source and pat reads it', async () => {
      expect(await archivedReads('quin')).toEqual(noneRead);
      expect((await archivedReads('pat'))['get_page named']).toBe(true);
    }, 240_000);

    test('after pat\'s personal source is archived, no other key reads, lists or searches it', async () => {
      await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [PAGES.pat.source]);
      __resetPrivateVisibilityCacheForTests();
      try {
        expect(await archivedReads('quin')).toEqual(noneRead);
        const named = await call('quin', 'get_page', { slug: PAGES.pat.slug, source_id: PAGES.pat.source });
        expect(named.text).not.toContain(PAGES.pat.canary);
        // the member keys that read the floor never see it either, and the owner's own reads are not the subject here
        expect(await archivedReads('quin-named')).toEqual(expect.objectContaining({ search: false, query: false, 'find_pages': false }));
      } finally {
        await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [PAGES.pat.source]);
        __resetPrivateVisibilityCacheForTests();
      }
    }, 240_000);

    test('--as quin counts no archived source among the sources quin reads', async () => {
      await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [PAGES.pat.source]);
      try {
        const { hiddenPersonalSources } = await import('../src/core/access/member-sources.ts');
        const live = (await engine.listAllSources()).map(s => s.id);
        // the preview's visible set is the live sources minus the hidden personal ones: an archived source is not live
        expect(live).not.toContain(PAGES.pat.source);
        const hidden = await hiddenPersonalSources(engine, live, PAGES.quin.member!, false);
        expect(live.filter(s => !hidden.has(s))).not.toContain(PAGES.pat.source);
        expect(live.filter(s => !hidden.has(s))).toContain(PAGES.quin.source);
      } finally {
        await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [PAGES.pat.source]);
      }
    }, 120_000);
  });
}
