/**
 * Regression tests for autopilot reconnect (#167 / #164).
 *
 * The autopilot daemon calls engine.connect() on reconnect.  Previously it
 * passed no arguments, crashing PostgresEngine with "undefined is not an
 * object (evaluating 'config.poolSize')".  After the fix, autopilot re-loads
 * config from disk and passes it to connect().
 *
 * These tests verify:
 *   1. PostgresEngine.connect() throws a descriptive error when called without config
 *   2. PGLiteEngine.connect() throws a descriptive error when called without config
 *   3. The autopilot source code passes config to connect() on reconnect
 *   4. autopilot.ts imports loadConfig and toEngineConfig
 *   5. The reconnect block handles missing config gracefully
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

describe('autopilot reconnect (#167 / #164)', () => {

  // --- Source-code audit tests ---

  test('autopilot.ts imports loadConfig and toEngineConfig', () => {
    const src = readFileSync(join(ROOT, 'src/commands/autopilot.ts'), 'utf-8');
    expect(src).toContain("import { loadConfig, toEngineConfig } from '../core/config.ts'");
  });

  test('autopilot reconnect block passes config to engine.connect()', () => {
    const src = readFileSync(join(ROOT, 'src/commands/autopilot.ts'), 'utf-8');
    // The reconnect block should call loadConfig() and pass the result to connect()
    expect(src).toContain('loadConfig()');
    expect(src).toContain('toEngineConfig(freshConfig)');
    expect(src).toContain('engine.connect(toEngineConfig(freshConfig))');
  });

  test('autopilot reconnect block does NOT call connect() with no arguments', () => {
    const src = readFileSync(join(ROOT, 'src/commands/autopilot.ts'), 'utf-8');
    // The old buggy pattern: (engine as any).connect?.()
    expect(src).not.toContain('connect?.()');
    expect(src).not.toContain('.connect()');
  });

  test('autopilot reconnect handles missing config (no brain configured)', () => {
    const src = readFileSync(join(ROOT, 'src/commands/autopilot.ts'), 'utf-8');
    // Should check if freshConfig is null/undefined before calling connect
    expect(src).toContain('if (freshConfig)');
    expect(src).toContain('No brain configuration found');
  });

  // --- Engine guard tests ---

  test('PostgresEngine.connect() guards against undefined config', () => {
    const src = readFileSync(join(ROOT, 'src/core/postgres-engine.ts'), 'utf-8');
    // Should check !config before accessing config.poolSize
    expect(src).toContain('if (!config)');
    expect(src).toContain('connect() called without config');
  });

  test('PGLiteEngine.connect() guards against undefined config', () => {
    const src = readFileSync(join(ROOT, 'src/core/pglite-engine.ts'), 'utf-8');
    expect(src).toContain('if (!config)');
    expect(src).toContain('connect() called without config');
  });

  // --- Behavioral tests (no real DB needed) ---

  test('PostgresEngine.connect(undefined) throws descriptive GBrainError', async () => {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await expect(engine.connect(undefined as any)).rejects.toThrow(/called without config/);
  });

  test('PGLiteEngine.connect(undefined) throws descriptive error', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await expect(engine.connect(undefined as any)).rejects.toThrow(/called without config/);
  });

  // --- loadConfig + toEngineConfig round-trip ---

  test('toEngineConfig produces a valid EngineConfig from GBrainConfig', async () => {
    const { toEngineConfig } = await import('../src/core/config.ts');
    const result = toEngineConfig({
      engine: 'postgres',
      database_url: 'postgresql://localhost/test',
    });
    expect(result).toEqual({
      engine: 'postgres',
      database_url: 'postgresql://localhost/test',
      database_path: undefined,
    });
  });

  test('toEngineConfig with pglite config', async () => {
    const { toEngineConfig } = await import('../src/core/config.ts');
    const result = toEngineConfig({
      engine: 'pglite',
      database_path: '/tmp/test.pglite',
    });
    expect(result).toEqual({
      engine: 'pglite',
      database_url: undefined,
      database_path: '/tmp/test.pglite',
    });
  });
});
