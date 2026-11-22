import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { v332 } from '../src/core/schema-migrations/v332-retire-shared-skill-revision-request-index.ts';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE shared_skill_revisions (
      revision uuid PRIMARY KEY,
      request_id uuid NOT NULL,
      name text NOT NULL
    );
    INSERT INTO shared_skill_revisions VALUES
      ('b0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000001', 'alpha'),
      ('b0000000-0000-4000-a000-000000000002', 'a0000000-0000-4000-a000-000000000001', 'beta');
  `);
});

afterEach(async () => { await db.close(); });

async function requestIndexExists(): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(`
    SELECT to_regclass('public.shared_skill_revision_request_idx') IS NOT NULL AS present
  `);
  return rows[0]!.present;
}

test('retires the stock lookup while preserving revision and request history', async () => {
  const before = await db.query('SELECT * FROM shared_skill_revisions ORDER BY revision');
  await db.exec('CREATE INDEX shared_skill_revision_request_idx ON shared_skill_revisions (request_id)');
  await db.exec(v332.sql);
  await db.exec(v332.sql);
  expect(await requestIndexExists()).toBe(false);
  expect((await db.query('SELECT * FROM shared_skill_revisions ORDER BY revision')).rows).toEqual(before.rows);
  await expect(db.exec(`INSERT INTO shared_skill_revisions VALUES
    ('b0000000-0000-4000-a000-000000000002', 'a0000000-0000-4000-a000-000000000002', 'gamma')`
  )).rejects.toThrow('shared_skill_revisions_pkey');
});

test('retains a customized request lookup using the same name', async () => {
  await db.exec('CREATE INDEX shared_skill_revision_request_idx ON shared_skill_revisions (request_id, name)');
  await db.exec(v332.sql);
  expect(await requestIndexExists()).toBe(true);
});

test('retains a manually documented index for an operational workload', async () => {
  await db.exec(`
    CREATE INDEX shared_skill_revision_request_idx ON shared_skill_revisions (request_id);
    COMMENT ON INDEX shared_skill_revision_request_idx IS 'Support retains this index for receipt investigations';
  `);
  await db.exec(v332.sql);
  expect(await requestIndexExists()).toBe(true);
});
