/**
 * GBRA-283 B3a (N1): openEngine refuses a settings key it does not know, at the top level or inside a known setting,
 * with engine_settings_invalid naming the key, so a misspelled setting is never silently ignored. `storage` is known
 * (Wave C checks its fields).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, type EngineSettings } from '../src/core/engine-open.ts';

const base = (): Record<string, unknown> => ({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() } });
const refusal = async (settings: Record<string, unknown>) => {
  try { await (await openEngine(settings as unknown as EngineSettings)).disconnect(); return null; } catch (error) { return error as Error & { code?: string; suggestion?: string }; }
};

describe('unknown settings keys', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['a misspelled top-level setting', { embeding: { model: 'openai:text-embedding-3-small', dimensions: 1536 } }, 'embeding'],
    ['a top-level setting from another product', { region: 'us-west-2' }, 'region'],
    ['database', { database: { path: undefined, pathh: '/tmp/x' } }, 'database.pathh'],
    ['pool', { pool: { max: 2, min: 1 } }, 'pool.min'],
    ['host', { host: { id: randomUUID(), name: 'brain-a' } }, 'host.name'],
    ['writer', { writer: { id: randomUUID(), credential: 'c'.repeat(64), lane: 'cli', scope: 'all' } }, 'writer.scope'],
    ['embedding', { embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536, dims: 1536 } }, 'embedding.dims'],
    ['pglite', { pglite: { sharedBuffers: '64MB' } }, 'pglite.sharedBuffers'],
    ['ai', { ai: { providers: {}, model: { chat: 'openai:gpt-5.6' } } }, 'ai.model'],
  ];
  for (const [label, extra, named] of cases) {
    test(`${label}: refuses engine_settings_invalid naming ${named}`, async () => {
      const error = await refusal({ ...base(), ...extra });
      expect(error?.code).toBe('engine_settings_invalid');
      expect(error?.message).toContain(`The ${named} setting is invalid.`);
    });
  }

  test('the value of an unknown key is never echoed', async () => {
    const secret = `sk-secret-${randomUUID()}`;
    const error = await refusal({ ...base(), openai_api_key: secret });
    expect(error?.code).toBe('engine_settings_invalid');
    expect(`${error?.message} ${error?.suggestion}`).not.toContain(secret);
  });

  test('every known key opens, storage included (Wave C checks its fields)', async () => {
    const store = mkdtempSync(join(tmpdir(), 'gbrain-settings-keys-'));
    try {
      const settings = { ...base(), pool: { max: 2 }, embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536 }, keyword_statement_timeout_ms: 1000, pglite: {}, storage: { backend: 'local', localPath: store } };
      expect(await refusal(settings)).toBeNull();
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }, 60_000);
});
