/**
 * #6696 (PR C, C5): a wedged orchestrator migration (3+ consecutive partial
 * runs with no completion) is outstanding work, not "All migrations up to
 * date". The run reports `migrations_pending` with reason `wedged` and a fix
 * the agent asks the user about (`--force-retry <v>`), `--list --json` lists
 * it with that fix, and the human `--list` never prints "up to date". A wedge
 * a newer migration already ran past is history (doctor's forward-progress
 * rule, `minions_migration`): the run succeeds and lists no wedged fix.
 *
 * Spawns the CLI against a throwaway PGLite brain (HOME / GBRAIN_HOME per
 * subprocess; process.env is never mutated).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
/** The newest registered migration: nothing can run past it, so its wedge is outstanding. */
const WEDGED = '0.60.31';
/** Older than migrations that run on a fresh brain (v0.28.0 among them), so its wedge is superseded. */
const SUPERSEDED = '0.22.4';
let home: string;
let base: string[];

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO, env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-wedged-6696-')));
  expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  expect((await cli(['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
  base = readFileSync(ledgerPath(), 'utf8').split('\n').filter(line => line.trim());
}, 240_000);

const ledgerPath = () => join(home, '.gbrain', 'migrations', 'completed.jsonl');
/** The fresh brain's ledger with `version`'s entries replaced by three consecutive partial runs. */
function wedge(version: string): void {
  const partial = (n: number) => JSON.stringify({ ts: `2026-10-0${n}T00:00:00.000Z`, version, status: 'partial' });
  writeFileSync(ledgerPath(), [...base.filter(line => JSON.parse(line).version !== version), partial(1), partial(2), partial(3)].join('\n') + '\n');
}

afterAll(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('apply-migrations with a wedged migration (#6696 C5)', () => {
  test('a run reports migrations_pending reason wedged with an ask_user force-retry fix instead of up to date', async () => {
    wedge(WEDGED);
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.stdout).not.toContain('"status":"up_to_date"');
    expect(run.exitCode).toBe(1);
    const envelope = JSON.parse(run.stdout) as Record<string, any>;
    expect(envelope).toMatchObject({ code: 'migrations_pending', reason: 'wedged' });
    expect(envelope.message).toContain(`v${WEDGED}`);
    expect(envelope.fix).toMatchObject({ next: 'ask_user', argv: ['gbrain', 'apply-migrations', '--force-retry', WEDGED],
      verify: { argv: ['gbrain', 'apply-migrations', '--list', '--json'] } });
    // #6755: the advice names the ledger that records the failing phases, not upgrade-errors.jsonl.
    for (const text of [envelope.suggestion, envelope.fix.user_message, run.stderr]) {
      expect(text).toContain(ledgerPath());
      expect(text).toContain('phases[].detail, if present');
      expect(text).not.toContain('upgrade-errors.jsonl');
    }
  }, 120_000);

  test('upgrade names the completion ledger for a wedged migration (#6755)', async () => {
    wedge(WEDGED);
    const proc = Bun.spawn([process.execPath, '-e', `
      import { describeMigrationFailure } from './src/commands/upgrade.ts';
      import { CODES } from './src/core/error-registry.ts';
      console.log(await describeMigrationFailure({}, '${WEDGED}'));
      console.log(CODES.migrations_pending.suggestion);
    `], { cwd: REPO, env: { ...process.env, HOME: home, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain(ledgerPath());
    expect(stdout).toContain('phases[].detail, if present');
    expect(stdout).toContain(`gbrain apply-migrations --force-retry ${WEDGED}`);
    expect(stdout).toContain('migrations/completed.jsonl (phases[].detail, if present');
    expect(stdout).not.toContain('upgrade-errors.jsonl');
  }, 30_000);

  test('--list --json lists the wedged migration with its fix; the human --list does not say up to date', async () => {
    wedge(WEDGED);
    const list = await cli(['apply-migrations', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    const doc = JSON.parse(list.stdout) as Record<string, any>;
    expect(doc.migrations.find((m: { version: string }) => m.version === WEDGED)).toMatchObject({ status: 'wedged' });
    expect(doc.wedged).toEqual([{ version: WEDGED, fix: { argv: ['gbrain', 'apply-migrations', '--force-retry', WEDGED],
      command: `gbrain apply-migrations --force-retry ${WEDGED}` } }]);
    const human = await cli(['apply-migrations', '--list']);
    expect(human.stdout).not.toContain('All migrations up to date');
    expect(human.stdout).toContain(`gbrain apply-migrations --force-retry ${WEDGED}`);
    expect(human.stdout).toContain(ledgerPath());
    expect(human.stdout).not.toContain('upgrade-errors.jsonl');
  }, 120_000);

  test('a wedge a newer migration ran past is history: the run succeeds and --list --json names no wedged fix', async () => {
    wedge(SUPERSEDED);
    expect(base.some(line => JSON.parse(line).version === '0.28.0' && JSON.parse(line).status === 'complete' && !JSON.parse(line).fresh_install)).toBe(true);
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).not.toHaveProperty('code');
    expect(run.stderr).toContain(`Migration v${SUPERSEDED} has 3+ consecutive partial runs, but v`);
    expect(run.stderr).not.toContain(`Migration v${SUPERSEDED} is WEDGED`);
    const doc = JSON.parse((await cli(['apply-migrations', '--list', '--json'])).stdout) as Record<string, any>;
    expect(doc.migrations.find((m: { version: string }) => m.version === SUPERSEDED)).toMatchObject({ status: 'wedged' });
    expect(doc).not.toHaveProperty('wedged');
  }, 120_000);
});
