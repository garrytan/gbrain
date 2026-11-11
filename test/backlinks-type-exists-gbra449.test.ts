/**
 * GBRA-449 fix 1: get_backlinks' type filter accepts any page type the
 * caller can see in its scope, not only the types of this page's referrers.
 *
 * Protects (red before: type "contract" on contracts/c1 was refused with
 * 'unknown type "contract"' although six contract pages exist):
 *  - a type that visible pages have but no referrer of this page has answers
 *    the normal empty result (array mode and group: "page"), with an info
 *    notice naming the referrer types the page does have;
 *  - a type no page has is still refused and the refusal names the valid
 *    types;
 *  - a remote caller's "types that exist" come only from pages it can read: a
 *    type found only on a visibility: private page, a page whose readers
 *    omit the caller, a soft-deleted page or a page in a source outside its
 *    scope is refused and never named.
 * Database-only (repo-less) brain: every page is written straight to the
 * database with putPage, no checkout. PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { PageType } from '../src/core/types.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HIDDEN_TYPES = ['memo-private', 'memo-restricted', 'memo-deleted', 'memo-elsewhere'];

for (const backend of testBackends()) {
  describe('[' + backend + '] get_backlinks type filter: existing types answer empty (GBRA-449)', () => {
    let engine: BrainEngine;
    const config = { engine: backend } as never;
    const local = { remote: false, sourceId: 'default', config };
    const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
    }, 180_000);
    afterAll(async () => { await engine.disconnect(); });

    const put = (slug: string, type: string, body: string, opts: { frontmatter?: Record<string, unknown>; sourceId?: string } = {}) =>
      engine.putPage(slug, { type: type as PageType, title: slug, compiled_truth: body, timeline: '', frontmatter: opts.frontmatter ?? {} },
        opts.sourceId ? { sourceId: opts.sourceId } : undefined);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM links');
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      __resetPrivateVisibilityCacheForTests();
      for (let i = 1; i <= 6; i++) await put('contracts/c' + i, 'contract', 'Contract ' + i + '. Renewal date: 2026-08-0' + i + '.');
      await put('contracts/a1', 'amendment', 'Amendment to contracts/c1.');
      await engine.addLink('contracts/a1', 'contracts/c1', 'amends', 'mentions');
      await put('memos/private', 'memo-private', 'Private memo.', { frontmatter: { visibility: 'private' } });
      await put('memos/restricted', 'memo-restricted', 'Restricted memo.', { frontmatter: { readable_by: ['alice-example'] } });
      await put('memos/deleted', 'memo-deleted', 'Deleted memo.');
      await engine.softDeletePage('memos/deleted', { sourceId: 'default' });
      await put('memos/elsewhere', 'memo-elsewhere', 'Memo in another source.', { sourceId: 'source-b' });
    });

    async function call(args: Record<string, unknown>, opts: Record<string, unknown> = local) {
      const r = await dispatchToolCall(engine, 'get_backlinks', args, opts as never);
      const body = JSON.parse(r.content[0]!.text);
      const error = r.isError === true ? { message: String(body.message), valid: String(body.suggestion) + '\n' + String(body.detail) } : null;
      return { isError: r.isError === true, error, json: r.isError ? null : body, notices: r.content.slice(1).map(c => c.text).join('\n') };
    }

    test('a referrer type returns its link', async () => {
      const r = await call({ slug: 'contracts/c1', type: 'amendment' });
      expect(r.isError).toBe(false);
      expect(r.json.map((l: { from_slug: string }) => l.from_slug)).toEqual(['contracts/a1']);
    });

    test('a type other pages have but no referrer has answers empty, with a notice naming the referrer types', async () => {
      for (const opts of [local, remote]) {
        const arr = await call({ slug: 'contracts/c1', type: 'contract' }, opts);
        expect(arr.error).toBeNull();
        expect(arr.json).toEqual([]);
        expect(arr.notices).toContain('empty_retrieval');
        expect(arr.notices).toContain('amendment');
        const paged = await call({ slug: 'contracts/c1', type: 'contract', group: 'page' }, opts);
        expect(paged.error).toBeNull();
        expect(paged.json).toMatchObject({ rows: [], total: 0, truncated: false, cursor: null });
      }
    });

    test('a type no page has is still refused and names the valid types', async () => {
      for (const args of [{ slug: 'contracts/c1', type: 'bogus-kind' }, { slug: 'contracts/c1', type: 'bogus-kind', group: 'page' }]) {
        const r = await call(args);
        expect(r.error?.message).toBe('get_backlinks: unknown type "bogus-kind".');
        for (const valid of ['amendment', 'contract', 'untyped']) expect(r.error?.valid).toContain(valid);
      }
    });

    test('remote: a type only hidden pages have is refused and never named', async () => {
      for (const type of HIDDEN_TYPES) {
        for (const group of [undefined, 'page']) {
          const r = await call({ slug: 'contracts/c1', type, ...(group ? { group } : {}) }, remote);
          expect(r.error?.message).toBe('get_backlinks: unknown type "' + type + '".');
          for (const hidden of HIDDEN_TYPES) expect(r.error?.valid).not.toContain(hidden);
          expect(r.error?.valid).toContain('contract');
        }
      }
    });

    test('local: a private page type is accepted; a soft-deleted page type is refused and not named', async () => {
      const priv = await call({ slug: 'contracts/c1', type: 'memo-private' });
      expect(priv.error).toBeNull();
      expect(priv.json).toEqual([]);
      const gone = await call({ slug: 'contracts/c1', type: 'memo-deleted' });
      expect(gone.error?.message).toBe('get_backlinks: unknown type "memo-deleted".');
      expect(gone.error?.valid).not.toContain('memo-deleted');
    });
  });
}
