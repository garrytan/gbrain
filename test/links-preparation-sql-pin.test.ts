/**
 * The link-preparation reads (engine-sql/links-preparation.ts) send Postgres the statements persistence/links-preparation.ts
 * sent through `executeRaw` before they became typed members: the same text and the same bound values.
 *
 * Protects: link preparation keeps its exact Postgres statements for the alias read, the incremental slug probe and the
 * full slug list (the fingerprint expression is shared by the last two).
 * Fails when a member's text or parameter order drifts from the statement the call site wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The (text, params) of every query statement `fn` sends. */
async function sent(fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => [{ n: 0, h: '0', m: 0, added: [], added_h: '0', slugs: [] }]);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' ? [{ text: s.text, params: s.params }] : []));
}

async function same(old: (e: PostgresEngine) => Promise<unknown>, typed: (e: PostgresEngine) => Promise<unknown>) {
  const before = await sent(old);
  expect(before).toHaveLength(1);
  expect(await sent(typed)).toEqual(before);
}

const SLUG_FINGERPRINT = 'count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m';

describe('link preparation sends the hand-written Postgres statements', () => {
  test('readLiveSlugAliases (liveSlugAliases)', () => same(
    e => e.executeRaw(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, ['default', ['a', 'b']]),
    e => e.readLiveSlugAliases('default', ['a', 'b', 'a'])));

  test('probeSourceSlugFingerprint (refreshSourceSlugIndex, incremental)', () => same(
    e => e.executeRaw(`SELECT ${SLUG_FINGERPRINT},
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added, coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`, ['default', 5]),
    e => e.probeSourceSlugFingerprint('default', 5)));

  test('readSourceSlugFingerprint (refreshSourceSlugIndex, full)', () => same(
    e => e.executeRaw(`SELECT ${SLUG_FINGERPRINT}, coalesce(array_agg(slug), '{}') AS slugs FROM pages WHERE source_id=$1`, ['default']),
    e => e.readSourceSlugFingerprint('default')));
});
