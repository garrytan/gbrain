/**
 * Bug 5 + Bug 8 — v0_14_0 orchestrator regression.
 *
 * The migration ships:
 *   - Phase A (schema): ALTER minion_jobs.max_stalled SET DEFAULT 3
 *   - Phase B (host-work): append skill-ping entry to
 *     ~/.gbrain/migrations/pending-host-work.jsonl
 *
 * Both phases are idempotent — re-running the migration is a no-op after
 * the first successful pass.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpHome: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v0_14_0-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Bug 5 + Bug 8 — v0_14_0 module shape', () => {
  test('v0_14_0 is registered in migrations/index.ts', async () => {
    const { migrations } = await import('../src/commands/migrations/index.ts');
    const m = migrations.find(x => x.version === '0.14.0');
    expect(m).toBeDefined();
    expect(m!.featurePitch.headline).toBeTruthy();
  });

  test('v0_14_0 does NOT write the ledger directly', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_14_0.ts', import.meta.url)).text();
    expect(source).not.toContain('appendCompletedMigration');
  });

  test('orchestrator returns complete when phase A is skipped (no config)', async () => {
    const { v0_14_0 } = await import('../src/commands/migrations/v0_14_0.ts');
    // No loadConfig() backing → phaseASchema reports skipped (no brain).
    // Phase B still emits the host-work ping.
    const result = await v0_14_0.orchestrator({
      yes: true,
      dryRun: false,
      noAutopilotInstall: true,
    });
    expect(['complete', 'partial']).toContain(result.status);
    expect(result.version).toBe('0.14.0');
    const hostWork = result.phases.find(p => p.name === 'host-work');
    expect(hostWork).toBeDefined();
  });
});

describe('Bug 5 — Phase B host-work entry dedup', () => {
  test('first run writes the entry, second run is a skip', async () => {
    const { v0_14_0 } = await import('../src/commands/migrations/v0_14_0.ts');

    const first = await v0_14_0.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    const hostPath = join(tmpHome, '.gbrain', 'migrations', 'pending-host-work.jsonl');
    expect(existsSync(hostPath)).toBe(true);

    const beforeLines = readFileSync(hostPath, 'utf-8').split('\n').filter(l => l.trim()).length;
    expect(beforeLines).toBe(1);

    // Second run — Phase B should skip, not duplicate.
    await v0_14_0.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    const afterLines = readFileSync(hostPath, 'utf-8').split('\n').filter(l => l.trim()).length;
    expect(afterLines).toBe(1);

    const entry = JSON.parse(readFileSync(hostPath, 'utf-8').split('\n')[0]);
    expect(entry.migration).toBe('0.14.0');
    expect(entry.skill).toBe('skills/migrations/v0.14.0.md');
  });

  test('dry-run writes nothing', async () => {
    const { v0_14_0 } = await import('../src/commands/migrations/v0_14_0.ts');
    await v0_14_0.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    const hostPath = join(tmpHome, '.gbrain', 'migrations', 'pending-host-work.jsonl');
    expect(existsSync(hostPath)).toBe(false);
  });
});

describe('Bug 8 — max_stalled default bumped in schema files', () => {
  test('schema-embedded.ts has max_stalled DEFAULT 3', async () => {
    const source = await Bun.file(new URL('../src/core/schema-embedded.ts', import.meta.url)).text();
    expect(source).toContain('max_stalled      INTEGER     NOT NULL DEFAULT 3');
  });
  test('pglite-schema.ts has max_stalled DEFAULT 3', async () => {
    const source = await Bun.file(new URL('../src/core/pglite-schema.ts', import.meta.url)).text();
    expect(source).toContain('max_stalled      INTEGER     NOT NULL DEFAULT 3');
  });
  test('schema.sql has max_stalled DEFAULT 3', async () => {
    const source = await Bun.file(new URL('../src/schema.sql', import.meta.url)).text();
    expect(source).toContain('max_stalled      INTEGER     NOT NULL DEFAULT 3');
  });
});
