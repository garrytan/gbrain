/**
 * GST-2484: the owner exemption covers privacy, never member access, on every read path.
 *
 * 1. Protects: a credential bound to the brain owner (gbrain access owner set) reads a member-restricted page (one that
 *    names readers with readable_by, or sits under a folder rule) only when its readers list the owner, on every read
 *    path: get_page, list_pages, search (hybrid and keyword, fields: full), query and recall. That is the boundary
 *    docs/guides/access-designations.md documents for a shared brain. visibility: private stays readable by the owner.
 *    Each member keeps reading its own pages and the unlabelled one, and nothing else.
 * 2. Fails when: any read path returns another member's page to the owner, hides a page whose readers list the owner,
 *    or changes what a member reads.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true, transport http), a folder rule through the access policy, on a repo-less brain (no
 *    checkout); embeddings stubbed. PGLite, and Postgres with DATABASE_URL.
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
import { proposeRevision } from '../src/core/access/policy.ts';
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

const SRC = 'boundary-src';
const OWNER = 'owner-example';
const PAGES = {
  open: { slug: 'notes/open-example', canary: 'canarybndopen', fm: [] as string[] },
  private: { slug: 'notes/private-example', canary: 'canarybndprivate', fm: ['visibility: private'] },
  assistants: { slug: 'notes/assistants-example', canary: 'canarybndassist', fm: ['readable_by: [assistants-example]'] },
  shared: { slug: 'notes/shared-example', canary: 'canarybndshared', fm: [`readable_by: [assistants-example, ${OWNER}]`] },
  household: { slug: 'household/budget-example', canary: 'canarybndhouse', fm: [] as string[] },
  family: { slug: 'family/plan-example', canary: 'canarybndfamily', fm: [] as string[] },
} as const;
type PageKey = keyof typeof PAGES;
const KEYS = Object.keys(PAGES) as PageKey[];
const pageText = (title: string, canary: string, fm: readonly string[]) =>
  ['---', 'type: note', `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary} for the roadmap.`].join('\n');

/** Every read path, each with arguments every page answers. */
const READS: Array<[string, string, (slug: string) => Record<string, unknown>]> = [
  ['get_page', 'get_page', slug => ({ slug })],
  ['list_pages', 'list_pages', () => ({ limit: 100 })],
  ['search', 'search', () => ({ query: 'harbor ledger planning notes', fields: 'full', limit: 50 })],
  ['search keyword', 'search', () => ({ query: 'planning notes', match: 'keyword', fields: 'full', limit: 50 })],
  ['query', 'query', () => ({ query: 'harbor ledger planning notes', expand: false, fields: 'full', limit: 50 })],
  ['recall', 'recall', () => ({ query: 'harbor ledger planning notes' })],
];
/** What each caller must read on every path: list_pages names slugs, the others return the body. */
const EXPECTED: Record<string, PageKey[]> = {
  owner: ['open', 'private', 'shared', 'family'],
  assistants: ['open', 'assistants', 'shared'],
  household: ['open', 'household', 'family'],
};

for (const kind of testBackends()) {
  describe(`owner and member access (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return out.content.map(c => c.text).join('\n');
    }

    /** The pages `who` reads on each path. */
    async function seenBy(who: string): Promise<Record<string, PageKey[]>> {
      const out: Record<string, PageKey[]> = {};
      for (const [label, op, params] of READS) {
        const seen = new Set<PageKey>();
        if (op === 'get_page') {
          for (const key of KEYS) if ((await call(who, op, params(PAGES[key].slug))).includes(PAGES[key].canary)) seen.add(key);
        } else {
          const text = await call(who, op, params(''));
          for (const key of KEYS) if (text.includes(op === 'list_pages' ? PAGES[key].slug : PAGES[key].canary)) seen.add(key);
        }
        out[label] = KEYS.filter(key => seen.has(key));
      }
      return out;
    }
    const everywhere = (keys: PageKey[]) => Object.fromEntries(READS.map(([label]) => [label, KEYS.filter(key => keys.includes(key))]));

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const key of KEYS) await importFromContent(engine, PAGES[key].slug, pageText(`${key} plan`, PAGES[key].canary, PAGES[key].fm), { sourceId: SRC });
      for (const id of [OWNER, 'assistants-example', 'household-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await proposeRevision(engine, SRC, [
        { id: 'household', prefix: 'household/', readable_by: ['member:household-example'] },
        { id: 'family', prefix: 'family/', readable_by: ['member:household-example', `member:${OWNER}`] },
      ], { origin: 'cli', store: 'database' });
      for (const [name, member] of [['owner', OWNER], ['assistants', 'assistants-example'], ['household', 'household-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('fixture control: a trusted local caller reads every page', async () => {
      for (const key of KEYS) {
        const out = await dispatchToolCall(engine, 'get_page', { slug: PAGES[key].slug }, { remote: false, sourceId: SRC });
        expect({ key, seen: out.content.map(c => c.text).join('\n').includes(PAGES[key].canary) }).toEqual({ key, seen: true });
      }
    });

    test('the owner reads private pages and pages whose readers list it, and no other member\'s page, on every read path', async () => {
      expect(await seenBy('owner')).toEqual(everywhere(EXPECTED.owner!));
    }, 240_000);

    test('each member reads its own pages and the unlabelled one, and nothing else, on every read path', async () => {
      expect(await seenBy('assistants')).toEqual(everywhere(EXPECTED.assistants!));
      expect(await seenBy('household')).toEqual(everywhere(EXPECTED.household!));
    }, 240_000);
  });
}
