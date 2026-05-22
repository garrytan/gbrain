/**
 * Tests for the v0.12.2 JSONB-double-encode-repair orchestrator.
 *
 * Covers the contract that makes this migration safe to ship:
 *   - Registered in the TS registry (so apply-migrations sees it).
 *   - Phase functions exported via __testing for unit-level coverage.
 *   - Dry-run skips all side-effect phases.
 *   - Feature pitch explains what the user can NOW do that they couldn't.
 *
 * Idempotency, repair correctness, and PGLite-no-op behavior are exercised
 * end-to-end against real Postgres in test/e2e/postgres-jsonb.test.ts.
 */

import { describe, test, expect } from 'bun:test';

describe('v0.12.2 — JSONB double-encode repair migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.12.2');
    const m = getMigration('0.12.2');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('JSONB');
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('feature pitch lists the affected columns and the recovery path', async () => {
    const { v0_12_2 } = await import('../src/commands/migrations/v0_12_2.ts');
    const desc = v0_12_2.featurePitch.description ?? '';
    expect(desc).toContain('pages.frontmatter');
    expect(desc).toContain('raw_data.data');
    expect(desc).toContain('ingest_log.pages_updated');
    expect(desc).toContain('files.metadata');
    expect(desc).toContain('page_versions.frontmatter');
    expect(desc).toContain('gbrain sync --full');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_12_2.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBRepair).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_12_2 } = await import('../src/commands/migrations/v0_12_2.ts');
    const result = await v0_12_2.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    expect(result.version).toBe('0.12.2');
    expect(result.phases.length).toBeGreaterThanOrEqual(3);
    for (const p of result.phases) {
      expect(p.status).toBe('skipped');
      expect(p.detail).toContain('dry-run');
    }
  });
});
