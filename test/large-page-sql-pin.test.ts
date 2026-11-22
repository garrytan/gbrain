/**
 * The large-page write guard's read (engine-sql/large-page.ts) sends Postgres the statement
 * persistence/large-page-guard.ts sent through `executeRaw` before it became a typed member: the same text and the
 * same bound values.
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
});
