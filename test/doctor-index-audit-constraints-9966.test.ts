/**
 * #9966: doctor --index-audit leaves out indexes that back PRIMARY KEY and UNIQUE constraints.
 *
 * 1. Protects: an index that enforces a primary key or a unique constraint does its job on every write, which
 *    pg_stat_user_indexes never counts as a scan, so listing it as "zero-scan" invites an operator to drop a
 *    constraint. The audit lists only plain indexes with no recorded reads.
 * 2. Fails when: a constraint-backing index appears in the zero-scan list, or a plain zero-scan index stops appearing.
 * 3. Real seams: the registered index_audit doctor entry on an isolated Postgres database (DATABASE_URL); PGLite
 *    has no pg_stat_user_indexes, so the PGLite arm only checks the skip message.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { indexAuditEntry } from '../src/commands/doctor/checks/queue-assets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { testBackends } from './helpers/test-backends.ts';
import { encodedPostgres, isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const progress = new Proxy({}, { get: () => () => undefined });
const audit = async (engine: BrainEngine) =>
  await indexAuditEntry.run({ engine, args: ['--index-audit'], progress } as unknown as DoctorContext) as Check[];

for (const kind of testBackends()) describe(`index_audit and constraint indexes (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('a primary key and a unique constraint are not listed as zero-scan; a plain unread index is', async () => {
    if (kind === 'pglite') {
      const [check] = await audit(engine);
      expect(check).toMatchObject({ name: 'index_audit', status: 'ok' });
      return;
    }
    await engine.executeRaw(`CREATE TABLE constraint_fixture (k integer PRIMARY KEY, label text UNIQUE, note text)`);
    await engine.executeRaw(`INSERT INTO constraint_fixture SELECT n, 'sample-' || n, repeat('n', 40) || n FROM generate_series(1, 32000) AS n`);
    await engine.executeRaw(`CREATE INDEX constraint_fixture_note_idx ON constraint_fixture (note)`);
    await engine.executeRaw(`ANALYZE constraint_fixture`);
    const [check] = await audit(engine);
    expect(check!.name).toBe('index_audit');
    expect(check!.status).toBe('ok');
    expect(check!.details?.zero_scan_count).toBeGreaterThan(0);
    expect(check!.details?.unusable_count).toBe(0);
    expect(check!.message).toContain('constraint_fixture_note_idx');
    expect(check!.message).not.toContain('constraint_fixture_pkey');
    expect(check!.message).not.toContain('constraint_fixture_label_key');
  }, 60_000);

  // #10413: a failed concurrent unique build keeps indisunique. The usage exemption and
  // twenty-name display cap must both leave the actual health warning visible.
  test.skipIf(kind !== 'postgres')('a failed concurrent unique build warns alongside healthy zero-scan indexes', async () => {
    const bare = await encodedPostgres(process.env.DATABASE_URL!, 'UTF8');
    try {
      await bare.engine.executeRaw(`CREATE TABLE usage_fixture (k integer)`);
      await bare.engine.executeRaw(`INSERT INTO usage_fixture SELECT n FROM generate_series(1, 2000) AS n`);
      for (let n = 1; n <= 24; n++) {
        await bare.engine.executeRaw(`CREATE INDEX usage_fixture_idx_${n} ON usage_fixture (k)`);
      }
      await bare.engine.executeRaw(`CREATE TABLE dup_fixture (k integer)`);
      await bare.engine.executeRaw(`INSERT INTO dup_fixture VALUES (7), (7)`);
      const failed = await bare.engine.executeRaw(`CREATE UNIQUE INDEX CONCURRENTLY dup_fixture_k_idx ON dup_fixture (k)`).then(() => 'built', (e: { code?: string }) => e.code);
      expect(failed).toBe('23505');
      const [index] = await bare.engine.executeRaw<{ indisunique: boolean; indisvalid: boolean; indisready: boolean }>(
        `SELECT indisunique, indisvalid, indisready FROM pg_index WHERE indexrelid = 'dup_fixture_k_idx'::regclass`);
      expect(index).toEqual({ indisunique: true, indisvalid: false, indisready: false });
      const [check] = await audit(bare.engine);
      expect(check).toMatchObject({
        name: 'index_audit',
        status: 'warn',
        details: { exact: false, zero_scan_count: 24, unusable_count: 1 },
      });
      expect(check!.message).toContain('dup_fixture_k_idx');
      expect(check!.message).toContain('usage_fixture_idx_');

      await bare.engine.executeRaw(`DROP INDEX dup_fixture_k_idx`);
      const [recovered] = await audit(bare.engine);
      expect(recovered).toMatchObject({
        name: 'index_audit',
        status: 'ok',
        details: { exact: false, zero_scan_count: 24, unusable_count: 0 },
      });
      expect(recovered!.message).toContain('usage_fixture_idx_');
    } finally {
      await bare.close();
    }
  }, 60_000);

  test.skipIf(kind !== 'postgres')('an invalid partitioned parent index warns without a statistics row', async () => {
    const bare = await encodedPostgres(process.env.DATABASE_URL!, 'UTF8');
    try {
      await bare.engine.executeRaw(`CREATE TABLE parent_fixture (k integer) PARTITION BY RANGE (k)`);
      await bare.engine.executeRaw(`CREATE TABLE child_fixture PARTITION OF parent_fixture FOR VALUES FROM (0) TO (10)`);
      await bare.engine.executeRaw(`CREATE INDEX parent_fixture_idx ON ONLY parent_fixture (k)`);
      const [check] = await audit(bare.engine);
      expect(check).toMatchObject({ status: 'warn', details: { zero_scan_count: 0, unusable_count: 1 } });
      expect(check!.message).toContain('parent_fixture_idx');

      await bare.engine.executeRaw(`CREATE INDEX child_fixture_idx ON child_fixture (k)`);
      await bare.engine.executeRaw(`ALTER INDEX parent_fixture_idx ATTACH PARTITION child_fixture_idx`);
      const [recovered] = await audit(bare.engine);
      expect(recovered).toMatchObject({ status: 'ok', details: { zero_scan_count: 1, unusable_count: 0 } });
      expect(recovered!.message).not.toContain('parent_fixture_idx');
    } finally {
      await bare.close();
    }
  }, 60_000);
});
