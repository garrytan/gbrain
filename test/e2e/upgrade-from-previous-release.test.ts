/**
 * GBRA-248 W1, gate condition 1: the Postgres half of the upgrade-from-
 * previous-release harness (test/helpers/upgrade-from-previous-release.ts).
 * One fresh database per brain shape, loaded from the newest Postgres
 * schema-history fixture.
 */
import { afterAll, describe } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { upgradeFromPreviousReleaseSuite } from '../helpers/upgrade-from-previous-release.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('upgrade from the previous release on Postgres', () => {
  const created: string[] = [];
  const admin = () => postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

  afterAll(async () => {
    const sql = admin();
    try {
      for (const name of created) await sql.unsafe('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  upgradeFromPreviousReleaseSuite('postgres', {
    async databaseUrl() {
      assertSafeE2eDatabaseUrl(DATABASE_URL!);
      const name = 'gbrain_test_upgrade_' + randomUUID().replaceAll('-', '').slice(0, 16);
      const sql = admin();
      try {
        await sql.unsafe('CREATE DATABASE ' + name);
      } finally {
        await sql.end({ timeout: 5 });
      }
      created.push(name);
      const url = new URL(DATABASE_URL!);
      url.pathname = '/' + name;
      return url.toString();
    },
    async loadSql(url, text) {
      const loader = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        await loader.unsafe(text);
      } finally {
        await loader.end({ timeout: 5 });
      }
    },
  });
});
