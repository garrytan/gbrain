/**
 * v0.29.1 orchestrator contract tests.
 *
 * Validates registration, phase shape, and dry-run behavior without
 * actually running `gbrain init --migrate-only` or touching a database.
 *
 * Added as part of the cold-start robustness fix (2026-05-08):
 *   Bug 1 — phaseBBackfill / phaseCVerify were missing engine.connect()
 *            calls, causing "No database connection" on any cold-start
 *            upgrade from a pre-v0.29.1 schema.
 */

import { describe, test, expect } from 'bun:test';

describe('v0.29.1 orchestrator — backfill effective_date', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.29.1');
    const m = getMigration('0.29.1');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('salience');
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('v0.29.1 comes after v0.28.0 in registry order', async () => {
    const { migrations } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    const idx28 = versions.indexOf('0.28.0');
    const idx29 = versions.indexOf('0.29.1');
    expect(idx28).toBeGreaterThanOrEqual(0);
    expect(idx29).toBeGreaterThan(idx28);
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_29_1.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBBackfill).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_29_1 } = await import('../src/commands/migrations/v0_29_1.ts');
    const result = await v0_29_1.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    expect(result.version).toBe('0.29.1');
    expect(result.phases.length).toBeGreaterThanOrEqual(3);
    const skippedCount = result.phases.filter(p => p.status === 'skipped').length;
    expect(skippedCount).toBe(result.phases.length); // all phases skip in dry-run
  });

  test('dry-run phase names match expected shape (schema, backfill_effective_date, verify)', async () => {
    const { v0_29_1 } = await import('../src/commands/migrations/v0_29_1.ts');
    const result = await v0_29_1.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    const names = result.phases.map(p => p.name);
    expect(names).toContain('schema');
    expect(names).toContain('backfill_effective_date');
    expect(names).toContain('verify');
  });
});
