/**
 * Tests for the v0.13.0 frontmatter relationship indexing migration.
 *
 * Iron rule (regression guard for Bug 1, v0.14.0 upgrade night): phase
 * handlers must shell out to the bare string `gbrain`, NOT to
 * `process.execPath`. On bun-installed trees execPath is the bun runtime;
 * `bun extract ...` gets interpreted as `bun run extract` and the upgrade
 * crashes mid-migration. The canonical shim on PATH is the right target.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_PATH = join(__dirname, '..', 'src', 'commands', 'migrations', 'v0_13_0.ts');

describe('v0.13.0 — Frontmatter relationship indexing migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.13.0');
    const m = getMigration('0.13.0');
    expect(m).not.toBeNull();
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_13_0.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBBackfill).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_13_0 } = await import('../src/commands/migrations/v0_13_0.ts');
    const result = await v0_13_0.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    expect(result.version).toBe('0.13.0');
    for (const phase of result.phases) {
      expect(phase.status).toBe('skipped');
      expect(phase.detail).toBe('dry-run');
    }
  });

  // ── Regression guards (Bug 1) ──────────────────────────────

  test('source does NOT reference process.execPath (Bug 1 regression)', () => {
    // process.execPath on a bun install is the bun runtime itself, so
    // `${process.execPath} extract` becomes `bun run extract` and dies.
    // See v0.14.0 upgrade-night postmortem.
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toContain('process.execPath');
  });

  test('source does NOT build commands from a GBRAIN constant (Bug 1 regression)', () => {
    // Earlier revisions used `const GBRAIN = process.execPath` and built
    // commands as `${GBRAIN} extract ...`. The constant was the vector.
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toMatch(/const\s+GBRAIN\s*=/);
    expect(src).not.toMatch(/\$\{GBRAIN\}/);
  });

  test('phase commands invoke bare `gbrain` shell-out (Bug 1 fix)', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    // All three phases shell out to bare `gbrain` so the canonical shim
    // on PATH wins. This is the shape v0_12_0 has always used.
    expect(src).toContain("execSync('gbrain init --migrate-only'");
    expect(src).toContain("execSync('gbrain extract links --source db --include-frontmatter'");
    expect(src).toContain("execSync('gbrain call get_stats'");
  });

  test('phase commands never reference `bun` or `.ts` paths (Bug 1 regression)', () => {
    // Belt-and-suspenders: even if someone reintroduces a runtime-path
    // helper, they must not produce `bun ...` or `<path>.ts` as the spawn
    // target.
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toMatch(/execSync\([^)]*\bbun\b/);
    expect(src).not.toMatch(/execSync\([^)]*\.ts/);
  });
});
