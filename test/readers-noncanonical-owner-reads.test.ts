/**
 * The readers-key guard (`readers_noncanonical`, see test/readers-noncanonical.test.ts) never reduces what the brain
 * owner's own callers read: the local CLI and stdio (remote: false) and remote credentials bound to the owner member.
 *
 * Protects, on every backend `testBackends()` selects:
 *  - local and owner-bound remote reads (get_page, search) of ordinary pages and of `readable_by` pages answer exactly as
 *    they did before the guard existed;
 *  - a page already stored with a misspelled readers key (seeded through `engine.putPage`, which the guard does not
 *    cover) stays readable by the owner, local and remote, as before;
 *  - a refused write hides nothing from the owner: the page's earlier version is still readable, with its revision
 *    unchanged, and a refused new page leaves nothing behind; a member who is not listed never gets the refused content.
 *
 * Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP dispatch
 * as serve-http-mcp does, on a repo-less brain; embeddings stubbed.
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

const SRC = 'own-src';
const OWNER = 'owner-example';
const OTHER = 'bob-example';

const page = (title: string, canary: string, extra = '') =>
  `---\ntype: note\ntitle: ${title}\n${extra}---\n# ${title}\n\nHarbor ledger planning notes ${canary} for the roadmap.\n`;

const OPEN = { slug: 'notes/open-plan', canary: 'canaryrdopen', content: page('Open plan', 'canaryrdopen') };
/** Listed to the owner and to nobody else: the owner reads it, another member does not. */
const OWNERS = { slug: 'notes/owner-plan', canary: 'canaryrdowner', content: page('Owner plan', 'canaryrdowner', `readable_by: [${OWNER}]\n`) };
/** Listed to another member: member access is mandatory for the owner's remote credentials too, and the local caller still reads it. */
const BOBS = { slug: 'notes/bob-plan', canary: 'canaryrdbob', content: page('Bob plan', 'canaryrdbob', `readable_by: [${OTHER}]\n`) };
const MINE = { slug: 'notes/mine', first: 'canaryrdmineone', second: 'canaryrdminetwo' };
const FRESH = { slug: 'notes/fresh', canary: 'canaryrdfresh' };
const LEGACY = { slug: 'notes/legacy-misspelled', canary: 'canaryrdlegacy' };
const DIRECT = { slug: 'notes/direct-misspelled', canary: 'canaryrddirect' };

type Caller = 'local' | 'owner' | 'bob';

for (const kind of testBackends()) {
  describe(`readers key guard and the owner's reads (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: Caller, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      if (who === 'local') {
        const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: SRC });
        return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
      }
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** Whether `who` gets the canary through get_page and through search. */
    async function sees(who: Caller, slug: string, canary: string): Promise<{ get_page: boolean; search: boolean }> {
      const got = await call(who, 'get_page', { slug });
      const found = await call(who, 'search', { query: 'harbor ledger planning notes', fields: 'full', limit: 50 });
      return { get_page: !got.isError && got.text.includes(canary), search: found.text.includes(canary) };
    }

    const put = (slug: string, content: string, expectedRevision?: string) =>
      call('local', 'put_page', { slug, content, request_id: crypto.randomUUID(), wait_ms: 25_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) });
    const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC }))?.revision ?? null;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const seeded of [OPEN, OWNERS, BOBS]) await importFromContent(engine, seeded.slug, seeded.content, { sourceId: SRC });
      // A page stored before the guard existed: the guard governs put_page, edit_page and capture, so a direct engine write stores it as it always did.
      await importFromContent(engine, LEGACY.slug, page('Legacy misspelled', LEGACY.canary, `Readable_By: [${OTHER}]\n`), { sourceId: SRC });
      await engine.putPage(DIRECT.slug, { type: 'note', title: 'Direct misspelled', compiled_truth: `Harbor ledger planning notes ${DIRECT.canary} for the roadmap.`,
        frontmatter: { Readable_By: [OTHER] } }, { sourceId: SRC });
      for (const id of [OWNER, OTHER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      };
      await mint('owner', OWNER);
      await mint('bob', OTHER);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('ordinary and readable_by pages read exactly as before: the local caller reads all three, the owner reads its own and the open page, another member reads the open page and its own', async () => {
      const yes = { get_page: true, search: true };
      const no = { get_page: false, search: false };
      expect({
        local: [await sees('local', OPEN.slug, OPEN.canary), await sees('local', OWNERS.slug, OWNERS.canary), await sees('local', BOBS.slug, BOBS.canary)],
        owner: [await sees('owner', OPEN.slug, OPEN.canary), await sees('owner', OWNERS.slug, OWNERS.canary), await sees('owner', BOBS.slug, BOBS.canary)],
        bob: [await sees('bob', OPEN.slug, OPEN.canary), await sees('bob', OWNERS.slug, OWNERS.canary), await sees('bob', BOBS.slug, BOBS.canary)],
      }).toEqual({
        local: [yes, yes, yes],
        owner: [yes, yes, no],
        bob: [yes, no, yes],
      });
    }, 240_000);

    test('a page stored with a misspelled readers key before the guard stays readable by the owner, local and remote, as before', async () => {
      expect((await engine.getPage(LEGACY.slug, { sourceId: SRC }))?.frontmatter).toEqual({ Readable_By: [OTHER] });
      expect(await sees('local', LEGACY.slug, LEGACY.canary)).toEqual({ get_page: true, search: true });
      expect(await sees('owner', LEGACY.slug, LEGACY.canary)).toEqual({ get_page: true, search: true });
      // A page written straight through the engine (no chunks, so get_page only).
      for (const who of ['local', 'owner'] as const) expect({ who, direct: (await sees(who, DIRECT.slug, DIRECT.canary)).get_page }).toEqual({ who, direct: true });
    }, 120_000);

    test('a refused write leaves the owner\'s earlier version readable and unchanged, and no one else gets the refused content', async () => {
      const stored = await put(MINE.slug, page('Mine', MINE.first, `readable_by: [${OWNER}]\n`));
      expect(stored.isError).toBe(false);
      const before = await revision(MINE.slug);
      expect(before).not.toBeNull();
      const refused = await put(MINE.slug, page('Mine', MINE.second, `Readable_By: [${OWNER}]\n`), before!);
            expect({ isError: refused.isError, readers_noncanonical: refused.text.includes('readers_noncanonical') }).toEqual({ isError: true, readers_noncanonical: true });
      expect(await revision(MINE.slug)).toBe(before);
      for (const who of ['local', 'owner'] as const) {
        expect({ who, ...await sees(who, MINE.slug, MINE.first) }).toEqual({ who, get_page: true, search: true });
        expect({ who, ...await sees(who, MINE.slug, MINE.second) }).toEqual({ who, get_page: false, search: false });
      }
      expect({ ...await sees('bob', MINE.slug, MINE.first), refused: await sees('bob', MINE.slug, MINE.second) }).toEqual({ get_page: false, search: false, refused: { get_page: false, search: false } });
    }, 240_000);

    test('a refused new page leaves nothing for anyone to read, the owner included', async () => {
      const refused = await put(FRESH.slug, page('Fresh', FRESH.canary, `readable-by: [${OWNER}]\n`));
      expect({ isError: refused.isError, readers_noncanonical: refused.text.includes('readers_noncanonical') }).toEqual({ isError: true, readers_noncanonical: true });
      expect(await engine.readPageSnapshot(FRESH.slug, { sourceId: SRC, includeDeleted: true })).toBeNull();
      for (const who of ['local', 'owner', 'bob'] as const) expect({ who, ...await sees(who, FRESH.slug, FRESH.canary) }).toEqual({ who, get_page: false, search: false });
    }, 120_000);
  });
}
