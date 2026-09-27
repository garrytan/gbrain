import { expect, test } from 'bun:test';
import { registerPostgresTests, requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = 'postgresql://localhost/gbrain_test';

test('direct invocation keeps local-only and opt-in dual-engine execution', () => {
  expect(testBackends({})).toEqual(['pglite']);
  expect(testBackends({ DATABASE_URL: databaseUrl })).toEqual(['pglite', 'postgres']);
});

test('explicit PostgreSQL selection cannot silently fall back, skip, or use an unsafe database', () => {
  expect(testBackends({ GBRAIN_TEST_BACKEND: 'postgres', DATABASE_URL: databaseUrl })).toEqual(['postgres']);
  expect(() => testBackends({ GBRAIN_TEST_BACKEND: 'postgres' })).toThrow('requires DATABASE_URL');
  expect(() => testBackends({ GBRAIN_TEST_BACKEND: 'postgres', DATABASE_URL: 'postgresql://localhost/operator' })).toThrow('does not look like a test database');
  expect(() => testBackends({ GBRAIN_TEST_BACKEND: 'unknown' })).toThrow('Unknown GBRAIN_TEST_BACKEND');
  expect(() => requirePostgresTestDatabase({})).toThrow('refusing to skip');
});

test('E2E registration captures PostgreSQL only and restores the caller after all loaders', async () => {
  await withEnv({ DATABASE_URL: databaseUrl, GBRAIN_TEST_BACKEND: undefined }, async () => {
    const captured: string[][] = [];
    await registerPostgresTests(async () => { captured.push(testBackends()); }, async () => { captured.push(testBackends()); });
    expect(captured).toEqual([['postgres'], ['postgres']]);
    expect(testBackends()).toEqual(['pglite', 'postgres']);
  });
});

test('failed and unavailable E2E registration cannot leak a backend override or import a fallback', async () => {
  await withEnv({ DATABASE_URL: databaseUrl, GBRAIN_TEST_BACKEND: undefined }, async () => {
    await expect(registerPostgresTests(async () => { throw new Error('loader fixture failure'); })).rejects.toThrow('loader fixture failure');
    expect(process.env.GBRAIN_TEST_BACKEND).toBeUndefined();
  });
  await withEnv({ DATABASE_URL: undefined, GBRAIN_TEST_BACKEND: undefined }, async () => {
    let imported = false;
    await expect(registerPostgresTests(async () => { imported = true; })).rejects.toThrow('requires DATABASE_URL');
    expect(imported).toBe(false);
  });
});
