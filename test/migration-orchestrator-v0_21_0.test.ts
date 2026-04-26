/**
 * v0.21.0 Cathedral II Layer 13 — orchestrator contract tests.
 *
 * Validates the Migration registry wiring + phase shape without running
 * the destructive `gbrain init --migrate-only` child. Schema-level DDL
 * assertions live in test/migrations-v0_21_0.test.ts (pinned the v27
 * migration's SQL shape from Layer 1).
 */

import { describe, test, expect } from 'bun:test';

describe('v0.21.0 orchestrator — Cathedral II migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.21.0');
    const m = getMigration('0.21.0');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('Cathedral II');
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('feature pitch names the headline capabilities', async () => {
    const { v0_21_0 } = await import('../src/commands/migrations/v0_21_0.ts');
    const desc = v0_21_0.featurePitch.description ?? '';
    expect(desc).toContain('CHUNKER_VERSION');
    expect(desc).toContain('chunker_version gate');
    expect(desc).toContain('reindex-code');
    expect(desc).toContain('fence extraction');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_21_0.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBBackfillPrompt).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_21_0 } = await import('../src/commands/migrations/v0_21_0.ts');
    const result = await v0_21_0.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    expect(result.version).toBe('0.21.0');
    expect(result.phases.length).toBeGreaterThanOrEqual(3);
    const skippedCount = result.phases.filter(p => p.status === 'skipped').length;
    expect(skippedCount).toBeGreaterThanOrEqual(2);
  });

  test('v0.21.0 is the latest registered migration', async () => {
    const { migrations } = await import('../src/commands/migrations/index.ts');
    const last = migrations[migrations.length - 1]!;
    expect(last.version).toBe('0.21.0');
  });
});
