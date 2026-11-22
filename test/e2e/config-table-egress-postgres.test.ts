/**
 * Postgres getAllConfig() re-sends the config table only when it changed.
 * Fails when: a second read of an unchanged table receives its rows again, a
 * write from this engine or from another connection is not seen by the next
 * read, or the cached read returns different values from a fresh one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const d = hasDatabase() ? describe : describe.skip;

/** Records how many rows each statement this engine runs gets back from the database. */
function countRows(engine: PostgresEngine): { rows: number[]; stop: () => void } {
  const real = engine.sql;
  const rows: number[] = [];
  const counted = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    (real as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values)
      .then(result => { rows.push(result.length); return result; })) as unknown as typeof real;
  Object.defineProperty(engine, 'sql', { get: () => counted, configurable: true });
  return { rows, stop: () => { delete (engine as unknown as Record<string, unknown>).sql; } };
}

d('getAllConfig egress (Postgres)', () => {
  let engine: PostgresEngine;
  let other: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    ({ engine, close } = db);
    other = new PostgresEngine();
    await other.connect({ database_url: db.databaseUrl, poolSize: 1 });
  }, 120_000);
  afterAll(async () => { await other.disconnect(); await close(); });

  test('an unchanged table is not sent again; writes from either connection are seen next read', async () => {
    await engine.setConfig('egress.probe', 'one');
    const fresh = await other.getAllConfig();
    const tableSize = Object.keys(fresh).length;
    expect(tableSize).toBeGreaterThan(1);

    const counter = countRows(engine);
    try {
      expect(await engine.getAllConfig()).toEqual(fresh);
      expect(await engine.getAllConfig()).toEqual(fresh);
      // The second read of an unchanged table gets at most the one hash row back.
      expect(counter.rows[1]).toBeLessThanOrEqual(1);

      await other.setConfig('egress.probe', 'two');
      expect((await engine.getAllConfig())['egress.probe']).toBe('two');

      await engine.setConfig('egress.probe', 'three');
      expect((await engine.getAllConfig())['egress.probe']).toBe('three');
      expect(await engine.getAllConfig()).toEqual(await other.getAllConfig());
    } finally {
      counter.stop();
    }
  }, 60_000);
});
