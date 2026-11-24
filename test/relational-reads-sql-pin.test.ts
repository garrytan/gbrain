/**
 * The relational recall arm's seed admit read, hydrate read and title seed read (engine-sql/relational-reads.ts) send Postgres the statement
 * search/relational-recall.ts sent through `executeRaw` before it became a typed member: the same text and the
 * same bound values, for each read policy shape.
 *
 * Protects: the relational arm keeps its exact Postgres access read, with every filter ahead of the result.
 * Fails when the member's text or parameter order drifts from the statement the arm wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { pageReadFilter } from '../src/core/search/read-policy-sql.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import type { PageReadPolicy } from '../src/core/types.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The (text, params) of every statement `fn` sends that reads `pages`. */
async function sent(fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' && /FROM pages/.test(s.text) ? [{ text: s.text, params: s.params }] : []));
}

const REFS = [
  { source_id: 'default', slug: 'companies/a' },
  { source_id: 'other', slug: 'companies/b' },
];

const POLICIES: Array<[string, PageReadPolicy]> = [
  ['scoped', { sourceId: 'default' }],
  ['federated', { sourceIds: ['default', 'other'] }],
  ['hidden', { excludePrivate: true }],
  ['floor', { minTrust: 'unknown', suppressFlagged: true }],
  ['holders', { takesHoldersAllowList: ['member:alice-example'], requireSafeChunks: true }],
];

describe('the relational seed admit read sends the hand-written Postgres statement', () => {
  for (const [name, policy] of POLICIES) {
    test(`readAdmittedPageRefs (${name})`, async () => {
      const old = await sent(e => {
        const params: unknown[] = [REFS.map(ref => ref.source_id), REFS.map(ref => ref.slug)];
        const filter = pageReadFilter('p', policy, params, true);
        return e.executeRaw(
          `SELECT p.source_id, p.slug FROM pages p
     JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug)
       ON p.source_id = refs.source_id AND p.slug = refs.slug WHERE ${filter}`, params,
        );
      });
      const typed = await sent(e => e.readAdmittedPageRefs(REFS, policy));
      expect(old).toHaveLength(1);
      expect(typed).toEqual(old);
    });
  }

  test('readAdmittedPageRefs sends nothing for no refs', async () => {
    expect(await sent(e => e.readAdmittedPageRefs([], { sourceId: 'default' }))).toEqual([]);
  });

  for (const [name, policy] of [...POLICIES, ['none', {}] as [string, PageReadPolicy]]) {
    test(`readPageSynopses (${name})`, async () => {
      const old = await sent(e => {
        const params: unknown[] = [REFS.map(r => r.source_id), REFS.map(r => r.slug)];
        const filter = pageReadFilter('p', policy, params);
        return e.executeRaw(
          `SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            ${boundedBodyPrefixSql('p')} AS synopsis
     FROM pages p
     JOIN sources s ON s.id = p.source_id
     JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug)
       ON p.source_id = refs.source_id AND p.slug = refs.slug
     WHERE ${filter} ${buildVisibilityClause('p', 's', { excludePrivate: policy.excludePrivate, requireSafeChunks: false })}`,
          params,
        );
      });
      const typed = await sent(e => e.readPageSynopses(REFS, policy));
      expect(old).toHaveLength(1);
      expect(typed).toEqual(old);
    });
  }

  test('readPageSynopses sends nothing for no refs', async () => {
    expect(await sent(e => e.readPageSynopses([], { sourceId: 'default' }))).toEqual([]);
  });

  test('readSeedTitleSlugs', async () => {
    const old = await sent(e => e.executeRaw(
      `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])
           AND lower(title) = lower($3) AND NOT ${retiredPageSql('pages')} LIMIT 2`, ['default', ['company', 'person'], 'Acme Example']));
    const typed = await sent(e => e.readSeedTitleSlugs('default', ['company', 'person'], 'Acme Example'));
    expect(old).toHaveLength(1);
    expect(typed).toEqual(old);
  });
});
