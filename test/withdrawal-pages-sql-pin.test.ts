/**
 * The typed withdrawal page statements (src/core/engine-sql/withdrawal-pages.ts) send Postgres the statement text and
 * binds recordFactWithdrawal (src/core/facts/withdrawal.ts) sent through `executeRaw` before they were members. A
 * drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old raw statement byte for byte, with the slugs bound as
 * one text array after the source. Fails when a member reorders a clause, renumbers a placeholder or binds a value
 * differently. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, last };
}

const slugs = ['people/a-example', 'companies/acme-example'];

test('listSegmentedPages sends the old segmented-page statement', async () => {
  const { engine, last } = recordingEngine();
  await engine.listSegmentedPages('src-a', slugs);
  expect(last()).toEqual({
    text: `SELECT id,slug FROM pages
        WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage='segmented'`,
    params: ['src-a', slugs],
  });
});

test('invalidateWithdrawnPages sends the old page-invalidation statement', async () => {
  const { engine, last } = recordingEngine();
  await engine.invalidateWithdrawnPages('src-a', slugs);
  expect(last()).toEqual({
    text: `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
          WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage<>'segmented' RETURNING id,slug,knowledge_revision`,
    params: ['src-a', slugs],
  });
});
