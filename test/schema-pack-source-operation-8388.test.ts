import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-source-'));
});

afterAll(() => {
  _resetPackCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

describe('get_active_schema_pack source binding', () => {
  test('uses the source pack ahead of the brain-wide pack', async () => {
    const engine = {
      getConfig: async (key: string) => ({
        schema_pack: 'gbrain-base-v2',
        'schema_pack.source.notes': 'gbrain-base',
      })[key] ?? null,
    };
    const ctx = {
      engine,
      config: {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'notes',
    } as unknown as OperationContext;

    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.get_active_schema_pack!.handler(ctx, {}) as Record<string, unknown>;
      expect(result.pack_name).toBe('gbrain-base');
      expect(result.source_tier).toBe('per-source-db');
    });
  });
});
