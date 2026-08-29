/**
 * #3792 — doctor's schema_pack_active check (and the get_active_schema_pack
 * op) must resolve the active pack with the FULL 7-tier input, including the
 * DB-plane `schema_pack` config (tier 4). Pre-fix they resolved from
 * file/env only, so a brain whose active pack was flipped via
 * `gbrain config set schema_pack` (or the unify-types migration) had doctor
 * reporting one pack while every query ran another.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchemaPackActive } from '../src/commands/doctor/schema-pack-checks.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let tmpHome: string;

beforeEach(() => {
  _resetPackCacheForTests();
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-3792-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

function engineWithDbPack(pack: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => (key === 'schema_pack' ? pack : null),
  } as unknown as BrainEngine;
}

describe('#3792 doctor schema_pack_active resolves with DB-plane config', () => {
  test('db-plane schema_pack (tier 4) wins over the default when home config is silent', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const check = await checkSchemaPackActive(engineWithDbPack('gbrain-base-v2'));
      expect(check.status).toBe('ok');
      // Pre-fix: dbConfig was never threaded → resolved 'gbrain-base'.
      expect(check.message).toContain('gbrain-base-v2');
    });
  });

  test('no db-plane value → default resolution stands (gbrain-base)', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const check = await checkSchemaPackActive(engineWithDbPack(null));
      expect(check.status).toBe('ok');
      expect(check.message).toContain('gbrain-base v');
    });
  });

  test('engine without a config table degrades to file/env resolution (no throw)', async () => {
    const engine = {
      getConfig: async () => { throw new Error('relation "config" does not exist'); },
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const check = await checkSchemaPackActive(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('gbrain-base v');
    });
  });
});

describe('#3792 get_active_schema_pack op threads the same DB-plane config', () => {
  test('identity packet reports the db-plane pack', async () => {
    const { handleToolCall } = await import('../src/mcp/server.ts');
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = (await handleToolCall(
        engineWithDbPack('gbrain-base-v2'),
        'get_active_schema_pack',
        {},
      )) as { pack_name: string; source_tier: string };
      expect(result.pack_name).toBe('gbrain-base-v2');
    });
  });
});
