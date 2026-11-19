/**
 * The large-page reads (engine-sql/large-page.ts) send Postgres the statements their callers
 * (persistence/large-page-guard.ts, page-embedding-budget.ts) sent through `executeRaw` before they became typed
 * members: the same text and the same bound values.
 *
 * Protects: assertLargePageAdmission keeps its exact Postgres statement for a remote put_page.
 * Fails when the member's text or parameter order drifts from the statement the guard wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The (text, params) of every statement `fn` sends that reads `pages`. */
async function sent(fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' && /FROM pages/.test(s.text) ? [{ text: s.text, params: s.params }] : []));
}

describe('the large-page write guard sends the hand-written Postgres statement', () => {
  test('readStoredBodyBytes', async () => {
    const old = await sent(e => e.executeRaw(
      `SELECT CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(compiled_truth) + COALESCE(octet_length(timeline), 0) END AS bytes
      FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`, ['notes/a', 'default']));
    const typed = await sent(e => e.readStoredBodyBytes('notes/a', 'default'));
    expect(old).toHaveLength(1);
    expect(typed).toEqual(old);
  });

  // page-embedding-budget.ts readPageSizeStates (the sync receipt's size states) built this text by hand; the member
  // adds COLLATE "C" to its ORDER BY, so the rows come in slug byte order, the one order the Rust store gives too.
  // The member builds it as a fragment, which numbers the parameters in text order: with named slugs the slug list
  // is $2 and the inline size $3 (the hand-written text had them the other way round).
  for (const slugs of [null, ['notes/a', 'notes/b']] as const) {
    test(`listPageSizeRows (${slugs ? 'named slugs' : 'whole source'})`, async () => {
      const bytes = `(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`;
      const old = await sent(e => e.executeRaw(
        `SELECT p.slug, ${bytes}::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL${slugs ? ' AND p.slug = ANY($2::text[])' : ''}
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR ${bytes} > ${slugs ? '$3' : '$2'} OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug COLLATE "C"`,
        slugs ? ['default', [...slugs], 1048576] : ['default', 1048576]));
      const typed = await sent(e => e.listPageSizeRows('default', { inlineMaxBytes: 1048576, slugs }));
      expect(old).toHaveLength(1);
      expect(typed).toEqual(old);
    });
  }
});
