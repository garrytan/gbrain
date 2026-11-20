/**
 * The page visibility guards (engine-sql/page-visibility.ts) send Postgres the statement persistence/page-visibility.ts
 * sent through `executeRaw` before they became typed members: the same text and the same bound values.
 *
 * Protects: remoteTargetHidden, remotePageAccess, the reason path's world-visibility read (persistence/change-reason.ts), authorizePageVisibility's probe and storedOwnerSpeaksForItself keep
 * their exact Postgres statements,
 * under the no-caller rendering and under a caller with a reader identity and a private-readable grant.
 * Fails when a member's text or parameter order drifts from the statement the caller wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { callerAccessAllowedSql, privatePagesFilterForCaller, privatePagesFilterFragment, readPolicyFragment, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { ANY_OWNER_ONLY_SQL, OWNER_ONLY_LINEAGE_PRESENT_SQL, ownerOnlyLineageReadable, ownerOnlySourceSql } from '../src/core/access/owner-only.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const CALLERS = {
  none: null,
  member: { identity: ['member:alice-example', 'group:team-a'], privateReadableSources: ['default'], hidePrivate: true },
} as const;

/** The (text, params) of every statement `fn` sends that touches `table`. */
async function sent(table: RegExp, fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' && table.test(s.text) ? [{ text: s.text, params: s.params }] : []));
}

describe('page visibility guards send the hand-written Postgres statement', () => {
  for (const [name, caller] of Object.entries(CALLERS)) {
    const under = <T>(fn: () => Promise<T>) => (caller ? withCallerAccess(caller, fn) : fn());
    for (const [part, render] of [['read', privatePagesFilterForCaller], ['access', callerAccessAllowedSql]] as const) {
      test(`readPageHiddenFromCaller, ${part} part, ${name} caller`, async () => {
        const old = await sent(/FROM pages/, e => under(() =>
          e.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND NOT ${render('pages')} LIMIT 1`, ['default', 'notes/a'])));
        const typed = await sent(/FROM pages/, e => under(() => e.readPageHiddenFromCaller('default', 'notes/a', { policy: part })));
        expect(old).toHaveLength(1);
        expect(typed).toEqual(old);
      });

      test(`readCallerPageAccess, ${part} part, ${name} caller`, async () => {
        const pages = [{ source_id: 'default', slug: 'notes/a' }, { source_id: 'other', slug: 'notes/b' }];
        const old = await sent(/FROM pages/, e => under(() => e.executeRaw(`SELECT p.source_id, p.slug,
      bool_or(p.deleted_at IS NULL AND ${render('p')}) AS readable FROM pages p
    JOIN unnest($1::text[], $2::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
    GROUP BY p.source_id, p.slug`, [pages.map(p => p.source_id), pages.map(p => p.slug)])));
        const typed = await sent(/FROM pages/, e => under(() => e.readCallerPageAccess(pages, { policy: part })));
        expect(old).toHaveLength(1);
        expect(typed).toEqual(old);
      });
    }
  }

  for (const [name, caller] of Object.entries(CALLERS)) {
    test(`readPageWorldVisible, ${name} caller`, async () => {
      const under = <T>(fn: () => Promise<T>) => (caller ? withCallerAccess(caller, fn) : fn());
      const old = await sent(/FROM pages/, e => under(() => e.executeRaw(
        `SELECT ${privatePagesFilterFragment('p')} AS world FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, ['default', 'notes/a'])));
      const typed = await sent(/FROM pages/, e => under(() => e.readPageWorldVisible('default', 'notes/a')));
      expect(old).toHaveLength(1);
      expect(typed).toEqual(old);
    });
  }

  for (const [name, caller] of Object.entries(CALLERS)) {
    test(`readWriteVisibilityProbe, ${name} caller`, async () => {
      const under = <T>(fn: () => Promise<T>) => (caller ? withCallerAccess(caller, fn) : fn());
      const old = await sent(/access_members/, e => under(() => e.executeRaw(
        `SELECT EXISTS (SELECT 1 FROM access_members WHERE labelled_only) AS any_labelled, (${`SELECT (page_readers IS NOT NULL OR folder_rule_ids IS NOT NULL) FROM pages
      WHERE source_id=$1 AND slug=$2 AND NOT (${readPolicyFragment('pages', [], true)}) LIMIT 1`}) AS identity_may_open,
          ${ownerOnlySourceSql('$1')} AS owner_only_source, ${
          // #9689: the any-owner-only test reads the v320 lineage function (marks a hard delete left) unless the schema predates it.
          ownerOnlyLineageReadable(e) ? OWNER_ONLY_LINEAGE_PRESENT_SQL : ANY_OWNER_ONLY_SQL} AS owner_only_any`, ['default', 'notes/a'])));
      const typed = await sent(/access_members/, e => under(() => e.readWriteVisibilityProbe('default', 'notes/a')));
      expect(old).toHaveLength(1);
      // The same statement, with the source id bound again for the owner-only source test instead of reusing $1.
      const owner = `read_source.id = $1 AND`;
      expect(old[0].text.split(owner)).toHaveLength(2);
      expect(typed).toEqual([{ text: old[0].text.replace(owner, 'read_source.id = $3 AND'), params: [...old[0].params, 'default'] }]);
    });
  }

  test('readWriterSlugFence reads the OAuth client or local writer row, and nothing for another kind', async () => {
    const fence = /oauth_clients|persistence_local_writers/;
    const oauth = await sent(fence, e => e.readWriterSlugFence({ kind: 'oauth_client', id: 'client-a' }));
    expect(oauth).toEqual([{ text: 'SELECT bound_slug_prefixes AS prefixes FROM oauth_clients WHERE client_id=$1', params: ['client-a'] }]);
    for (const kind of ['local_cli', 'local_stdio']) {
      const local = await sent(fence, e => e.readWriterSlugFence({ kind, id: 'a0000000-0000-4000-8000-0000000000c1' }));
      expect(local).toEqual([{
        text: "SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid",
        params: ['a0000000-0000-4000-8000-0000000000c1'],
      }]);
    }
    expect(await sent(fence, e => e.readWriterSlugFence({ kind: 'member', id: 'x' }))).toEqual([]);
  });
});
