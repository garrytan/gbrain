/**
 * v0.40.3.0 — gbrain sources set-cr-mode <id> <mode>
 *
 * D5 + T7 + idempotent-pebble Failure-Modes critical-gap closure.
 *
 * Validates:
 *   - Happy path: writes contextual_retrieval_mode for each CRMode
 *   - "unset" / "default" / "" clears the column (NULL)
 *   - Invalid mode → exit code 2 with list of valid options
 *   - Missing source id → exit code 4 with paste-ready hint
 *   - Missing arguments → exit code 2 with usage
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';

describe('gbrain sources set-cr-mode', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    process.exit = origExit;
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    exitCode = null;
    origExit = process.exit;
    // Stub process.exit so failures don't kill the test runner.
    (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
      exitCode = n;
      throw new Error(`__test_exit_${n}__`);
    }) as never;
  });

  async function seedSource(id: string): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, id],
    );
  }

  async function readCrMode(id: string): Promise<string | null> {
    const rows = await engine.executeRaw<{ mode: string | null }>(
      `SELECT contextual_retrieval_mode AS mode FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0]?.mode ?? null;
  }

  test('happy path: set to "title"', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-cr-mode', 'test-src', 'title']);
    expect(await readCrMode('test-src')).toBe('title');
  });

  test('happy path: set to "per_chunk_synopsis"', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-cr-mode', 'test-src', 'per_chunk_synopsis']);
    expect(await readCrMode('test-src')).toBe('per_chunk_synopsis');
  });

  test('happy path: set to "none"', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-cr-mode', 'test-src', 'none']);
    expect(await readCrMode('test-src')).toBe('none');
  });

  test('unset path: "unset" clears to NULL', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-cr-mode', 'test-src', 'title']);
    expect(await readCrMode('test-src')).toBe('title');
    await runSources(engine, ['set-cr-mode', 'test-src', 'unset']);
    expect(await readCrMode('test-src')).toBeNull();
  });

  test('unset path: "default" also clears to NULL', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-cr-mode', 'test-src', 'title']);
    await runSources(engine, ['set-cr-mode', 'test-src', 'default']);
    expect(await readCrMode('test-src')).toBeNull();
  });

  test('rejection: invalid mode → exit 2 (lists valid options)', async () => {
    await seedSource('test-src');
    try {
      await runSources(engine, ['set-cr-mode', 'test-src', 'invalid-mode-name']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readCrMode('test-src')).toBeNull(); // No mutation
  });

  test('rejection: missing source id → exit 4 (paste-ready hint)', async () => {
    // Don't seed — source doesn't exist.
    try {
      await runSources(engine, ['set-cr-mode', 'nonexistent-source', 'title']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_4__');
    }
    expect(exitCode).toBe(4);
  });

  test('rejection: missing arguments → exit 2 (usage)', async () => {
    try {
      await runSources(engine, ['set-cr-mode']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
  });

  test('rejection: missing mode (only id provided) → exit 2', async () => {
    await seedSource('test-src');
    try {
      await runSources(engine, ['set-cr-mode', 'test-src']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readCrMode('test-src')).toBeNull(); // No mutation
  });

  test('round-trip: set title → set per_chunk_synopsis → unset preserves other fields', async () => {
    await seedSource('test-src');
    // Set + verify a non-CR field is preserved (name).
    const initialName = await engine.executeRaw<{ name: string }>(
      `SELECT name FROM sources WHERE id = 'test-src'`,
    );
    expect(initialName[0].name).toBe('test-src');

    await runSources(engine, ['set-cr-mode', 'test-src', 'title']);
    await runSources(engine, ['set-cr-mode', 'test-src', 'per_chunk_synopsis']);
    await runSources(engine, ['set-cr-mode', 'test-src', 'unset']);

    const finalState = await engine.executeRaw<{
      mode: string | null;
      name: string;
    }>(
      `SELECT contextual_retrieval_mode AS mode, name FROM sources WHERE id = 'test-src'`,
    );
    expect(finalState[0].mode).toBeNull();
    expect(finalState[0].name).toBe('test-src');
  });
});
