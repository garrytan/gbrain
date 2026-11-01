import { describe, expect, test } from 'bun:test';
import { assertSchemaReplaySupported, assertSupportedSchemaVersion } from '../src/core/schema-version-guard.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

describe('schema replay admission', () => {
  test('only an absent config table permits a fresh install without a version read', async () => {
    const queries: string[] = [];
    await assertSchemaReplaySupported(async sql => { queries.push(sql); return [{ name: null }]; });
    expect(queries).toHaveLength(1);
  });
  test('a present legacy config table with no version row can initialize', async () => {
    let reads = 0;
    await assertSchemaReplaySupported(async () => ++reads === 1 ? [{ name: 'config' }] : []);
    expect(reads).toBe(2);
    expect(() => assertSupportedSchemaVersion(LATEST_SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSupportedSchemaVersion(1)).not.toThrow();
  });
  test('catalog and version read failures propagate instead of authorizing replay', async () => {
    const error = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(assertSchemaReplaySupported(async () => { throw error; })).rejects.toBe(error);
    let reads = 0;
    await expect(assertSchemaReplaySupported(async () => {
      if (++reads === 1) return [{ name: 'config' }];
      throw error;
    })).rejects.toBe(error);
  });
  test('newer versions have an actionable typed refusal', () => {
    expect(() => assertSupportedSchemaVersion(LATEST_SCHEMA_VERSION + 1)).toThrow(/Upgrade GBrain on this host/);
  });
});
