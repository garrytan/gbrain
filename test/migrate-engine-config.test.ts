/**
 * Tests for buildMigratedConfig() in src/commands/migrate-engine.ts.
 *
 * Regression guard for the bug where `gbrain migrate --to ...` overwrote
 * the file-plane config with `{ engine, database_url }` only, silently
 * dropping every other GBrainConfig field — embedding_model,
 * embedding_dimensions, expansion_model, chat_model, API keys, etc.
 *
 * Pure unit tests: no engine connection, no filesystem, no DATABASE_URL.
 */

import { describe, test, expect } from 'bun:test';
import { buildMigratedConfig } from '../src/commands/migrate-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { EngineConfig } from '../src/core/types.ts';

const PG_TARGET: EngineConfig = { engine: 'postgres', database_url: 'postgresql://host/db' };
const PGLITE_TARGET: EngineConfig = { engine: 'pglite', database_path: '/tmp/new.pglite' };

describe('buildMigratedConfig', () => {
  test('pglite -> postgres preserves embedding_model and embedding_dimensions', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.engine).toBe('postgres');
    expect(result.database_url).toBe('postgresql://host/db');
    expect(result.embedding_model).toBe('voyage:voyage-3-large');
    expect(result.embedding_dimensions).toBe(1024);
  });

  test('postgres -> pglite preserves embedding_model and embedding_dimensions', () => {
    const source: GBrainConfig = {
      engine: 'postgres',
      database_url: 'postgresql://host/db',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 3072,
    };

    const result = buildMigratedConfig(source, 'pglite', PGLITE_TARGET);

    expect(result.engine).toBe('pglite');
    expect(result.database_path).toBe('/tmp/new.pglite');
    expect(result.embedding_model).toBe('openai:text-embedding-3-large');
    expect(result.embedding_dimensions).toBe(3072);
  });

  test('strips the old engine connection field (no dangling database_path on postgres)', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/old.pglite',
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.database_path).toBeUndefined();
    expect(result.database_url).toBe('postgresql://host/db');
  });

  test('strips the old engine connection field (no dangling database_url on pglite)', () => {
    const source: GBrainConfig = {
      engine: 'postgres',
      database_url: 'postgresql://host/db',
    };

    const result = buildMigratedConfig(source, 'pglite', PGLITE_TARGET);

    expect(result.database_url).toBeUndefined();
    expect(result.database_path).toBe('/tmp/new.pglite');
  });

  test('strips both connection fields when source has both set (engine-mismatched state)', () => {
    // A previous failed migration could leave a config with both fields set.
    // The migrated config must contain only the target engine's field.
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/old.pglite',
      database_url: 'postgresql://stale/db',
      embedding_model: 'voyage:voyage-3-large',
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.database_path).toBeUndefined();
    expect(result.database_url).toBe('postgresql://host/db');
    expect(result.embedding_model).toBe('voyage:voyage-3-large');
  });

  test('preserves expansion_model, chat_model, and API key fields', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
      expansion_model: 'anthropic:claude-haiku-4-5',
      chat_model: 'anthropic:claude-sonnet-4-6',
      openai_api_key: 'sk-test-key',
      anthropic_api_key: 'ant-test-key',
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.expansion_model).toBe('anthropic:claude-haiku-4-5');
    expect(result.chat_model).toBe('anthropic:claude-sonnet-4-6');
    expect(result.openai_api_key).toBe('sk-test-key');
    expect(result.anthropic_api_key).toBe('ant-test-key');
  });

  test('preserves nested fields (storage, eval, remote_mcp, provider_base_urls)', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      storage: { db_tracked: ['people/'], db_only: ['media/'] },
      eval: { capture: true, scrub_pii: false },
      provider_base_urls: { voyage: 'https://api.voyageai.com/v1' },
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.storage).toEqual({ db_tracked: ['people/'], db_only: ['media/'] });
    expect(result.eval).toEqual({ capture: true, scrub_pii: false });
    expect(result.provider_base_urls).toEqual({ voyage: 'https://api.voyageai.com/v1' });
  });

  test('minimal config (only engine + path) migrates cleanly', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
    };

    const result = buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(result.engine).toBe('postgres');
    expect(result.database_url).toBe('postgresql://host/db');
    expect(result.embedding_model).toBeUndefined();
    expect(result.embedding_dimensions).toBeUndefined();
  });

  test('does not mutate the source config', () => {
    const source: GBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
    };
    const snapshot = JSON.parse(JSON.stringify(source));

    buildMigratedConfig(source, 'postgres', PG_TARGET);

    expect(source).toEqual(snapshot);
  });
});
