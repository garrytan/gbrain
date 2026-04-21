/**
 * Tests for `gbrain apply-migrations` — the migration runner CLI.
 *
 * Unit-scope: exercises the pure helpers (parseArgs, indexCompleted, buildPlan,
 * statusForVersion). End-to-end integration against real orchestrators is
 * covered by test/e2e/migration-flow.test.ts (Lane C-5).
 */

import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/commands/apply-migrations.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

const { parseArgs, indexCompleted, buildPlan, statusForVersion } = __testing;

describe('parseArgs', () => {
  test('default flags', () => {
    const a = parseArgs([]);
    expect(a.list).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.nonInteractive).toBe(false);
    expect(a.mode).toBeUndefined();
    expect(a.specificMigration).toBeUndefined();
    expect(a.hostDir).toBeUndefined();
    expect(a.noAutopilotInstall).toBe(false);
  });

  test('--list / --dry-run / --yes / --non-interactive', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('--mode accepts valid values', () => {
    expect(parseArgs(['--mode', 'always']).mode).toBe('always');
    expect(parseArgs(['--mode', 'pain_triggered']).mode).toBe('pain_triggered');
    expect(parseArgs(['--mode', 'off']).mode).toBe('off');
  });

  test('--migration and --host-dir parse values', () => {
    const a = parseArgs(['--migration', '0.11.0', '--host-dir', '/tmp/abc']);
    expect(a.specificMigration).toBe('0.11.0');
    expect(a.hostDir).toBe('/tmp/abc');
  });

  test('--no-autopilot-install flips flag', () => {
    expect(parseArgs(['--no-autopilot-install']).noAutopilotInstall).toBe(true);
  });

  test('--help sets help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('indexCompleted + statusForVersion', () => {
  test('no entries → pending', () => {
    const idx = indexCompleted([]);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
  });

  test('one complete entry → complete', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only partial entries → partial', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('partial');
  });

  test('partial then complete → complete (stopgap then v0.11.1 apply-migrations)', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only looks at the queried version', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.10.0', status: 'complete' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
    expect(statusForVersion('0.10.0', idx)).toBe('complete');
  });
});

describe('buildPlan — diff against completed + installed VERSION', () => {
  test('fresh install (no entries) — v0.11.0 is pending when installed ≥ 0.11.0', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // Future migrations (registered but newer than installed VERSION) land in
    // skippedFuture until the binary catches up. v0.13.0 = frontmatter graph
    // (master), v0.13.1 = Knowledge Runtime grandfather, v0.14.0 = shell
    // jobs + autopilot cooperative.
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.14.0']);
  });

  test('already applied → v0.11.0 lands in `applied` bucket, not pending', () => {
    const idx = indexCompleted([{ version: '0.11.0', status: 'complete' }]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('stopgap wrote partial → v0.11.0 lands in `partial` bucket (resumable)', () => {
    const idx = indexCompleted([
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.partial.map(m => m.version)).toContain('0.11.0');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed older than migration → skippedFuture, not skipped silently', () => {
    // Running a v0.10.x binary that somehow loaded a v0.11.0 migration registry:
    // migration is skippedFuture (wait for a newer install), NOT ignored.
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.10.5');
    expect(plan.skippedFuture.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed > migration version → still runs (not skipped)', () => {
    // This is the critical bug Codex caught: the plan was "apply when version >
    // installed", which would SKIP v0.11.0 when running v0.11.1. The correct
    // rule is "apply when not in completed.jsonl AND version ≤ installed".
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.12.0');
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // v0.12.2, v0.13.0, v0.13.1, and v0.14.0 were added later; installed=0.12.0
    // means they belong in skippedFuture, not pending. v0.11.0 and v0.12.0
    // stay pending despite being ≤ installed — that is the H9 invariant.
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.2', '0.13.0', '0.13.1', '0.14.0']);
  });

  test('--migration filter narrows to one version', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '0.11.0');
    expect(plan.pending.map(m => m.version)).toEqual(['0.11.0']);
  });

  test('--migration filter for unknown version → empty plan', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '99.99.99');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.skippedFuture).toEqual([]);
  });
});
