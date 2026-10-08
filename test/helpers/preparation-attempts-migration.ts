/**
 * Shared body of the v221 `preparation_attempts` migration tests (#6278):
 * PGLite in `test/persistence-preparation-attempts-migration.test.ts`,
 * Postgres in `test/e2e/persistence-preparation-attempts-postgres.test.ts`.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';
import { MIGRATIONS } from '../../src/core/schema-migrations/registry.generated.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';

const COLUMN_SQL = `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
  WHERE table_name='persistence_requests' AND column_name='preparation_attempts'`;

async function insertRequests(engine: BrainEngine, states: Array<{ state: string; compacted?: boolean }>): Promise<string[]> {
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const ids: string[] = [];
    for (const row of states) {
      const [inserted] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests
        (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent,intent_bytes,terminal_reservation,state,execution_token,claim_expires_at,compacted,error_code)
        VALUES ('local_cli','fixture',$1::uuid,'put_page','default',$2::uuid,$3,'digest','{}'::jsonb,'{}'::jsonb,16,16384,$4,
          CASE WHEN $4='running' THEN gen_random_uuid() END,CASE WHEN $4='running' THEN now()+interval '30 seconds' END,$5,
          CASE WHEN $4='failed' THEN 'storage_error' END) RETURNING id`,
      [randomUUID(), randomUUID(), `prep-attempts/${row.state}${row.compacted ? '-compacted' : ''}`, row.state, row.compacted === true]);
      ids.push(inserted!.id);
    }
    return ids;
  });
}

/** A fresh install (initSchema at head) has the column with its default and check. */
export async function assertFreshPreparationAttemptsColumn(engine: BrainEngine): Promise<void> {
  const [column] = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string; column_default: string }>(COLUMN_SQL);
  expect(column).toMatchObject({ column_name: 'preparation_attempts', data_type: 'integer', is_nullable: 'NO', column_default: '0' });
  const ids = await insertRequests(engine, [{ state: 'queued' }, { state: 'running' }, { state: 'failed' }, { state: 'committed', compacted: true }]);
  const rows = await engine.executeRaw<{ state: string; preparation_attempts: number }>('SELECT state,preparation_attempts FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [ids]);
  expect(rows.map(row => [row.state, row.preparation_attempts])).toEqual([['queued', 0], ['running', 0], ['failed', 0], ['committed', 0]]);
  await expect(engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw('UPDATE persistence_requests SET preparation_attempts=-1 WHERE id=$1::uuid', [ids[0]]);
  })).rejects.toThrow(/preparation_attempts|check/i);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw('UPDATE persistence_requests SET preparation_attempts=preparation_attempts+1 WHERE id=$1::uuid', [ids[1]]);
  });
  const [charged] = await engine.executeRaw<{ preparation_attempts: number }>('SELECT preparation_attempts FROM persistence_requests WHERE id=$1::uuid', [ids[1]]);
  expect(charged?.preparation_attempts).toBe(1);
}

/**
 * An upgraded brain: the column is dropped as a brain from before the migration lacks it, rows in
 * every state exist, the version is set back one, and the migration runner
 * adds the column with 0 on every existing row without touching the rows.
 */
export async function assertUpgradedPreparationAttemptsColumn(engine: BrainEngine): Promise<void> {
  const migration = MIGRATIONS.find(m => m.name === 'persistence_request_preparation_attempts')!;
  const ids = await insertRequests(engine, [{ state: 'queued' }, { state: 'running' }, { state: 'failed' }, { state: 'committed', compacted: true }]);
  const before = await engine.executeRaw<Record<string, unknown>>('SELECT id,state,execution_token,compacted,error_code FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [ids]);
  await engine.executeRaw('ALTER TABLE persistence_requests DROP COLUMN preparation_attempts');
  expect(await engine.executeRaw(COLUMN_SQL)).toEqual([]);
  await engine.setConfig('version', String(migration.version - 1));
  const first = await runMigrations(engine);
  expect(first.current).toBe(LATEST_VERSION);
  expect(first.applied).toBeGreaterThanOrEqual(1);
  const [column] = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string; column_default: string }>(COLUMN_SQL);
  expect(column).toMatchObject({ column_name: 'preparation_attempts', data_type: 'integer', is_nullable: 'NO', column_default: '0' });
  const after = await engine.executeRaw<Record<string, unknown>>('SELECT id,state,execution_token,compacted,error_code,preparation_attempts FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [ids]);
  expect(after.map(({ preparation_attempts: _attempts, ...row }) => row)).toEqual(before);
  expect(after.map(row => row.preparation_attempts)).toEqual([0, 0, 0, 0]);
  // Re-running the idempotent migration is a no-op.
  await engine.setConfig('version', String(migration.version - 1));
  const second = await runMigrations(engine);
  expect(second.current).toBe(LATEST_VERSION);
  expect(await engine.executeRaw(COLUMN_SQL)).toHaveLength(1);
}
