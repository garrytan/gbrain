import { expect, test } from 'bun:test';
import { createProgress } from '../../src/core/progress.ts';
import { indexAuditEntry } from '../../src/commands/doctor/checks/queue-assets.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { startDoctorDeadline } from '../../src/commands/doctor/budget.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

test('zero-scan roles retain every warning and count past the display limit', async () => {
  const fixture = await isolatedPersistencePostgres(requirePostgresTestDatabase(), 'module');
  const sql = (text: string) => fixture.engine.executeRaw(text, []);
  const check = async () => {
    const args = ['--index-audit'];
    const ctx: DoctorContext = {
      engine: fixture.engine, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false,
      scope: 'all', orphanRatioSourceId: undefined, progress: createProgress({}),
      skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null,
      schemaVersion: 0, connectionFailed: false, only: null, tier: 'deep', deadline: startDoctorDeadline(args),
    };
    const result = await indexAuditEntry.run(ctx);
    if (!Array.isArray(result) || result.length !== 1) throw new Error('Expected one index audit');
    return result[0]!;
  };
  try {
    // Only our fixture's indexes should appear in the public schema of its private database.
    await sql('ALTER SCHEMA public RENAME TO installed');
    await sql('CREATE SCHEMA public');
    expect((await check()).status).toBe('ok');
    await sql('CREATE TABLE sample(id integer PRIMARY KEY, label text UNIQUE)');
    await sql("INSERT INTO sample VALUES(1, 'first')");
    await expect(sql("INSERT INTO sample VALUES(1, 'second')")).rejects.toThrow();
    await expect(sql("INSERT INTO sample VALUES(2, 'first')")).rejects.toThrow();
    const keys = await check();
    expect(keys.status).toBe('warn');
    expect(keys.details).toEqual({ exact: true, zero_scan_total: 2, supporting_primary_or_unique: 2, other_zero_scan: 0 });
    await sql('CREATE TABLE target(k integer)');
    await sql('CREATE UNIQUE INDEX standalone_target ON target(k)');
    await sql('CREATE TABLE edge(k integer REFERENCES target(k))');
    for (let n = 0; n < 25; n++) await sql(`CREATE INDEX edge_${n} ON edge(k) WHERE k=${n}`);
    const mixed = await check();
    expect(mixed.status).toBe('warn');
    expect(mixed.details).toEqual({ exact: false, zero_scan_total: 28, supporting_primary_or_unique: 2, other_zero_scan: 26 });
  } finally {
    await fixture.close();
  }
}, 90_000);
