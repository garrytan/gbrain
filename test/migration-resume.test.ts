/**
 * Bug 3 regression — migration resume semantics.
 *
 * Covers:
 *   - statusForVersion prefers 'complete' over 'partial' (never regresses).
 *   - Three consecutive 'partial' entries flip a migration to 'wedged'.
 *   - 'retry' marker resets the counter; next run treats it as fresh.
 *   - appendCompletedMigration no-ops on double 'complete' (idempotency).
 *
 * Infrastructure: point HOME at a tmpdir so the ledger writes don't
 * stomp the real ~/.gbrain/migrations/completed.jsonl.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpHome: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migration-resume-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Bug 3 — statusForVersion semantics', () => {
  test("complete wins over partial regardless of order", async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'complete' },
      { version: '0.13.0', status: 'partial' },
    ] as any);
    expect(__testing.statusForVersion('0.13.0', idx)).toBe('complete');

    const idx2 = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'complete' },
    ] as any);
    expect(__testing.statusForVersion('0.13.0', idx2)).toBe('complete');
  });

  test('two consecutive partials stay at partial', async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
    ] as any);
    expect(__testing.statusForVersion('0.13.0', idx)).toBe('partial');
  });

  test('three consecutive partials flip to wedged', async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
    ] as any);
    expect(__testing.statusForVersion('0.13.0', idx)).toBe('wedged');
  });

  test("retry marker resets the counter", async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'retry' },
    ] as any);
    // After 'retry', the version is pending (fresh start).
    expect(__testing.statusForVersion('0.13.0', idx)).toBe('pending');
  });

  test('complete after wedge is still complete (terminal)', async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'retry' },
      { version: '0.13.0', status: 'complete' },
    ] as any);
    expect(__testing.statusForVersion('0.13.0', idx)).toBe('complete');
  });
});

describe('Bug 3 — appendCompletedMigration idempotency', () => {
  test('writing complete when last entry is already complete is a no-op', async () => {
    const { appendCompletedMigration, loadCompletedMigrations } = await import('../src/core/preferences.ts');
    appendCompletedMigration({ version: '9.9.9', status: 'complete' });
    const first = loadCompletedMigrations().filter(e => e.version === '9.9.9');
    expect(first.length).toBe(1);

    appendCompletedMigration({ version: '9.9.9', status: 'complete' });
    const second = loadCompletedMigrations().filter(e => e.version === '9.9.9');
    expect(second.length).toBe(1);
  });

  test('partial always appends (needed for attempt-cap counter)', async () => {
    const { appendCompletedMigration, loadCompletedMigrations } = await import('../src/core/preferences.ts');
    appendCompletedMigration({ version: '9.9.9', status: 'partial' });
    appendCompletedMigration({ version: '9.9.9', status: 'partial' });
    const entries = loadCompletedMigrations().filter(e => e.version === '9.9.9');
    expect(entries.length).toBe(2);
  });

  test("'retry' status is accepted", async () => {
    const { appendCompletedMigration, loadCompletedMigrations } = await import('../src/core/preferences.ts');
    appendCompletedMigration({ version: '9.9.9', status: 'retry' } as any);
    const entries = loadCompletedMigrations().filter(e => e.version === '9.9.9');
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe('retry');
  });
});

describe('Bug 3 — orchestrator no longer writes the ledger directly', () => {
  test('v0_13_0 does not import appendCompletedMigration', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_13_0.ts', import.meta.url)).text();
    expect(source).not.toContain('import { appendCompletedMigration }');
  });
  test('v0_13_1 does not import appendCompletedMigration', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_13_1.ts', import.meta.url)).text();
    expect(source).not.toContain('import { appendCompletedMigration }');
  });
  test('v0_12_0 does not import appendCompletedMigration', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_12_0.ts', import.meta.url)).text();
    expect(source).not.toContain('import { appendCompletedMigration }');
  });
  test('v0_12_2 does not import appendCompletedMigration', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_12_2.ts', import.meta.url)).text();
    expect(source).not.toContain('import { appendCompletedMigration }');
  });
  test('v0_11_0 does not import appendCompletedMigration', async () => {
    const source = await Bun.file(new URL('../src/commands/migrations/v0_11_0.ts', import.meta.url)).text();
    // Import statement should not reference appendCompletedMigration; the
    // old call site is replaced with a comment.
    expect(source).not.toMatch(/import .*appendCompletedMigration.*from/);
  });

  test('apply-migrations.ts runner writes the ledger', async () => {
    const source = await Bun.file(new URL('../src/commands/apply-migrations.ts', import.meta.url)).text();
    expect(source).toContain("import { loadCompletedMigrations, appendCompletedMigration");
    expect(source).toContain("appendCompletedMigration({");
    expect(source).toContain("'retry'");
    expect(source).toContain('--force-retry');
    expect(source).toContain('MAX_CONSECUTIVE_PARTIALS');
  });
});

describe('Bug 3 — buildPlan surfaces wedged migrations', () => {
  test('wedged bucket exists in the plan', async () => {
    const { __testing } = await import('../src/commands/apply-migrations.ts');
    const idx = __testing.indexCompleted([
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
      { version: '0.13.0', status: 'partial' },
    ] as any);
    const plan = __testing.buildPlan(idx, '0.13.0', '0.13.0'); // filter to just this version
    expect(plan.wedged.length).toBe(1);
    expect(plan.wedged[0].version).toBe('0.13.0');
    expect(plan.pending.length).toBe(0);
    expect(plan.partial.length).toBe(0);
  });
});
