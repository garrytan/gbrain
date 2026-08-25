/**
 * `schema_version` must not report `ok` when the DB is AHEAD of this
 * client's LATEST_VERSION (forward skew). On a multi-node brain (hub +
 * spokes sharing one Postgres), a spoke whose checkout is older than the
 * hub sees `schema_version: ok — Version 111 (latest: 80)` — the old
 * client silently reads/writes tables, columns, and indexes it doesn't
 * know about. Forward skew is more dangerous than backward skew (pending
 * migrations at least block on the next `apply-migrations`), so it must
 * not report a friendlier status than the pending-migrations case.
 *
 * Reported on #2036: a 31-version skew hid for weeks on a real mesh, found
 * only by reading the "Version N (latest: M)" message by eye.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildChecks } from '../src/commands/doctor.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('schema_version — forward skew (#2036)', () => {
  test('warns, not oks, when the DB version is ahead of this client\'s latest known version', async () => {
    await engine.setConfig('version', String(LATEST_VERSION + 31));

    const checks = await buildChecks(engine, [], undefined);
    const schemaCheck = checks.find((c) => c.name === 'schema_version');

    expect(schemaCheck).toBeDefined();
    expect(schemaCheck?.status).toBe('warn');
    expect(schemaCheck?.message).toContain('AHEAD');
    expect(schemaCheck?.message).toContain(String(LATEST_VERSION + 31));
    expect(schemaCheck?.message).toContain(String(LATEST_VERSION));
  });

  test('still oks when the DB version exactly matches latest', async () => {
    await engine.setConfig('version', String(LATEST_VERSION));

    const checks = await buildChecks(engine, [], undefined);
    const schemaCheck = checks.find((c) => c.name === 'schema_version');

    expect(schemaCheck?.status).toBe('ok');
    expect(schemaCheck?.message).toBe(`Version ${LATEST_VERSION} (latest: ${LATEST_VERSION})`);
  });

  test('still warns (unchanged) when the DB version is behind latest (pending migrations)', async () => {
    await engine.setConfig('version', String(LATEST_VERSION - 1));

    const checks = await buildChecks(engine, [], undefined);
    const schemaCheck = checks.find((c) => c.name === 'schema_version');

    expect(schemaCheck?.status).toBe('warn');
    expect(schemaCheck?.message).toContain('apply-migrations');
  });
});
