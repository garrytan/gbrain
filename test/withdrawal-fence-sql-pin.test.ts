/**
 * The typed withdrawal check on a malformed facts fence (src/core/engine-sql/withdrawal-fence.ts) sends Postgres the
 * statement text and binds assertPreparedFactWithdrawals (src/core/facts/withdrawal.ts) sent through `executeRaw`
 * before it was a member. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot
 * see.
 *
 * Protects: the member's recorded text and params equal the old raw statement byte for byte, with the claims bound as
 * one JSON text of `{claim, visibility}` objects between the source and the subject, and no statement for no claims.
 * Fails when the member reorders a clause, renumbers a placeholder, drops the v1 fingerprint or the purge ledger, or
 * binds a value differently. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

const OLD_TEXT = `WITH incoming AS MATERIALIZED (SELECT i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v1(i.claim) AS fp_v1
      FROM jsonb_to_recordset($2::text::jsonb) i(claim text,visibility text))
    SELECT 1 FROM incoming
    JOIN (SELECT source_id,visibility,subject,fact_hash FROM fact_withdrawals WHERE source_id=$1
      UNION ALL SELECT source_id,visibility,subject,fact_hash FROM fact_purges WHERE source_id=$1) w
      ON w.source_id=$1 AND w.fact_hash IN (incoming.fp,incoming.fp_v1)
      AND (incoming.visibility IS NULL OR w.visibility=incoming.visibility)
      AND ($3::text IS NULL OR w.subject = '*' OR w.subject = $3::text) LIMIT 1`;

test('hasWithdrawnFenceClaim sends the old malformed-fence withdrawal statement', async () => {
  const { engine, statements } = recordingEngine();
  const claims = [{ claim: 'Prefers email', visibility: 'world' }, { claim: 'Has a budget', visibility: null }];
  await engine.hasWithdrawnFenceClaim('src-a', claims, 'people/a-example');
  await engine.hasWithdrawnFenceClaim('src-a', claims, null);
  expect(statements()).toEqual([
    { text: OLD_TEXT, params: ['src-a', '[{"claim":"Prefers email","visibility":"world"},{"claim":"Has a budget","visibility":null}]', 'people/a-example'] },
    { text: OLD_TEXT, params: ['src-a', '[{"claim":"Prefers email","visibility":"world"},{"claim":"Has a budget","visibility":null}]', null] },
  ]);
});

test('hasWithdrawnFenceClaim sends nothing for no claims', async () => {
  const { engine, statements } = recordingEngine();
  expect(await engine.hasWithdrawnFenceClaim('src-a', [], 'people/a-example')).toBe(false);
  expect(statements()).toEqual([]);
});
