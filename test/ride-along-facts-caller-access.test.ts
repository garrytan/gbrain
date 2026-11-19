/**
 * Facts that ride along with a read never reach a caller who may not read the page they are about.
 *
 * Four places return saved facts besides the fact reads themselves: the `_meta.brain_hot_memory` block on almost every
 * read, the "Saved facts" block search adds, memory_recall's fact rows and the entity card's recent_facts. For three
 * callers that are not the owner (a legacy token bound to a member, an OAuth client bound to that member, and a shared
 * agent acting for that member, or for a group, through X-Gbrain-On-Behalf-Of) and for a labelled-only member, each place is read
 * against one fact per case: its page sits under an owner-only folder rule, names only the owner in readable_by, is
 * visibility: private, sits in a source outside the caller's grant, or (for the labelled-only member) names nobody.
 * A fact on a page the caller may read is the control, so every place is shown to carry facts at all.
 * Repo-less, keyless, synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { addFolderRules } from '../src/commands/access-rules.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
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

const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const LABELLED = 'carol-example';
const OTHER_SOURCE = 'source-b';

const CASES = {
  'owner-only folder rule': { source: 'default', slug: 'owner-notes/harbor-plan', fm: '', canary: 'canaryfolderqzx' },
  'readable_by the owner': { source: 'default', slug: 'notes/harbor-readers', fm: 'readable_by: [alice-example]', canary: 'canaryreaderswvk' },
  'visibility private': { source: 'default', slug: 'notes/harbor-private', fm: 'visibility: private', canary: 'canaryprivatejtq' },
  'source outside the grant': { source: OTHER_SOURCE, slug: 'notes/harbor-elsewhere', fm: '', canary: 'canarysourcepfn' },
  'unlabelled page': { source: 'default', slug: 'notes/harbor-open', fm: '', canary: 'canaryopenhmz' },
  'labelled for carol': { source: 'default', slug: 'memory/members/carol-example', fm: 'readable_by: [carol-example]', canary: 'canarycarolxkd' },
} as const;
type Case = keyof typeof CASES;

const PLACES: Record<string, (slug: string) => Array<[string, Record<string, unknown>]>> = {
  'hot memory': () => [['list_pages', { limit: 5 }], ['search', { query: 'zzunrelatedqq', match: 'keyword' }], ['get_page', { slug: 'notes/harbor-plain' }]],
  'search saved facts': () => [['search', { query: 'harbor plan detail', match: 'keyword', limit: 20 }], ['search', { query: 'harbor plan detail', limit: 20 }]],
  'memory_recall': () => [['memory_recall', { query: 'harbor plan detail' }]],
  'entity recent_facts': slug => [['entity', { name: slug }]],
};

for (const kind of testBackends()) {
  describe('facts that ride along with a read follow the page they are about (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const CALLERS: Record<string, { token: string; header?: string }> = {
      'member token': { token: 'member-token' },
      'member OAuth client': { token: 'member-client' },
      'shared agent on behalf of the member': { token: 'agent', header: MEMBER },
      'shared agent on behalf of a group': { token: 'agent', header: 'group:team-a' },
      'labelled-only member token': { token: 'labelled-token' },
    };

    async function read(caller: string, op: string, params: Record<string, unknown>): Promise<string> {
      const { token, header } = CALLERS[caller]!;
      const auth = await provider().verifyAccessToken(tokens[token]!) as unknown as AuthInfo;
      __resetPrivateVisibilityCacheForTests();
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        metaHook: getBrainHotMemoryMeta, sessionId: 'ride-along-' + token + '-' + op + '-' + Math.random(),
        ...(header ? { onBehalfOf: { header } } : {}),
      });
      return JSON.stringify(out);
    }

    /** The cases whose fact `caller` gets from `place`. */
    async function seen(caller: string, place: string): Promise<Case[]> {
      const out = new Set<Case>();
      for (const key of Object.keys(CASES) as Case[]) {
        for (const [op, params] of PLACES[place]!(CASES[key].slug)) {
          if ((await read(caller, op, params)).includes(CASES[key].canary)) out.add(key);
        }
      }
      return [...out];
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated":false}'::jsonb)`, [OTHER_SOURCE]);
      await addMember(engine, OWNER);
      await addMember(engine, MEMBER, { groups: ['team-a'] });
      await addMember(engine, LABELLED);
      await setOwner(engine, OWNER);
      await setMemberLabelledOnly(engine, LABELLED, true, { remote: false });
      await addFolderRules(engine, 'default', [{ id: 'owner-notes', prefix: 'owner-notes/', readable_by: [OWNER] }], { apply: true, json: true });
      await importFromContent(engine, 'notes/harbor-plain', '---\ntype: note\ntitle: Plain\nreadable_by: [bob-example, carol-example]\n---\n# Plain\n\nNothing here.\n', { sourceId: 'default' });
      for (const c of Object.values(CASES)) {
        await importFromContent(engine, c.slug, '---\ntype: note\ntitle: Harbor plan\n' + (c.fm ? c.fm + '\n' : '') + '---\n# Harbor plan\n\nA plan.\n', { sourceId: c.source });
        await engine.insertFact({ fact: 'Harbor plan detail ' + c.canary, kind: 'fact', source: 'test', entity_slug: c.slug, visibility: 'world' }, { source_id: c.source });
        await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [c.slug, '%' + c.canary]);
      }
      const mint = async (name: string, binding: { member?: string; mayActFor?: string[] }) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
      };
      await mint('member-token', { member: MEMBER });
      await mint('agent', { mayActFor: ['member:' + MEMBER, 'group:team-a'] });
      await mint('labelled-token', { member: LABELLED });
      const client = await provider().registerClientManual('member-client', ['client_credentials'], 'read', [], 'default');
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: MEMBER });
      tokens['member-client'] = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret ?? '')).access_token;
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => {});
      await close?.();
    }, 60_000);

    for (const place of Object.keys(PLACES)) {
      for (const caller of Object.keys(CALLERS)) {
        const allowed: Case[] = caller.startsWith('labelled') ? ['labelled for carol'] : ['unlabelled page'];
        test(place + ': ' + caller + ' gets facts only about pages it may read', async () => {
          expect(await seen(caller, place)).toEqual(allowed);
        }, 120_000);
      }
    }
  });
}
