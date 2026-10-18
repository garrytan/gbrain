/**
 * #6803 C5 (Decision 1): the non-interactive default budget of CLI `gbrain doctor --json›.
 *
 * - Applies only to plain CLI `--json› with stderr not a terminal; `--budget-ms›, `--tier›, `--fix›,
 *   `--remediate› and `--remediation-plan› keep their own behavior.
 * - It starts with the check run (connect and migrations are not counted), and its stderr line prints then.
 * - `gbrain config set doctor.default_budget_ms 0› (file plane), read back through the pre-connect reader,
 *   turns it off; `--budget-ms 0› turns it off for one run; `--tier ops› keeps its 4000 ms deadline.
 * - `doctor.entry_budget_ms› and `doctor.orphan_ratio.full_scan_max_pages› are accepted on the DB plane.
 * - Only the CLI doctor command applies it (MCP run_doctor and the remote paths never import it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DEFAULT_BUDGET_MS, nonInteractiveDefaultBudget, readDefaultBudgetMs } from '../src/commands/doctor/default-budget.ts';
import { doctorRunSummary, parseBudgetMs, startDeferredDeadline, startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import { KNOWN_CONFIG_KEYS, loadConfigFileOnly } from '../src/core/config.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const NOTICE = '[gbrain doctor] non-interactive run';

describe('nonInteractiveDefaultBudget', () => {
  test('only plain --json with a non-terminal stderr gets the default', () => {
    expect(nonInteractiveDefaultBudget(['--json'], { stderrIsTty: false, configuredMs: DEFAULT_BUDGET_MS })).toBe(90_000);
    expect(nonInteractiveDefaultBudget(['--json', '--scope=brain', '--only', 'orphan_ratio'], { stderrIsTty: false, configuredMs: 5_000 })).toBe(5_000);
    expect(nonInteractiveDefaultBudget(['--json'], { stderrIsTty: true, configuredMs: DEFAULT_BUDGET_MS })).toBeNull();
    expect(nonInteractiveDefaultBudget([], { stderrIsTty: false, configuredMs: DEFAULT_BUDGET_MS })).toBeNull();
    for (const explicit of [['--budget-ms', '0'], ['--budget-ms=5000'], ['--tier', 'ops'], ['--tier=deep'], ['--fix'], ['--remediate'], ['--remediation-plan']]) {
      expect(nonInteractiveDefaultBudget(['--json', ...explicit], { stderrIsTty: false, configuredMs: DEFAULT_BUDGET_MS })).toBeNull();
    }
    expect(nonInteractiveDefaultBudget(['--json'], { stderrIsTty: false, configuredMs: 0 })).toBeNull();
  });

  test('the default starts with the check run, not before the connect', () => {
    const connectAt = 1_000;
    const checksAt = 60_000;
    const deadline = startDoctorDeadline(['--json'], connectAt);
    deadline.deferredBudgetMs = 5_000;
    expect(deadline.deadlineAt).toBeNull();
    expect(doctorRunSummary(['--json'], deadline)).toBeUndefined();
    startDeferredDeadline(deadline, checksAt);
    expect(deadline).toMatchObject({ startedAt: 60_000, budgetMs: 5_000, deadlineAt: 65_000, nonInteractiveDefault: true });
    expect(doctorRunSummary(['--json'], deadline)).toMatchObject({ tier: 'standard', budgetMs: 5_000 });
  });

  test('--budget-ms 0 is no overall budget for one run; a negative value is refused', () => {
    expect(parseBudgetMs(['--budget-ms', '0'], 'standard')).toBeNull();
    expect(startDoctorDeadline(['--budget-ms', '0'])).toMatchObject({ deadlineAt: null, explicit: true });
    expect(() => parseBudgetMs(['--budget-ms', '-5'], 'standard')).toThrow(/whole number of milliseconds/);
  });

  test('the doctor budget keys are known config keys', () => {
    for (const key of ['doctor.default_budget_ms', 'doctor.entry_budget_ms', 'doctor.orphan_ratio.full_scan_max_pages']) expect(KNOWN_CONFIG_KEYS).toContain(key);
  });

  test('only the CLI doctor command applies the default (MCP run_doctor and remote paths never import it)', () => {
    const root = join(import.meta.dir, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(root);
    const importers = files.filter((f) => /default-budget(\.ts)?['"]/.test(readFileSync(f, 'utf-8'))).map((f) => relative(root, f)).sort();
    expect(importers).toEqual(['cli/commands/doctor.ts', 'commands/config.ts']);
  });
});

describe('CLI doctor --json on PGLite (non-terminal stderr)', () => {
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-6803-default-budget-'));
    const init = await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { home, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
  }, 150_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const doctor = async (extra: string[]) => {
    const run = await runCli(['doctor', '--json', '--scope=brain', ...extra], { home, timeoutMs: 120_000 });
    return { run, report: JSON.parse(run.stdout) as Record<string, unknown> };
  };

  test('a plain run is capped at 90000 ms and says so once on stderr', async () => {
    const { run, report } = await doctor([]);
    expect(run.stderr.split(NOTICE).length - 1).toBe(1);
    expect(run.stderr).toContain('90000 ms (doctor.default_budget_ms)');
    expect(run.stderr).toContain('--budget-ms 0');
    expect(report).toMatchObject({ tier: 'standard', budget_ms: 90_000 });
    expect(typeof report.complete).toBe('boolean');
  }, 150_000);

  test('--budget-ms 0 turns it off for one run; --tier ops keeps its 4000 ms deadline', async () => {
    const off = await doctor(['--budget-ms', '0']);
    expect(off.run.stderr).not.toContain(NOTICE);
    expect(off.report.budget_ms).toBeNull();
    const ops = await doctor(['--tier', 'ops']);
    expect(ops.run.stderr).not.toContain(NOTICE);
    expect(ops.report).toMatchObject({ tier: 'ops', budget_ms: 4_000 });
  }, 150_000);

  test('config set doctor.default_budget_ms 0 (file plane) turns it off, read back before connecting; unset restores it', async () => {
    const bad = await runCli(['config', 'set', 'doctor.default_budget_ms', '1.5'], { home });
    expect(bad.exitCode).not.toBe(0);
    const set = await runCli(['config', 'set', 'doctor.default_budget_ms', '0'], { home });
    expect(set.exitCode, set.stderr).toBe(0);
    await withEnv({ GBRAIN_HOME: home }, async () => { expect(readDefaultBudgetMs(loadConfigFileOnly())).toBe(0); });
    const { run, report } = await doctor([]);
    expect(run.stderr).not.toContain(NOTICE);
    expect(report.budget_ms).toBeUndefined();
    const unset = await runCli(['config', 'unset', 'doctor.default_budget_ms'], { home });
    expect(unset.exitCode, unset.stderr).toBe(0);
    await withEnv({ GBRAIN_HOME: home }, async () => { expect(readDefaultBudgetMs(loadConfigFileOnly())).toBe(DEFAULT_BUDGET_MS); });
    const entry = await runCli(['config', 'set', 'doctor.entry_budget_ms', '20000'], { home });
    expect(entry.exitCode, entry.stderr).toBe(0);
  }, 200_000);
});
