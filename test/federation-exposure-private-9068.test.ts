/**
 * #9068 follow-up: the federation exposure warning counts only pages a no-grant connection would read.
 *
 * 1. Protects: a remote credential writes a `visibility: private` page with no readable_by into an isolated source.
 *    Federating the source does not make that page readable to a connection with no source grant (the read paths'
 *    privacy predicate hides it), so `sources federate` no longer names it; the open page it wrote still is. With
 *    search.remote_private_pages=visible the read paths show private pages, and the warning names it again.
 * 2. Fails when: the warning ignores the privacy predicate (it named the private page on master) or ignores the
 *    operator opt-out (it would stay silent about a page the floor then reads).
 * 3. Existing coverage: sources-federate-member-pages (PGLite, open pages only).
 * 4. Real seams: PGLite, and Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt); tokens from the token
 *    service verified by the OAuth provider, put_page and get_page through MCP dispatch, the real sources command;
 *    repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runSources } from '../src/commands/sources.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests, REMOTE_PRIVATE_PAGES_KEY } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SRC = 'source-a';
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const tokens = new Map<BrainEngine, Record<string, string>>();
const note = (title: string, body: string, extra: string[] = []) => ['---', 'type: note', 'title: ' + title, ...extra, '---', '# ' + title, '', body].join('\n');

async function call(engine: BrainEngine, who: string, op: string, params: Record<string, unknown>) {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(tokens.get(engine)![who]!) as unknown as AuthInfo;
  const sourceId = auth.sourceId ?? 'default';
  const localFederatedSourceIds = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'],
    ...(localFederatedSourceIds ? { localFederatedSourceIds } : {}) });
  return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
}

async function sources(engine: BrainEngine, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const warn = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try { await runSources(engine, args); } finally { log.mockRestore(); warn.mockRestore(); }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({ engine: 'pglite' } as never); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example')");
    const minted: Record<string, string> = {};
    for (const [name, member, grant] of [['alice', 'alice-example', [SRC, 'default']], ['public', null, undefined]] as const) {
      const t = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(grant ? { sourceGrant: [...grant] } : {}) });
      minted[name] = t.token;
      if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [t.id, member]);
    }
    tokens.set(engine, minted);
  }
}, 120_000);
afterAll(async () => { await engines.find(e => e.kind === 'pglite')?.disconnect(); await closePostgres?.(); }, 60_000);

describe('#9068 the federation exposure warning applies the read paths\' privacy predicate', () => {
  test('a private page with no readers is not named; the open page is; the opt-out names both', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      const canary = randomUUID().slice(0, 8);
      const hidden = 'notes/alice-private-' + canary, open = 'notes/alice-open-' + canary;
      expect((await call(engine, 'alice', 'put_page', { slug: hidden, content: note('Alice private', 'Private ' + canary + '.', ['visibility: private']), request_id: randomUUID() })).isError).toBe(false);
      expect((await call(engine, 'alice', 'put_page', { slug: open, content: note('Alice open', 'Open ' + canary + '.'), request_id: randomUUID() })).isError).toBe(false);
      const rows = await engine.executeRaw<{ slug: string; page_readers: unknown; visibility: string | null }>(
        "SELECT slug, page_readers, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id = $1 ORDER BY slug", [SRC]);
      expect(rows).toEqual([{ slug: open, page_readers: null, visibility: null }, { slug: hidden, page_readers: null, visibility: 'private' }]);

      const out = await sources(engine, ['federate', SRC, '--json']);
      expect({ engine: engine.kind, exposed: JSON.parse(out.stdout).pages_exposed }).toEqual({ engine: engine.kind, exposed: {
        count: 1, examples: [{ slug: open, member: 'alice-example' }],
        check: 'gbrain access who-can-read ' + open + ' --source ' + SRC,
        restrict: 'gbrain access rule add --prefix notes/ --readers alice-example --source ' + SRC } });
      expect((await call(engine, 'public', 'get_page', { slug: open, include_content: true })).text).toContain('Open ' + canary + '.');
      expect((await call(engine, 'public', 'get_page', { slug: hidden, include_content: true })).text).not.toContain('Private ' + canary + '.');

      await sources(engine, ['unfederate', SRC]);
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
      __resetPrivateVisibilityCacheForTests();
      try {
        const relaxed = await sources(engine, ['federate', SRC, '--json']);
        expect(JSON.parse(relaxed.stdout).pages_exposed).toMatchObject({ count: 2, examples: [{ slug: open }, { slug: hidden }] });
        expect((await call(engine, 'public', 'get_page', { slug: hidden, include_content: true })).text).toContain('Private ' + canary + '.');
      } finally {
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [REMOTE_PRIVATE_PAGES_KEY]);
        __resetPrivateVisibilityCacheForTests();
        await sources(engine, ['unfederate', SRC]);
      }
    }
  }, 240_000);
});
