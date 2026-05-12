/**
 * v0.31.2 (B3 ship-blocker fix) — orchestrator gate test.
 *
 * The v0_31_0 orchestrator's phaseASchema is the precondition check
 * `gbrain post-upgrade` runs. It must:
 *   - Reject brains at schema_version < 45 (facts table not yet created).
 *   - Pass brains at schema_version >= 45 with the facts table present.
 *   - Surface a useful operator-facing message that names the version
 *     and the recovery command (`gbrain apply-migrations --yes`).
 *
 * Pre-fix, the gate had been demoted to `v < 40` with a misleading
 * "+ notability" claim. v40 brains passed the precondition without
 * having the facts table, then crashed on the post-condition check
 * three lines later. Restored here to `v < 45` (table-existence
 * precondition); column shape is enforced by migration v46 alone.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEngine } from '../src/core/engine-factory.ts';
import { __testing, __setTestEngineOverride } from '../src/commands/migrations/v0_31_0.ts';
import { runMigrationsUpTo } from './e2e/helpers.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('v0.31.0 orchestrator — phaseASchema gate', () => {
  let tmp: string;
  let oldGbrainHome: string | undefined;
  let engine: BrainEngine;

  beforeEach(async () => {
    oldGbrainHome = process.env.GBRAIN_HOME;
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-v0310-gate-'));
    process.env.GBRAIN_HOME = tmp;

    const gbrainHome = join(tmp, '.gbrain');
    const dbPath = join(tmp, 'brain-db');
    mkdirSync(gbrainHome, { recursive: true });
    writeFileSync(
      join(gbrainHome, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dbPath }, null, 2) + '\n',
    );

    engine = await createEngine({ engine: 'pglite', database_path: dbPath });
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    __setTestEngineOverride(engine);
  });

  afterEach(async () => {
    __setTestEngineOverride(null);
    await engine.disconnect();
    if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = oldGbrainHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('schema_version < 45 fails with operator-facing message naming v45 + recovery command', async () => {
    // Roll the version backwards to simulate a brain stuck at pre-v45.
    await engine.setConfig('version', '40');

    const result = await __testing.phaseASchema(engine, { yes: true, dryRun: false, noAutopilotInstall: true });

    expect(result.name).toBe('schema');
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('version >= 45');
    expect(result.detail).toContain('apply-migrations');
    // Negative: must NOT mention 'v40' as the gate version (the prior bug).
    expect(result.detail).not.toContain('version >= 40');
    // Negative: must NOT carry the misleading "+ notability" claim from
    // the prior gate text — column shape is enforced by v46, not gated here.
    expect(result.detail).not.toContain('notability');
  });

  test('schema_version >= 45 with facts table present → status complete', async () => {
    // Advance the brain to LATEST so v45 + v46 land and the facts table exists.
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    await runMigrationsUpTo(engine as never, LATEST_VERSION);

    const result = await __testing.phaseASchema(engine, { yes: true, dryRun: false, noAutopilotInstall: true });

    expect(result.status).toBe('complete');
    expect(result.detail).toContain('facts table present');
  });

  test('dryRun short-circuits before any DB read', async () => {
    const result = await __testing.phaseASchema(engine, { yes: true, dryRun: true, noAutopilotInstall: true });

    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('dry-run');
  });

  test('null engine short-circuits with no_brain_configured', async () => {
    const result = await __testing.phaseASchema(null, { yes: true, dryRun: false, noAutopilotInstall: true });

    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('no_brain_configured');
  });
});
