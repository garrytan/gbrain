/**
 * GBRA-449 fix 2: list_pages with a type no page has explains its empty answer.
 *
 * Protects (red before: list_pages {type: "account"} on a brain of crm and
 * ticket pages returned a bare [] with nothing else):
 *  - an empty answer for a type no visible page has carries an
 *    empty_retrieval info notice naming the page types present, most pages
 *    first; the result stays the same bare array;
 *  - an empty answer for a type that exists (other filters excluded every
 *    row) and a non-empty answer carry no such notice;
 *  - a remote caller's notice names only types of pages it can read: a type
 *    found only on a visibility: private page, a page whose readers omit the
 *    caller, a soft-deleted page or a page in a source outside its scope is
 *    never named, and asking for one gets the notice too.
 * Database-only (repo-less) brain: pages are written with putPage, no
 * checkout. PGLite always, Postgres when DATABASE_URL is set.
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
  describe('[' + backend + '] list_pages: an empty answer for an unused type names the types present (GBRA-449)', () => {
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
      for (let i = 1; i <= 3; i++) await put('crm/acme-example-' + i, 'crm', 'CRM record ' + i + '.');
      for (let i = 1; i <= 2; i++) await put('tickets/t' + i, 'ticket', 'Ticket ' + i + '. Status: Escalated.');
      await put('memos/private', 'memo-private', 'Private memo.', { frontmatter: { visibility: 'private' } });
      await put('memos/restricted', 'memo-restricted', 'Restricted memo.', { frontmatter: { readable_by: ['alice-example'] } });
      await put('memos/deleted', 'memo-deleted', 'Deleted memo.');
      await engine.softDeletePage('memos/deleted', { sourceId: 'default' });
      await put('memos/elsewhere', 'memo-elsewhere', 'Memo in another source.', { sourceId: 'source-b' });
    });

    async function call(args: Record<string, unknown>, opts: Record<string, unknown> = local) {
      const r = await dispatchToolCall(engine, 'list_pages', args, opts as never);
      expect(r.isError).not.toBe(true);
      const notices = r.content.slice(1).map(c => c.text).join('\n');
      const empty = notices.split('\n').filter(line => line.includes('empty_retrieval')).length > 0 ? notices : '';
      return { json: JSON.parse(r.content[0]!.text), notices, empty };
    }

    test('a type no page has: the same bare array, plus a notice naming the types present, most pages first', async () => {
      const r = await call({ type: 'account' });
      expect(r.json).toEqual([]);
      expect(r.empty).toContain('"account"');
      expect(r.empty).toContain('crm');
      expect(r.empty).toContain('ticket');
      expect(r.empty.indexOf('crm')).toBeLessThan(r.empty.indexOf('ticket'));
    });

    test('a type that exists but other filters excluded every row: no such notice', async () => {
      const r = await call({ type: 'crm', tag: 'no-such-tag' });
      expect(r.json).toEqual([]);
      expect(r.empty).toBe('');
    });

    test('a non-empty answer: no notice', async () => {
      const r = await call({ type: 'crm' });
      expect(r.json.map((row: { slug: string }) => row.slug).sort()).toEqual(['crm/acme-example-1', 'crm/acme-example-2', 'crm/acme-example-3']);
      expect(r.empty).toBe('');
    });

    test('remote: the notice names only types of pages the caller can read', async () => {
      for (const type of ['account', ...HIDDEN_TYPES]) {
        const r = await call({ type }, remote);
        expect(r.json).toEqual([]);
        expect(r.empty).toContain('"' + type + '"');
        expect(r.empty).toContain('crm');
        const named = r.empty.split('"' + type + '"').slice(1).join('');
        for (const hidden of HIDDEN_TYPES) expect(named).not.toContain(hidden);
      }
    });

    test('the notice is best effort: a failed type count still answers the bare empty array', async () => {
      const countPagesBy = engine.countPagesBy.bind(engine);
      engine.countPagesBy = async () => { throw new Error('canceling statement due to statement timeout'); };
      try {
        for (const opts of [local, remote]) {
          const r = await call({ type: 'account' }, opts);
          expect(r.json).toEqual([]);
          expect(r.empty).toBe('');
        }
      } finally {
        engine.countPagesBy = countPagesBy;
      }
    });

    test('local: a private page type is listed; a soft-deleted page type gets the notice without naming itself', async () => {
      expect((await call({ type: 'memo-private' })).json.map((row: { slug: string }) => row.slug)).toEqual(['memos/private']);
      const gone = await call({ type: 'memo-deleted' });
      expect(gone.json).toEqual([]);
      expect(gone.empty).toContain('"memo-deleted"');
      expect(gone.empty.split('"memo-deleted"').slice(1).join('')).not.toContain('memo-deleted');
    });
  });
}
