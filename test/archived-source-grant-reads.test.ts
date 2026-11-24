/**
 * GST-3163: an archived source reads as absent for every legacy bearer token whose grant names it. Before the fix a
 * token granted [default, source-a] still read source-a's pages after `gbrain sources archive source-a` whenever the
 * call named no source: get_page by bare slug returned the body and list_pages listed the page, while naming the source
 * answered unknown_source and search hid it. The grant's source set is now resolved against live sources at token
 * verification (grants/read-shared.ts tokenReadSources), for both HTTP paths that verify a legacy token: the
 * `serve` HTTP transport and the OAuth provider behind `serve --http`.
 *
 * Each read runs once before the archive (the control: the op reads the archived page's marker at all), after the
 * archive (nothing), and after `sources restore` (exactly the control again), for the owner's token, another member's
 * token and a token bound to nobody, plus a token that also reads every shared source. A token whose write source, or
 * every source, is archived reads nothing and answers unknown_source. The owner keeps reading the default source's page
 * through every op throughout.
 * Repo-less, keyless, synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { resolveTokenGrant } from '../src/core/grants/legacy-token.ts';
import { tokenReadSources } from '../src/core/grants/read-shared.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const OWNER = 'alice-example';
const OTHER = 'bob-example';
const DIMS = 1536;
const DAY = '2026-06-18';

/** Strings only the archived source's rows hold. Slugs count only on listing ops, where an error can't echo them. */
const ARCHIVED = { body: 'archivedbodyqzx', timeline: 'archivedtimelinewvk', raw: 'archivedrawjtq', fact: 'archivedfactpfn' };
const LIVE = { body: 'livebodyhmz', timeline: 'livetimelinexkd', raw: 'liverawbdq', fact: 'livefactcwy' };

type Read = [label: string, op: string, params: Record<string, unknown>, needles: string[]];
const readsOf = (m: typeof ARCHIVED, person: string, note: string): Read[] => [
  ['get_page', 'get_page', { slug: person }, [m.body]],
  ['list_pages', 'list_pages', { limit: 100 }, [person]],
  ['get_versions', 'get_versions', { slug: person, include_body: true }, [m.body]],
  ['get_backlinks', 'get_backlinks', { slug: person }, [note]],
  ['get_timeline', 'get_timeline', { slug: person }, [m.timeline]],
  ['find_pages', 'find_pages', { pattern: person.slice(0, -4) + '*' }, [person]],
  ['get_raw_data', 'get_raw_data', { slug: person }, [m.raw]],
  ['entity', 'entity', { name: person }, [m.body, m.fact]],
  ['recall', 'recall', { entity: person }, [m.fact]],
  ['chronicle_day', 'chronicle_day', { date: DAY }, [m.timeline]],
  ['chronicle_since', 'chronicle_since', { date: DAY }, [m.timeline]],
  ['resolve_slugs (naming the source)', 'resolve_slugs', { partial: person.split('/')[1], source_id: m === ARCHIVED ? SRC : 'default' }, [person]],
  ['assemble_evidence', 'assemble_evidence', { hits: [{ source_id: m === ARCHIVED ? SRC : 'default', slug: person, chunk_id: 0 }] }, [m.body]],
];
const ARCHIVED_READS = readsOf(ARCHIVED, 'people/carol-example', 'notes/retired-plan');
const LIVE_READS = readsOf(LIVE, 'people/dave-example', 'notes/current-plan');

const pageText = (title: string, body: string, link?: string) =>
  '---\ntype: person\ntitle: ' + title + '\n---\n# ' + title + '\n\nNotes ' + body + '.' + (link ? ' See [[' + link + ']].' : '') + '\n';

async function seed(engine: BrainEngine, sourceId: string, m: typeof ARCHIVED, person: string, note: string, name: string): Promise<void> {
  await importFromContent(engine, person, pageText(name, m.body), { sourceId });
  await importFromContent(engine, person, pageText(name, m.body + ' revised'), { sourceId });
  await importFromContent(engine, note, '---\ntype: note\ntitle: Plan\n---\n# Plan\n\nAbout [[' + person + ']].\n', { sourceId });
  await engine.addLink(note, person, 'mentions', undefined, 'manual', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
  await engine.addTimelineEntry(person, { date: DAY, summary: 'Met ' + m.timeline }, { sourceId });
  await engine.putRawData(person, 'test', { note: m.raw }, { sourceId });
  await engine.insertFact({ fact: 'Works on ' + m.fact, kind: 'fact', source: 'test', entity_slug: person, visibility: 'world' }, { source_id: sourceId });
}

for (const kind of testBackends()) {
  for (const audience of ['personal', 'shared'] as const) {
  describe('an archived source reads as absent for every legacy token that names it (' + audience + ' brain, ' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: { port: number; stop: (force?: boolean) => void };
    const tokens: Record<string, string> = {};
    const control: Record<string, Record<string, boolean>> = {};
    const ownerLive: Record<string, boolean> = {};
    let deltaBefore = '';
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    /** The `serve` HTTP transport, over the wire. */
    async function overHttp(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: params } }),
      });
      return await res.text();
    }

    /** The OAuth provider's legacy-token fallback behind `serve --http`. */
    async function overProvider(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
      });
      return out.content.map(c => c.text ?? '').join('\n') + JSON.stringify((out as { _meta?: unknown })._meta ?? null);
    }

    const PATHS = { http: overHttp, provider: overProvider } as const;

    async function matrix(who: string, reads: Read[]): Promise<Record<string, boolean>> {
      __resetPrivateVisibilityCacheForTests();
      const out: Record<string, boolean> = {};
      for (const [path, call] of Object.entries(PATHS)) {
        for (const [label, op, params, needles] of reads) {
          const text = await call(who, op, params);
          out[path + ' ' + label] = needles.some(n => text.includes(n));
        }
      }
      return out;
    }
    const keys = (m: Record<string, boolean>, read: boolean) => Object.entries(m).filter(([, r]) => r === read).map(([k]) => k);
    /** Every token's reads, as token -> the read labels where `read` held; {} entries mean none. */
    async function everyToken(reads: Read[], read: boolean): Promise<Record<string, string[]>> {
      const out: Record<string, string[]> = {};
      for (const who of Object.keys(tokens)) out[who] = keys(await matrix(who, reads), read);
      return out;
    }
    const none = () => Object.fromEntries(Object.keys(tokens).map(who => [who, [] as string[]]));

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => { const v = new Array<number>(DIMS).fill(0); v[0] = 1; return v; }) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated":true}'::jsonb)`, [SRC]);
      await seed(engine, SRC, ARCHIVED, 'people/carol-example', 'notes/retired-plan', 'Carol Example');
      await seed(engine, 'default', LIVE, 'people/dave-example', 'notes/current-plan', 'Dave Example');
      await addMember(engine, OWNER);
      await setOwner(engine, OWNER);
      const mint = async (name: string, member: string | null, grant: string[], readShared = false) => {
        const minted = await mintLegacyToken(engine, { name: 'tok-' + name, scopes: ['read'], takesHolders: ['world'], sourceGrant: grant, ...(readShared ? { readShared } : {}) });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      };
      if (audience === 'personal') await mint('unbound', null, ['default', SRC]);
      else { await addMember(engine, OTHER); await mint('other', OTHER, ['default', SRC]); }
      await mint('owner', OWNER, ['default', SRC]);
      await mint('write-first', OWNER, [SRC, 'default']);
      await mint('only-archived', OWNER, [SRC]);
      await mint('read-shared', OWNER, ['default'], true);
      server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } }) as never;
      for (const who of Object.keys(tokens)) control[who] = await matrix(who, ARCHIVED_READS);
      deltaBefore = await overHttp('write-first', 'delta', { since: '2000-01-01' });
      Object.assign(ownerLive, await matrix('owner', LIVE_READS));
      await softDeleteSource(engine, SRC);
    }, 240_000);

    afterAll(async () => {
      server?.stop(true);
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => {});
      await close?.();
    }, 60_000);

    test('before the archive every op reads the source-a page for every token (the control is not vacuous)', () => {
      expect(Object.fromEntries(Object.entries(control).map(([who, m]) => [who, keys(m, false)]))).toEqual(none());
    });

    test('get_page by bare slug does not return the archived page body', async () => {
      for (const who of Object.keys(tokens)) {
        for (const call of Object.values(PATHS)) expect(await call(who, 'get_page', { slug: 'people/carol-example' })).not.toContain(ARCHIVED.body);
      }
    });

    test('list_pages with no source_id does not list the archived page', async () => {
      for (const who of Object.keys(tokens)) {
        for (const call of Object.values(PATHS)) expect(await call(who, 'list_pages', { limit: 100 })).not.toContain('people/carol-example');
      }
    });

    test('no other page read reaches the archived source either, for any token', async () => {
      expect(await everyToken(ARCHIVED_READS, true)).toEqual(none());
    });

    test('naming the archived source still answers unknown_source for every token whose grant names it', async () => {
      for (const who of Object.keys(tokens).filter(w => w !== 'read-shared')) {
        for (const call of Object.values(PATHS)) {
          const text = await call(who, 'get_page', { slug: 'people/carol-example', source_id: SRC });
          expect(text).toContain('unknown_source');
          expect(text).not.toContain(ARCHIVED.body);
        }
      }
    });

    test('a token whose write source or every source is archived reads nothing and is told unknown_source', async () => {
      expect(deltaBefore).toContain('people/carol-example');
      for (const who of ['write-first', 'only-archived']) {
        for (const call of Object.values(PATHS)) {
          for (const [op, params] of [['delta', { since: '2000-01-01' }], ['list_pages', { limit: 100 }], ['get_page', { slug: 'people/dave-example' }]] as const) {
            const text = await call(who, op, params);
            expect([who, op, text.includes('unknown_source'), [ARCHIVED.body, LIVE.body, 'people/carol-example\\"', 'notes/'].some(n => text.includes(n))]).toEqual([who, op, true, false]);
          }
        }
      }
    });

    test('a token whose sources cannot be read fails closed instead of keeping its stored list', async () => {
      const [row] = await engine.executeRaw<Record<string, unknown>>("SELECT * FROM access_tokens WHERE name = 'tok-owner'");
      const grant = await resolveTokenGrant(sqlQueryForEngine(engine), row!);
      const fail = async (): Promise<never> => { throw new Error('sources unreadable'); };
      const failing = { readSharedSourceRows: fail, listSourceIds: fail, filterUnarchivedSourceIds: fail };
      await expect(tokenReadSources(failing, grant, async () => OWNER)).rejects.toThrow('sources unreadable');
    });

    test('the owner keeps reading the live source through every op', async () => {
      expect(keys(ownerLive, false)).toEqual([]);
      expect(await matrix('owner', LIVE_READS)).toEqual(ownerLive);
      expect(await matrix('read-shared', LIVE_READS)).toEqual(ownerLive);
    });

    test('sources restore brings the pages back for the same tokens', async () => {
      expect(await restoreSource(engine, SRC)).toBe(true);
      for (const who of Object.keys(tokens)) expect([who, await matrix(who, ARCHIVED_READS)]).toEqual([who, control[who]!]);
      expect(await matrix('owner', LIVE_READS)).toEqual(ownerLive);
    });
  });
  }
}
