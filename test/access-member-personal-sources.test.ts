/**
 * GST-3747: one member's personal sources stay away from other members' keys.
 *
 * 1. Protects: a source bound to a member (`gbrain access member source add`) is a personal source. A key bound to
 *    another, non-owner member that reads the federated floor (a legacy token with no source list) reads the floor minus
 *    every personal source bound to someone else, through get_page (named and unnamed), search, query, find_pages and
 *    source_id __all__; it keeps its own member's personal source. The owner's key, and every key bound to the owner,
 *    loses nothing. A key whose grant names another member's personal source keeps exactly what it names.
 *    A stdio server bound to a member takes the same rule. `access check` reports the same reads_now.
 * 2. Fails when: a member key reads another member's personal source through any of those reads, the owner's key or a
 *    named grant loses a source, or access check reports a read set dispatch does not apply.
 * 3. Existing coverage: test/qm-personal-sources.test.ts (attested calls), test/enforced-member.serial.test.ts (the
 *    enforced member CLI); test/access-member-personal-sources.serial.test.ts (the CLI, --as and a real serve --http).
 * 4. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch as serve-http-mcp does (remote: true, noGrantFederatedScope); repo-less brain; embeddings stubbed.
 *    PGLite always, Postgres when DATABASE_URL is set.
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

    test('a member key with no source list reads its own personal source and never another member\'s', async () => {
      expect(await seenBy('quin')).toEqual(readingExactly(['quin', 'team']));
      expect(await seenBy('pat')).toEqual(readingExactly(['pat', 'team']));
    }, 240_000);

    test('think, a read marked mutating for its local save, keeps a default source bound to another member away', async () => {
      await importFromContent(engine, 'chats/default-notes', '---\ntype: note\ntitle: chats/default-notes\n---\n# Chat\n\nThe plan zebracanarydefault is late.\n', { sourceId: 'default' });
      await bindMemberSource(engine, PAGES.pat.member, 'default');
      try {
        const reads = async (who: string) => (await call(who, 'think', { question: 'zebracanarydefault' })).text.includes('chats/default-notes');
        expect(await reads('quin')).toBe(false);
        expect(await reads('pat')).toBe(true);
        expect(await reads('owner')).toBe(true);
      } finally {
        await unbindMemberSource(engine, PAGES.pat.member, 'default', { apply: true });
      }
    }, 120_000);

    test('naming another member\'s personal source is refused like a source outside the grant', async () => {
      const named = await call('quin', 'get_page', { slug: PAGES.pat.slug, source_id: PAGES.pat.source });
      expect(named.isError).toBe(true);
      expect(named.text).toContain('permission_denied');
      expect(named.text).not.toContain(PAGES.pat.canary);
    }, 120_000);

    test('the owner\'s key and every key bound to the owner lose nothing', async () => {
      expect(await seenBy('owner')).toEqual(readingExactly(PERSONAL_KEYS));
      expect(await seenBy('owner-delegate')).toEqual(readingExactly(PERSONAL_KEYS));
    }, 240_000);

    test('a grant that names another member\'s personal source keeps exactly what it names', async () => {
      const named = await call('quin-named', 'get_page', { slug: PAGES.pat.slug, source_id: PAGES.pat.source });
      expect(named.text).toContain(PAGES.pat.canary);
      const found = await call('quin-named', 'search', { query: PAGES.pat.canary, match: 'keyword', fields: 'full' });
      expect(found.text).toContain(PAGES.pat.canary);
      const own = await call('quin-named', 'get_page', { slug: PAGES.quin.slug, source_id: PAGES.quin.source });
      expect(own.text).not.toContain(PAGES.quin.canary);
    }, 120_000);

    test('a stdio server bound to a member takes the same rule; one bound to the owner loses nothing', async () => {
      const floor = await localFederatedSourceIds(engine, 'default', 'seed_default');
      const viaStdio = async (member: string, key: PersonalKey) => (await dispatchToolCall(engine, 'search', { query: PAGES[key].canary, match: 'keyword', fields: 'full' }, {
        remote: true, transport: 'stdio', stdioMember: member, sourceId: 'default', localFederatedSourceIds: floor, takesHoldersAllowList: ['world'],
      })).content.map(x => x.text).join('\n').includes(PAGES[key].canary);
      expect(await viaStdio('quin-example', 'pat')).toBe(false);
      expect(await viaStdio('quin-example', 'quin')).toBe(true);
      expect(await viaStdio(OWNER_MEMBER, 'pat')).toBe(true);
      expect(await viaStdio(OWNER_MEMBER, 'owner')).toBe(true);
    }, 120_000);

    test('a key with no source list reads no default source bound to another member when nothing federates', async () => {
      const [{ config }] = await engine.executeRaw<{ config: unknown }>("SELECT config FROM sources WHERE id = 'default'");
      await engine.executeRaw(`UPDATE sources SET config = '{"federated": false}'::jsonb WHERE id = 'default'`);
      await importFromContent(engine, 'chats/default-only', '---\ntype: note\ntitle: chats/default-only\n---\n# Chat\n\nThe plan zebracanaryscalar is late.\n', { sourceId: 'default' });
      await bindMemberSource(engine, PAGES.pat.member, 'default');
      try {
        const reads = async (who: string) => (await call(who, 'get_page', { slug: 'chats/default-only' })).text.includes('zebracanaryscalar');
        expect(await reads('quin')).toBe(false);
        expect(await reads('pat')).toBe(true);
        expect(await reads('owner')).toBe(true);
      } finally {
        await unbindMemberSource(engine, PAGES.pat.member, 'default', { apply: true });
        await engine.executeRaw('UPDATE sources SET config = $1::jsonb WHERE id = \'default\'', [typeof config === 'string' ? config : JSON.stringify(config)]);
      }
    }, 120_000);

    test('a stdio server pinned to a source and bound to a member names no other member\'s personal source', async () => {
      const binding = await explicitReadBinding(engine, PAGES.team.source, 'env');
      expect(binding?.sourceIds).toContain(PAGES.pat.source);
      const named = async (member: string, key: PersonalKey) => (await dispatchToolCall(engine, 'get_page', { slug: PAGES[key].slug, source_id: PAGES[key].source }, {
        remote: true, transport: 'stdio', stdioMember: member, sourceId: PAGES.team.source, explicitReadBinding: binding, takesHoldersAllowList: ['world'],
      })).content.map(x => x.text).join('\n').includes(PAGES[key].canary);
      expect(await named('quin-example', 'pat')).toBe(false);
      expect(await named('quin-example', 'quin')).toBe(true);
      expect(await named(OWNER_MEMBER, 'pat')).toBe(true);
    }, 120_000);

    test('access check reports the read set dispatch applies', async () => {
      const readsNow = async (token: string) => (await accessCheck(engine, { token })).reads_now.slice().sort();
      expect(await readsNow('quin')).toEqual(['default', PAGES.quin.source, PAGES.team.source].sort());
      expect(await readsNow('pat')).toEqual(['default', PAGES.pat.source, PAGES.team.source].sort());
      expect(await readsNow('owner')).toEqual(['default', ...Object.values(PAGES).map(p => p.source)].sort());
      expect(await readsNow('quin-named')).toEqual([PAGES.pat.source, PAGES.team.source].sort());
      expect((await accessCheck(engine, { token: 'quin', as: 'quin-example' })).reads_now.slice().sort()).toEqual(['default', PAGES.quin.source, PAGES.team.source].sort());
    }, 120_000);
  });
}
