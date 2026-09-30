import { afterAll, beforeAll, describe } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { sourceIngestionReceiptTests } from '../helpers/company-brain-receipts.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('receipt engine parity', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: url, poolSize: 3 });
    await engine.initSchema();
  }, 120000);
  afterAll(async () => { await engine?.disconnect(); });
  sourceIngestionReceiptTests('source ingestion receipts (Postgres)', () => engine);
});
