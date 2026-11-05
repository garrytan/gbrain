/**
 * GBRA-248 W1: the Postgres half of the two-engine isolation suite
 * (test/helpers/two-engine.ts; the PGLite half is
 * test/two-engine-isolation.serial.test.ts). Two databases on the test server,
 * one engine each, in one process.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { twoEngineIsolationSuite } from '../helpers/two-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('two-engine isolation on Postgres', () => {
  const names = ['a', 'b'].map((n) => 'gbrain_test_two_engine_' + n + '_' + randomUUID().replaceAll('-', '').slice(0, 12));
  const urls = names.map((name) => {
    const url = new URL(DATABASE_URL ?? 'postgresql://localhost/unset');
    url.pathname = '/' + name;
    return url.toString();
  }) as [string, string];
  const processHome = mkdtempSync(join(tmpdir(), 'gbrain-two-engine-process-home-'));
  const savedHome = process.env.GBRAIN_HOME;
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    process.env.GBRAIN_HOME = processHome;
    admin = postgres(DATABASE_URL!, { max: 1 });
    for (const name of names) await admin.unsafe('CREATE DATABASE ' + name);
  }, 60_000);

  afterAll(async () => {
    for (const name of names) await admin.unsafe('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
    await admin.end();
    if (savedHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = savedHome;
    rmSync(processHome, { recursive: true, force: true });
  }, 60_000);

  twoEngineIsolationSuite('postgres', urls);
});
