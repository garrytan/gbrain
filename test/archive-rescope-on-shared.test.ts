/**
 * Conversation archive pages written while a brain was personal name no readers. The commands that turn the brain
 * shared (gbrain access member add and member enable to a second enabled member, gbrain config set brain.audience
 * shared, gbrain access owner set on a shared brain) keep those pages to the owner at once, so a second member never
 * reads them remotely in the window before the next archive run or maintenance pass (maintenance.auto is off here).
 * Each case drives the brain shared through the CLI handler alone, then reads over the http dispatch as the second
 * member, as the owner and with an unbound token. In the owner set case the second member is added first on a brain
 * with no owner, so member add says why the pages wait (archive_rescope_owner_unset) and owner set applies it.
 * Repo-less; synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { runAccess } from '../src/commands/access.ts';
import { runConfig } from '../src/commands/config.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
const OWNER = 'alice-example';
const OTHER = 'bob-example';
const CANARIES = ['canaryharborqzx', 'canaryledgerwvk'] as const;
/** Words only the page body or its derived fact holds, never a query, so an echoed query is never read as a leak. */
const BODY_ONLY = { canaryharborqzx: 'bodyonlyharborjtq', canaryledgerwvk: 'bodyonlyledgerpfn' } as const;
const FACT_ONLY = { canaryharborqzx: 'factonlyharborxkd', canaryledgerwvk: 'factonlyledgerhmz' } as const;
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

const readsFor = (slug: string, canary: string): Array<[string, string, Record<string, unknown>]> => [
  ['get_page', 'get_page', { slug }],
  ['search keyword', 'search', { query: canary, match: 'keyword', fields: 'full', limit: 20 }],
  ['search hybrid', 'search', { query: 'planning notes ' + canary, fields: 'full', limit: 20 }],
  ['query', 'query', { query: 'planning notes ' + canary, expand: false, fields: 'full', limit: 20 }],
  ['recall (newest)', 'recall', { query: 'planning notes' }],
  ['recall (since)', 'recall', { since: '2000-01-01' }],
];

type Trigger = 'member add' | 'member enable' | 'config set brain.audience' | 'owner set';
const TRIGGERS: Trigger[] = ['member add', 'member enable', 'config set brain.audience', 'owner set'];

for (const kind of testBackends()) {
  for (const trigger of TRIGGERS) {
    describe('archive pages turn owner-only when ' + trigger + ' makes the brain shared (' + kind + ')', () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      const home = emptyHome();
      const pages: Array<{ slug: string; canary: typeof CANARIES[number] }> = [];
      const tokens: Record<string, string> = {};
      const ownerBefore: Record<string, boolean> = {};
      const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

      async function bind(name: string, member: string | null): Promise<void> {
        const minted = await mintLegacyToken(engine, { name: 'tok-' + name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }

      async function reads(who: string, canary: typeof CANARIES[number], op: string, params: Record<string, unknown>): Promise<boolean> {
        const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? 'default';
        const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
        const out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
        });
        const text = out.content.map(c => c.text ?? '').join('\n');
        return text.includes(BODY_ONLY[canary]) || text.includes(FACT_ONLY[canary]);
      }

      async function readMatrix(who: string): Promise<Record<string, boolean>> {
        __resetPrivateVisibilityCacheForTests();
        const out: Record<string, boolean> = {};
        for (const { slug, canary } of pages) {
          for (const [label, op, params] of readsFor(slug, canary)) out[canary + ' ' + label] = await reads(who, canary, op, params);
        }
        return out;
      }

      beforeAll(async () => {
        configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
        if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
        __resetPrivateVisibilityCacheForTests();
        await engine.setConfig('maintenance.auto', 'false');
        await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
        await setArchiveEnabled(engine, true);

        await addMember(engine, OWNER);
        if (trigger === 'member enable') { await addMember(engine, OTHER); await disableMember(engine, OTHER); }
        if (trigger !== 'owner set') await setOwner(engine, OWNER);

        const reader = staticReader('openclaw', [
          conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'harbor planning notes ' + CANARIES[0] + ' private ' + BODY_ONLY[CANARIES[0]]]], { chatType: 'direct', verified: true }),
          conversation('openclaw', 'agent:main:other', [['user', '2026-10-02T10:00:00.000Z', 'ledger planning notes ' + CANARIES[1] + ' private ' + BODY_ONLY[CANARIES[1]]]], { chatType: 'direct', verified: true }),
        ]);
        const first = await inHome(() => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-02', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }));
        expect(first.privacy).toBe('personal');
        const archived = await archivedPages(engine, SRC);
        for (const canary of CANARIES) {
          const page = archived.find(p => p.body.includes(canary));
          expect(page?.frontmatter.readable_by).toBeUndefined();
          pages.push({ slug: page!.slug, canary });
          await engine.insertFact({ fact: 'planning notes ' + FACT_ONLY[canary], kind: 'fact', source: 'test', visibility: 'world' }, { source_id: SRC });
          await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [page!.slug, '%' + FACT_ONLY[canary]]);
        }

        await bind('owner', OWNER);
        if (trigger !== 'owner set') Object.assign(ownerBefore, await readMatrix('owner'));

        await inHome(async () => {
          if (trigger === 'member add') await runAccess(engine, ['member', 'add', OTHER]);
          if (trigger === 'member enable') await runAccess(engine, ['member', 'enable', OTHER]);
          if (trigger === 'config set brain.audience') await runConfig(engine, ['set', 'brain.audience', 'shared']);
          if (trigger === 'owner set') {
            const stderr: string[] = [];
            const spy = spyOn(console, 'error').mockImplementation((...line: unknown[]) => { stderr.push(line.join(' ')); });
            try { await runAccess(engine, ['member', 'add', OTHER]); } finally { spy.mockRestore(); }
            expect(stderr.join('\n')).toContain('the shared brain names no owner; run gbrain access owner set <member>, which applies the owner-only rules at once.');
            expect(await archiveRescopeSkipped(engine)).toMatchObject({ code: 'archive_rescope_owner_unset' });
            await runAccess(engine, ['owner', 'set', OWNER]);
          }
        });
        if (trigger === 'config set brain.audience') await addMember(engine, OTHER);
        await bind('other', OTHER);
        await bind('unbound', null);
      }, 240_000);

      afterAll(async () => {
        __setEmbedTransportForTests(null);
        resetGateway();
        await disposePersistenceConsumer(engine).catch(() => {});
        await close?.();
      }, 60_000);

      test('the re-scope ran synchronously: no pending re-scope and the archive records the brain as shared', async () => {
        expect(await inHome(() => archiveRescopeSkipped(engine))).toBeNull();
        expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('shared');
      }, 60_000);

      test('the second member reads nothing from the personal-era pages through get_page, search, query or recall', async () => {
        const matrix = await readMatrix('other');
        expect(Object.entries(matrix).filter(([, read]) => read).map(([k]) => k)).toEqual([]);
        expect(Object.keys(matrix)).toHaveLength(CANARIES.length * 6);
      }, 240_000);

      test('a token bound to no member reads nothing from them either', async () => {
        const matrix = await readMatrix('unbound');
        expect(Object.entries(matrix).filter(([, read]) => read).map(([k]) => k)).toEqual([]);
      }, 240_000);

      test('the owner reads every archive page through every path, before and after', async () => {
        const after = await readMatrix('owner');
        expect(Object.entries(after).filter(([, read]) => !read).map(([k]) => k)).toEqual([]);
        if (trigger !== 'owner set') expect(ownerBefore).toEqual(after);
      }, 240_000);
    });
  }
}
