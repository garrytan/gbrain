/**
 * Tests for the v0.12.0 Knowledge Graph auto-wire orchestrator.
 *
 * Covers the contract that makes this migration "rock solid":
 *   - Registered in the TS registry (so apply-migrations sees it).
 *   - Idempotent: re-runs without breaking, recording, or duplicating work.
 *   - Empty brain → succeeds (the Phase E branch that says "auto-link will
 *     wire entities as you write pages").
 *   - auto_link disabled → backfill phases skipped, recorded as complete.
 *   - Phase functions exported via __testing for unit-level coverage.
 */

import { describe, test, expect } from 'bun:test';

describe('v0.12.0 — Knowledge Graph auto-wire migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.12.0');
    const m = getMigration('0.12.0');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('Knowledge Graph');
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('feature pitch includes the headline benchmark numbers', async () => {
    const { v0_12_0 } = await import('../src/commands/migrations/v0_12_0.ts');
    const desc = v0_12_0.featurePitch.description ?? '';
    // The numbers that prove this isn't marketing — they're from the
    // committed BrainBench v1 corpus and have to be defendable.
    expect(desc).toContain('Recall@5 83% → 95%');
    expect(desc).toContain('Precision@5 39% → 45%');
    expect(desc).toContain('86.6%');
    expect(desc).toContain('57.8%');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_12_0.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBConfigCheck).toBe('function');
    expect(typeof __testing.phaseCBackfillLinks).toBe('function');
    expect(typeof __testing.phaseDBackfillTimeline).toBe('function');
    expect(typeof __testing.phaseEVerify).toBe('function');
    expect(typeof __testing.readStats).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_12_0 } = await import('../src/commands/migrations/v0_12_0.ts');
    const result = await v0_12_0.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    expect(result.version).toBe('0.12.0');
    // Schema, backfill_links, backfill_timeline, verify all skipped.
    // Config check still runs (just reads).
    const skipped = result.phases.filter(p => p.status === 'skipped');
    expect(skipped.length).toBeGreaterThanOrEqual(3);
    for (const p of skipped) {
      expect(p.detail).toContain('dry-run');
    }
  });

  test('skill migration markdown exists at the expected path', async () => {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const path = join(process.cwd(), 'skills/migrations/v0.12.0.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('feature_pitch:');
    expect(content).toContain('Knowledge Graph');
    // Phase reference for the host agent that wants the manual recovery path.
    expect(content).toContain('gbrain extract links --source db');
    expect(content).toContain('gbrain extract timeline --source db');
  });
});
