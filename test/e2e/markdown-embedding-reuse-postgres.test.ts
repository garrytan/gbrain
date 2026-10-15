import { test } from 'bun:test';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const url = process.env.DATABASE_URL;
if (url) {
  assertSafeE2eDatabaseUrl(url);
  await withEnv({ PMBRAIN_IMPORT_REUSE_TEST_DATABASE_URL: url }, () => import('../markdown-embedding-reuse.serial.test.ts'));
} else {
  test.skip('Postgres markdown embedding reuse requires an isolated DATABASE_URL', () => {});
}
