/**
 * Conversation archive pages written while a brain was personal name no readers. The commands that turn the brain
 * shared (gbrain access member add and member enable to a second enabled member, the same add and enable through the
 * admin API, gbrain access serves several, gbrain config set brain.audience shared, gbrain access owner set on a shared
 * brain) keep those pages to the owner at once, so a second member never
 * reads them remotely in the window before the next archive run or maintenance pass (maintenance.auto is off here).
 * Each case drives the brain shared through the CLI handler alone, then reads over the http dispatch as the second
 * member, as the owner and with an unbound token. In the owner set case the second member is added first on a brain
 * with no owner, so member add says why the pages wait (archive_rescope_owner_unset) and owner set applies it.
 * A member add while an archive run holds the source keeps the pages archived so far to the owner at once and leaves the
 * audience recorded personal, so the source's next run re-scopes what the run in flight wrote with no readers. Repo-less; synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember, getMember } from '../src/core/access/members.ts';
import * as policy from '../src/core/access/policy.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { runAccess } from '../src/commands/access.ts';
import { runConfig } from '../src/commands/config.ts';
import { mountAdminAccess } from '../src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../src/commands/serve-http-admin-api.ts';
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

type Trigger = 'member add' | 'member enable' | 'config set brain.audience' | 'owner set' | 'member add during an archive run'
  | 'access serves several' | 'admin member add' | 'admin member enable';
const TRIGGERS: Trigger[] = ['member add', 'member enable', 'config set brain.audience', 'owner set', 'member add during an archive run',
  'access serves several', 'admin member add', 'admin member enable'];

for (const kind of testBackends()) {
  for (const trigger of TRIGGERS) {
    describe('archive pages turn owner-only when ' + trigger + ' makes the brain shared (' + kind + ')', () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      const home = emptyHome();
      const pages: Array<{ slug: string; canary: typeof CANARIES[number] }> = [];
      const tokens: Record<string, string> = {};
      const ownerBefore: Record<string, boolean> = {};
      let adminAnswer: Record<string, unknown> | undefined;
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
        if (trigger === 'member enable' || trigger === 'admin member enable') { await addMember(engine, OTHER); await disableMember(engine, OTHER); }
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
          await engine.insertFact({ fact: 'planning notes ' + FACT_ONLY[canary], kind: 'fact', source: 'test', visibility: 'world', valid_from: new Date('2026-01-01') }, { source_id: SRC });
          await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [page!.slug, '%' + FACT_ONLY[canary]]);
        }

        await bind('owner', OWNER);
        if (trigger !== 'owner set') Object.assign(ownerBefore, await readMatrix('owner'));

        await inHome(async () => {
          if (trigger === 'member add') await runAccess(engine, ['member', 'add', OTHER]);
          if (trigger === 'member add during an archive run') {
            const lock = await tryAcquireDbLock(engine, 'transcripts-archive:' + SRC);
            const stderr: string[] = [];
            const spy = spyOn(console, 'error').mockImplementation((...line: unknown[]) => { stderr.push(line.join(' ')); });
            try { await runAccess(engine, ['member', 'add', OTHER]); } finally { spy.mockRestore(); await lock!.release(); }
            expect(stderr.join('\n')).toContain('pages archived so far are kept to the owner, but an archive run that started while this brain was personal is writing source ' + SRC + ' now');
          }
          if (trigger === 'member enable') await runAccess(engine, ['member', 'enable', OTHER]);
          if (trigger === 'access serves several') await runAccess(engine, ['serves', 'several', '--members', OTHER, '--yes', '--json']);
          if (trigger === 'admin member add' || trigger === 'admin member enable') {
            const app = express();
            app.use(cookieParser());
            mountAdminAccess(app, createRequireAdmin(new Map([['owner-session', Date.now() + 3_600_000]])), engine);
            const server = app.listen(0, '127.0.0.1');
            await new Promise<void>(r => server.once('listening', () => r()));
            try {
              const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/admin/api/access/members', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'gbrain_admin=owner-session' },
                body: JSON.stringify({ action: trigger === 'admin member add' ? 'add' : 'enable', id: OTHER }),
              });
              adminAnswer = await res.json() as Record<string, unknown>;
            } finally {
              server.closeAllConnections();
              await new Promise<void>(r => server.close(() => r()));
            }
          }
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

      test('the re-scope has run: nothing pending and the archive records the brain as shared', async () => {
        if (trigger === 'member add during an archive run') {
          expect(await inHome(() => archiveRescopeSkipped(engine))).toMatchObject({ code: 'archive_rescope_pending' });
          expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('personal');
          return;
        }
        expect(await inHome(() => archiveRescopeSkipped(engine))).toBeNull();
        expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('shared');
        if (trigger.startsWith('admin ')) expect(adminAnswer).toMatchObject({ applied: true, archive_rescope: [{ source_id: SRC, skipped: null }] });
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

      if (trigger === 'member add during an archive run') {
        test('the next archive run finishes the re-scope, and the second member still reads nothing', async () => {
          await inHome(() => runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('openclaw', [])], now: new Date('2026-10-05T00:00:00Z') }));
          expect(await inHome(() => archiveRescopeSkipped(engine))).toBeNull();
          expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('shared');
          const matrix = await readMatrix('other');
          expect(Object.entries(matrix).filter(([, read]) => read).map(([k]) => k)).toEqual([]);
        }, 240_000);
      }
    });
  }
}

/**
 * Order: access member add (--bind-token) and member enable keep the personal-era pages to the owner before the member
 * is added, enabled or bound, so its credentials never read them; a re-scope that throws leaves the member not enabled
 * and the token not bound. proposeRevision is the step that writes the owner-only rules.
 */
class Exited extends Error {}

for (const kind of testBackends()) {
  for (const door of ['member add --bind-token', 'member enable'] as const) {
    for (const mode of ['rules before the member', 'a failed re-scope changes nothing'] as const) {
      describe('archive re-scope order: ' + door + ', ' + mode + ' (' + kind + ')', () => {
        let engine: BrainEngine;
        let close: () => Promise<void>;
        let tokenId = '';
        const home = emptyHome();

        beforeAll(async () => {
          if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
          else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
          await engine.setConfig('maintenance.auto', 'false');
          await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
          await setArchiveEnabled(engine, true);
          await addMember(engine, OWNER);
          await setOwner(engine, OWNER);
          const reader = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'harbor planning notes ' + CANARIES[0]]], { chatType: 'direct', verified: true })]);
          await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }));
          const minted = await mintLegacyToken(engine, { name: 'tok-other', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
          tokenId = minted.id;
          if (door === 'member enable') {
            await addMember(engine, OTHER);
            await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OTHER });
            await disableMember(engine, OTHER);
          }
        }, 240_000);

        afterAll(async () => {
          await disposePersistenceConsumer(engine).catch(() => {});
          await close?.();
        }, 60_000);

        const boundTo = async () => (await engine.executeRaw<{ member_id: string | null }>('SELECT member_id FROM access_tokens WHERE id::text = $1', [tokenId]))[0]?.member_id ?? null;
        const argv = door === 'member enable' ? ['member', 'enable', OTHER] : ['member', 'add', OTHER, '--bind-token', 'tok-other'];

        test(mode, async () => {
          const original = policy.proposeRevision;
          const seen: Array<{ status: string | null; bound: string | null }> = [];
          const revision = spyOn(policy, 'proposeRevision').mockImplementation((async (...a: Parameters<typeof original>) => {
            seen.push({ status: (await getMember(engine, OTHER))?.status ?? null, bound: await boundTo() });
            if (mode === 'a failed re-scope changes nothing') throw new Error('rule store unavailable');
            return original(...a);
          }) as typeof original);
          const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exited(String(code)); }) as never);
          const stderr = spyOn(console, 'error').mockImplementation(() => {});
          let exited: unknown = null;
          try {
            await withEnv({ GBRAIN_HOME: home }, () => runAccess(engine, argv));
          } catch (e) {
            exited = e;
          } finally {
            revision.mockRestore();
            exit.mockRestore();
            stderr.mockRestore();
          }
          expect(seen.length).toBeGreaterThan(0);
          expect(seen[0]).toEqual(door === 'member enable' ? { status: 'disabled', bound: OTHER } : { status: null, bound: null });
          if (mode === 'rules before the member') {
            expect(exited).toBeNull();
            expect((await getMember(engine, OTHER))?.status).toBe('enabled');
            expect(await boundTo()).toBe(OTHER);
            expect(await withEnv({ GBRAIN_HOME: home }, () => archiveRescopeSkipped(engine))).toBeNull();
            return;
          }
          expect(exited).toBeInstanceOf(Exited);
          expect((exited as Exited).message).not.toBe('0');
          expect((await getMember(engine, OTHER))?.status ?? null).toBe(door === 'member enable' ? 'disabled' : null);
          expect(await boundTo()).toBe(door === 'member enable' ? OTHER : null);
          expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('personal');
        }, 240_000);
      });
    }
  }
}

/**
 * A member add that its own input checks refuse (a bad --kind, a malformed --email, an ill-formed group) changes nothing:
 * the access rules, the archive pages, the members table and an unbound token's archive reads stay exactly as they were,
 * because addMember runs the re-scope (beforeWrite) only after every input check has passed.
 */
for (const kind of testBackends()) {
  for (const [reason, extra] of [['a bad --kind', ['--kind', 'typo']], ['a malformed --email', ['--email', 'not-an-email']], ['an ill-formed group', ['--groups', 'Bad Group!']]] as const) {
    describe('a refused member add changes nothing: ' + reason + ' (' + kind + ')', () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      let token = '';
      let slug = '';
      const home = emptyHome();
      const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

      async function unboundReads(): Promise<Record<string, boolean>> {
        __resetPrivateVisibilityCacheForTests();
        const auth = await provider().verifyAccessToken(token) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? 'default';
        const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
        const out: Record<string, boolean> = {};
        for (const [label, op, params] of readsFor(slug, CANARIES[0]).filter(([l]) => l === 'get_page' || l === 'search keyword')) {
          const res = await dispatchToolCall(engine, op, { ...params }, {
            remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
            ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
          });
          out[label] = res.content.map(c => c.text ?? '').join('\n').includes(BODY_ONLY[CANARIES[0]]);
        }
        return out;
      }

      const snapshot = async () => ({
        rules: JSON.stringify(await policy.appliedRules(engine, SRC)),
        pages: await engine.executeRaw<{ j: string }>("SELECT row_to_json(p)::text AS j FROM pages p WHERE slug LIKE 'conversations/%' ORDER BY slug"),
        members: await engine.executeRaw<{ j: string }>('SELECT row_to_json(m)::text AS j FROM access_members m ORDER BY id'),
        audience: await engine.getConfig('transcripts.archive.audience.' + SRC),
        reads: await unboundReads(),
      });

      beforeAll(async () => {
        if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
        __resetPrivateVisibilityCacheForTests();
        await engine.setConfig('maintenance.auto', 'false');
        await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
        await setArchiveEnabled(engine, true);
        await addMember(engine, OWNER);
        await setOwner(engine, OWNER);
        const reader = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'harbor planning notes ' + CANARIES[0] + ' private ' + BODY_ONLY[CANARIES[0]]]], { chatType: 'direct', verified: true })]);
        await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }));
        slug = (await archivedPages(engine, SRC)).find(pg => pg.body.includes(CANARIES[0]))!.slug;
        token = (await mintLegacyToken(engine, { name: 'tok-unbound', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
      }, 240_000);

      afterAll(async () => {
        await disposePersistenceConsumer(engine).catch(() => {});
        await close?.();
      }, 60_000);

      test('the rules, the archive pages, the members and an unbound token\'s reads stay as they were', async () => {
        const before = await snapshot();
        expect(before.audience).toBe('personal');
        const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exited(String(code)); }) as never);
        const stderr = spyOn(console, 'error').mockImplementation(() => {});
        let exited: unknown = null;
        try {
          await withEnv({ GBRAIN_HOME: home }, () => runAccess(engine, ['member', 'add', OTHER, ...extra]));
        } catch (e) {
          exited = e;
        } finally {
          exit.mockRestore();
          stderr.mockRestore();
        }
        expect(exited).toBeInstanceOf(Exited);
        expect((exited as Exited).message).not.toBe('0');
        expect(await getMember(engine, OTHER)).toBeNull();
        expect(await snapshot()).toEqual(before);
      }, 240_000);
    });
  }
}
