/**
 * A wedged migration whose latest row records apply_migrations_pending still owes host work (for v0.53.0, a conflict
 * in one or more sources). A newer migration completing after it does not make it history, and nothing clears it
 * without a person. Every surface says so with the same read-only next step (the per-source inspect), offers the
 * forced retry only after the conflict is resolved, and leaves the migration and every exit status as they were.
 *
 * One throwaway PGLite brain drives the CLI (HOME / GBRAIN_HOME per subprocess; process.env is never mutated); the
 * notice, both doctors and the upgrade message run in-process against a ledger-only home.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withEnv } from './helpers/with-env.ts';
import { pendingUpgradeMigrationsNotice } from '../src/cli/migrations-notice.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { doctorReportRemote } from '../src/commands/doctor/report-remote.ts';
import { describeMigrationFailure } from '../src/commands/upgrade.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getDbUrlSource } from '../src/core/config.ts';
import { VERSION } from '../src/version.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OWED = '0.53.0';
const INSPECT = ['gbrain', 'apply-migrations', '--migration', OWED, '--dry-run', '--json'];
const RETRY = ['gbrain', 'apply-migrations', '--force-retry', OWED];
const owedRow = (n: number) => ({ ts: `2026-10-0${n}T00:00:00.000Z`, version: OWED, status: 'partial', apply_migrations_pending: true,
  phases: [{ name: 'content-checkpoints', status: 'complete', detail: 'Mechanical inventory is durable; publication and enrollment are NOT complete.' }] });
let home: string;
let base: string[];
let engine: PGLiteEngine;

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO, env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

const ledgerPath = () => join(home, '.gbrain', 'migrations', 'completed.jsonl');
const ledger = () => readFileSync(ledgerPath(), 'utf8');
/**
 * The fresh brain's ledger with v0.53.0 replaced by three partial runs that recorded host work. With
 * `superseded`, a real v0.60.31 run is forward progress past it; without, every v0.60.31 row is an init fresh-install
 * stamp, which is not forward progress, so nothing has run past the wedge.
 */
function owe(superseded: boolean): void {
  const kept = base.filter(line => JSON.parse(line).version !== OWED).map(line => {
    const row = JSON.parse(line);
    return !superseded && row.version === '0.60.31' ? JSON.stringify({ ...row, fresh_install: true }) : line;
  });
  const ran = superseded ? [JSON.stringify({ version: '0.60.31', status: 'complete' })] : [];
  writeFileSync(ledgerPath(), [...kept, ...ran, ...[1, 2, 3].map(n => JSON.stringify(owedRow(n)))].join('\n') + '\n');
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-host-work-owed-')));
  expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  expect((await cli(['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
  base = ledger().split('\n').filter(line => line.trim());
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  expect(base.some(line => JSON.parse(line).version === '0.60.31' && JSON.parse(line).status === 'complete')).toBe(true);
}, 240_000);

afterAll(async () => {
  await engine?.disconnect();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The read-only inspect first, then the ask: rendered (`next`) on the wire, stored (`ask_user`) on an in-process doctor check. */
function expectOwedFix(fix: any): void {
  if ('next' in fix) expect(fix).toMatchObject({ next: 'run', argv: INSPECT, then: { next: 'ask_user', argv: RETRY } });
  else {
    expect(fix).toMatchObject({ argv: INSPECT, then: { ask_user: true, argv: RETRY } });
    expect(fix.ask_user).toBeUndefined();
  }
  expect(fix.then.user_message).toContain('conflict');
  expect(fix.then.user_message).toContain('will not clear by itself');
}

describe('apply-migrations with a wedged migration that still owes host work', () => {
  test('--list never calls it history, names the inspect step first and does not say up to date', async () => {
    owe(true);
    const list = await cli(['apply-migrations', '--list']);
    expect(list.exitCode).toBe(0);
    const out = list.stdout + list.stderr;
    expect(out).not.toContain('history, not outstanding work');
    expect(out).not.toContain('All migrations up to date');
    expect(out).toMatch(new RegExp(`wedged\\s+${OWED.replace(/\./g, '\\.')}`));
    expect(out).toContain(INSPECT.join(' '));
    expect(out.indexOf(INSPECT.join(' '))).toBeLessThan(out.indexOf(RETRY.join(' ')));
    expect(out).toContain('does not clear without a person');
  }, 120_000);

  test('--list --json lists it with the read-only inspect as its fix, never as superseded', async () => {
    owe(true);
    const list = await cli(['apply-migrations', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    const doc = JSON.parse(list.stdout);
    expect(doc.plan.wedged_superseded).not.toContain(OWED);
    expect(doc.plan.wedged_host_work).toEqual([OWED]);
    expect(doc.wedged_host_work).toEqual([{ version: OWED, fix: { argv: INSPECT, command: INSPECT.join(' ') } }]);
    expect(doc.migrations.find((m: any) => m.version === OWED).status).toBe('wedged');
  }, 120_000);

  test('the inspect step it names runs on the wedged version and changes nothing', async () => {
    owe(true);
    const before = ledger();
    const inspect = await cli(INSPECT.slice(1));
    expect(inspect.exitCode).toBe(0);
    expect(JSON.parse(inspect.stdout).previews.map((p: any) => p.version)).toEqual([OWED]);
    expect(ledger()).toBe(before);
  }, 120_000);

  test('--yes leaves it untouched and still exits 0 when a newer migration ran past it', async () => {
    owe(true);
    const before = ledger();
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(0);
    const doc = JSON.parse(run.stdout);
    expect(doc.status).toBe('up_to_date');
    expect(doc.wedged_host_work).toEqual([OWED]);
    expect(run.stderr).toContain(INSPECT.join(' '));
    expect(ledger()).toBe(before);
  }, 120_000);

  test('--yes still fails migrations_pending (exit 1) when nothing ran past it, with the inspect step as its fix', async () => {
    owe(false);
    const before = ledger();
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope).toMatchObject({ code: 'migrations_pending', reason: 'wedged' });
    expectOwedFix(envelope.fix);
    expect(ledger()).toBe(before);
  }, 120_000);

  test('post-upgrade leaves it untouched and keeps its exit status', async () => {
    owe(true);
    const before = ledger();
    expect((await cli(['post-upgrade', '--no-autopilot-install'])).exitCode).toBe(0);
    expect(ledger()).toBe(before);
    owe(false);
    const stuck = ledger();
    expect((await cli(['post-upgrade', '--no-autopilot-install'])).exitCode).toBe(1);
    expect(ledger()).toBe(stuck);
  }, 240_000);
});

describe('the other surfaces say the same thing', () => {
  function ledgerHome(superseded: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-host-work-owed-ledger-'));
    mkdirSync(join(dir, '.gbrain', 'migrations'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    const rows = [...[1, 2, 3].map(owedRow), { version: '0.60.31', status: 'complete', ...(superseded ? {} : { fresh_install: true }) }];
    writeFileSync(join(dir, '.gbrain', 'migrations', 'completed.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return dir;
  }
  const scoped = <T>(superseded: boolean, fn: () => Promise<T>) => {
    const dir = ledgerHome(superseded);
    return withEnv({ HOME: dir, GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn)
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  };

  test('the connect and serve notice leads with the inspect step, not the forced retry', async () => {
    const notice = await scoped(true, () => pendingUpgradeMigrationsNotice({ getConfig: async () => null } as never, 'serve', VERSION));
    expect(notice?.code).toBe('migrations_pending');
    expect(notice!.fix).toMatchObject({ argv: INSPECT, then: { ask_user: true, argv: RETRY } });
    expect(notice!.fix!.ask_user).toBeUndefined();
    expect(notice!.why).toContain('does not clear without a person');
  });

  for (const superseded of [true, false]) {
    test(`doctor warns with the inspect step (${superseded ? 'a newer migration ran past it' : 'nothing ran past it'})`, async () => {
      const rows = await scoped(superseded, async () => (await buildChecks(null, ['--fast', '--json'], getDbUrlSource())).filter(c => c.name === 'minions_migration'));
      expect(rows.some(c => c.status === 'fail')).toBe(false);
      const row = rows.find(c => (c.details as any)?.code === 'migration_host_work_owed');
      expect(row?.status).toBe('warn');
      expect(row!.message).toContain(INSPECT.join(' '));
      expectOwedFix(row!.fix);
    });
  }

  test('the remote doctor reports it as a warning on the brain host', async () => {
    const rows = await scoped(true, async () => (await doctorReportRemote(engine, { remote: true })).checks.filter(c => c.name === 'minions_migration'));
    expect(rows.some(c => c.status === 'fail')).toBe(false);
    const row = rows.find(c => (c.details as any)?.code === 'migration_host_work_owed');
    expect(row?.status).toBe('warn');
    expect(row!.message).toContain(INSPECT.join(' '));
  }, 120_000);

  test('upgrade\'s failure line names the inspect step, never a forced retry first', async () => {
    const line = await scoped(true, () => describeMigrationFailure(new Error('exit 1'), VERSION));
    expect(line).toContain(INSPECT.join(' '));
    expect(line.indexOf(INSPECT.join(' '))).toBeLessThan(line.indexOf(RETRY.join(' ')));
  });
});
