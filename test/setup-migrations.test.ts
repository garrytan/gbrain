import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/version.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { defineNormalizer, expectGolden, scrubTimestamps } from './helpers/golden.ts';
import { type Box, CLEAN, createSetupFixture, setup } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup: setup migrations on the brain it creates (Cat 41 run 4)', () => {
  /** The migration records a fresh setup leaves, byte for byte apart from timestamps, the temp home, the brain id and the release stamp (captured on master). */
  const ledgerFiles = ['completed.jsonl', 'pending-host-work.jsonl', 'v0.22.4-audit.json'];
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const migrationLedger = defineNormalizer<{ home: string; files: Record<string, string> }>('setup-migration-ledger-v1', ({ home, files }) =>
    Object.fromEntries(Object.entries(files).map(([name, text]) =>
      [name, scrubTimestamps(text.split(home).join('<home>').split(VERSION).join('<version>')).replace(UUID, '<uuid>').split('\n')])));
  const pendingSetupMigrations = async (b: Box): Promise<string[]> => {
    const r = await runCli(['apply-migrations', '--list', '--json'], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome } });
    return JSON.parse(r.stdout).plan.pending_fresh_install;
  };

  test('a fresh setup applies them itself: 0 pending, doctor shows none, no hand-off line', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/\[setup\] Migrations: \d+ recorded as not needed on a new brain; \d+ setup migration\(s\) applied by setup without installing services \([^)]+\); none pending\./);
    expect(r.stdout + r.stderr).not.toContain('Finish setup: gbrain apply-migrations');
    expect(r.stdout).toContain('Verify: ok (smoke_passed)');
    expect(await pendingSetupMigrations(b)).toEqual([]);
    const doctor = await runCli(['doctor', '--json'], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome } });
    expect(JSON.parse(doctor.stdout).checks.map((c: any) => c.name)).not.toContain('minions_migration');
    const dir = join(b.gbrainHome, '.gbrain', 'migrations');
    expectGolden('setup/fresh-setup-migration-ledger', { home: b.home, files: Object.fromEntries(ledgerFiles.map(name => [name, readFileSync(join(dir, name), 'utf8')])) }, migrationLedger);
  });

  test('an existing brain is left as it is: setup runs no migrations and prints no migrations line', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome } })).exitCode).toBe(0);
    const before = await pendingSetupMigrations(b);
    expect(before.length).toBeGreaterThan(0);
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('Migrations:');
    expect(await pendingSetupMigrations(b)).toEqual(before);
  });

  test('a host AGENTS.md v0.11.0 would edit keeps v0.11.0 pending with the hand-off; the file is untouched', async () => {
    const b = box();
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(join(b.home, '.claude', 'AGENTS.md'), '# my agent\n');
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(`0.11.0 left pending because it edits ${join(b.home, '.claude', 'AGENTS.md')}, which setup does not own. Finish it: gbrain apply-migrations --yes --no-autopilot-install`);
    expect(readFileSync(join(b.home, '.claude', 'AGENTS.md'), 'utf8')).toBe('# my agent\n');
    expect(await pendingSetupMigrations(b)).toEqual(['0.11.0']);
  });
});
