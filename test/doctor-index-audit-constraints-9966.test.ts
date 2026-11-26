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

for (const kind of testBackends()) describe(`index_audit and constraint indexes (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  const audit = async () => await indexAuditEntry.run({ engine, args: ['--index-audit'], progress } as unknown as DoctorContext) as Check[];

  test('a primary key and a unique constraint are not listed as zero-scan; a plain unread index is', async () => {
    if (kind === 'pglite') {
      const [check] = await audit();
      expect(check).toMatchObject({ name: 'index_audit', status: 'ok' });
      return;
    }
    await engine.executeRaw(`CREATE TABLE constraint_fixture (k integer PRIMARY KEY, label text UNIQUE, note text)`);
    await engine.executeRaw(`INSERT INTO constraint_fixture SELECT n, 'sample-' || n, repeat('n', 40) || n FROM generate_series(1, 32000) AS n`);
    await engine.executeRaw(`CREATE INDEX constraint_fixture_note_idx ON constraint_fixture (note)`);
    await engine.executeRaw(`ANALYZE constraint_fixture`);
    const [check] = await audit();
    expect(check!.name).toBe('index_audit');
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('constraint_fixture_note_idx');
    expect(check!.message).not.toContain('constraint_fixture_pkey');
    expect(check!.message).not.toContain('constraint_fixture_label_key');
  }, 60_000);

  // #10413: a CREATE UNIQUE INDEX CONCURRENTLY that failed leaves an invalid index that enforces nothing and still costs
  // every write; it keeps indisunique, so the #9966 exemption must not hide it. An empty database keeps it in the list.
  test.skipIf(kind !== 'postgres')('a failed concurrent unique index build is still listed', async () => {
    const bare = await encodedPostgres(process.env.DATABASE_URL!, 'UTF8');
    try {
      await bare.engine.executeRaw(`CREATE TABLE dup_fixture (k integer)`);
      await bare.engine.executeRaw(`INSERT INTO dup_fixture VALUES (7), (7)`);
      const failed = await bare.engine.executeRaw(`CREATE UNIQUE INDEX CONCURRENTLY dup_fixture_k_idx ON dup_fixture (k)`).then(() => 'built', (e: { code?: string }) => e.code);
      expect(failed).toBe('23505');
      const [index] = await bare.engine.executeRaw<{ indisunique: boolean; indisvalid: boolean; indisready: boolean }>(
        `SELECT indisunique, indisvalid, indisready FROM pg_index WHERE indexrelid = 'dup_fixture_k_idx'::regclass`);
      expect(index).toEqual({ indisunique: true, indisvalid: false, indisready: false });
      const [check] = await indexAuditEntry.run({ engine: bare.engine, args: ['--index-audit'], progress } as unknown as DoctorContext) as Check[];
      expect(check).toMatchObject({ name: 'index_audit', status: 'warn' });
      expect(check!.message).toContain('dup_fixture_k_idx');
    } finally {
      await bare.close();
    }
  }, 60_000);
});
