/**
 * database_encoding doctor check: a Postgres brain whose server_encoding is not UTF8 warns (never fails), a UTF8 one is
 * ok, and PGLite (always UTF8) is skipped. The Postgres arm runs with DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { databaseEncodingEntry } from '../src/commands/doctor/checks/database-encoding.ts';
import { encodedPostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const run = async (engine: BrainEngine) => await databaseEncodingEntry.run({ engine, progress: { heartbeat() {} } } as never);

describe('database_encoding doctor check', () => {
  describe.skipIf(!backends.includes('pglite'))('PGLite', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); }, 60_000);
    afterAll(async () => { await engine?.disconnect(); });

    test('is skipped as always UTF8', async () => {
      expect(await run(engine)).toEqual([{ name: 'database_encoding', status: 'ok', message: 'Skipped (PGLite is always UTF8)' }]);
    });
  });

  describe.skipIf(!backends.includes('postgres'))('Postgres', () => {
    const dbs: Record<string, Awaited<ReturnType<typeof encodedPostgres>>> = {};
    beforeAll(async () => {
      dbs.utf8 = await encodedPostgres(process.env.DATABASE_URL!, 'UTF8');
      dbs.ascii = await encodedPostgres(process.env.DATABASE_URL!, 'SQL_ASCII');
    }, 60_000);
    afterAll(async () => { for (const db of Object.values(dbs)) await db.close(); });

    test('a UTF8 database is ok', async () => {
      expect(await run(dbs.utf8!.engine)).toEqual([{ name: 'database_encoding', status: 'ok', message: 'The database encoding is UTF8' }]);
    });

    test('a SQL_ASCII database warns and names what it weakens', async () => {
      const [check, ...rest] = await run(dbs.ascii!.engine) as Array<{ name: string; status: string; message: string; details?: unknown }>;
      expect(rest).toEqual([]);
      expect(check).toMatchObject({ name: 'database_encoding', status: 'warn', details: { server_encoding: 'SQL_ASCII' } });
      expect(check!.message).toContain('The database encoding is SQL_ASCII, not UTF8');
      expect(check!.message).toContain('whitespace trimming in the privacy and trust checks covers ASCII only');
      expect(check!.message).toContain('non-ASCII characters is not handled reliably');
    });
  });
});
