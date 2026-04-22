/**
 * Unit tests for v0.16.0 migration orchestrator + registry.
 *
 * The full schema verification lives in E2E (Postgres). These unit tests
 * cover:
 *  - registry wiring (v0.16.0 registered + lookup works)
 *  - v0.14.0 noop stub wired (gapless version sequence)
 *  - migration metadata (version, pitch)
 *  - dry-run short-circuits both phases
 *  - required table names constant
 */

import { describe, test, expect } from 'bun:test';
import { migrations, getMigration } from '../src/commands/migrations/index.ts';
import { __testing } from '../src/commands/migrations/v0_16_0.ts';

describe('v0.16.0 migration', () => {
  test('is registered in the migrations registry', () => {
    const v0_16_0 = getMigration('0.16.0');
    expect(v0_16_0).not.toBeNull();
    expect(v0_16_0?.version).toBe('0.16.0');
  });

  test('v0.14.0 noop stub is registered (gapless sequence)', () => {
    const v0_14_0 = getMigration('0.14.0');
    expect(v0_14_0).not.toBeNull();
    expect(v0_14_0?.version).toBe('0.14.0');
  });

  test('migrations array has no version gaps through 0.16.0', () => {
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.13.1');
    expect(versions).toContain('0.14.0');
    expect(versions).toContain('0.16.0');
    // order check — registry is semver-sorted in the source
    const v15Idx = versions.indexOf('0.16.0');
    const v14Idx = versions.indexOf('0.14.0');
    const v131Idx = versions.indexOf('0.13.1');
    expect(v131Idx).toBeLessThan(v14Idx);
    expect(v14Idx).toBeLessThan(v15Idx);
  });

  test('feature pitch has headline and description', () => {
    const m = getMigration('0.16.0');
    expect(m?.featurePitch.headline).toBeTruthy();
    expect(m?.featurePitch.description).toBeTruthy();
  });

  test('REQUIRED_TABLES lists all three subagent tables', () => {
    expect(__testing.REQUIRED_TABLES).toEqual([
      'subagent_messages',
      'subagent_tool_executions',
      'subagent_rate_leases',
    ]);
  });

  test('phaseASchema skips on dry-run', () => {
    const r = __testing.phaseASchema({ dryRun: true, yes: true, noAutopilotInstall: true });
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('phaseBVerify skips on dry-run', async () => {
    const r = await __testing.phaseBVerify({ dryRun: true, yes: true, noAutopilotInstall: true });
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('orchestrator in dry-run returns complete with both phases skipped', async () => {
    const m = getMigration('0.16.0');
    const result = await m!.orchestrator({ dryRun: true, yes: true, noAutopilotInstall: true });
    expect(result.version).toBe('0.16.0');
    expect(result.phases.length).toBe(2);
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);
  });
});

describe('schema-embedded.ts contains subagent tables', () => {
  test('embedded schema references all three subagent tables', async () => {
    const { SCHEMA_SQL } = await import('../src/core/schema-embedded.ts');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_messages');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_tool_executions');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_rate_leases');
    expect(SCHEMA_SQL).toContain('idx_subagent_messages_job');
    expect(SCHEMA_SQL).toContain('idx_subagent_tools_job');
    expect(SCHEMA_SQL).toContain('idx_rate_leases_key_expires');
  });
});

describe('pglite-schema.ts contains subagent tables', () => {
  test('embedded PGLite schema references all three subagent tables', async () => {
    const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_messages');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_tool_executions');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS subagent_rate_leases');
  });
});
