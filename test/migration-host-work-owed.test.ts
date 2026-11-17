/**
 * A wedged migration whose latest row records apply_migrations_pending still owes host work (for v0.53.0, a conflict
 * in one or more sources). Where an operator looks (doctor, apply-migrations, post-upgrade, upgrade) it is reported with
 * the read-only per-source inspect and, where the surface can read the preview, each source in conflict with its code
 * and next step; nothing advises a forced retry. Ordinary commands follow apply-migrations: once a newer migration ran
 * past the wedge they print nothing about it. A named run of it still refuses, with the read-only inspect as its fix.
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
import { SHARED_SKILLS_HOST_WORK_VERSION } from '../src/core/shared-skills/migration-host-work.ts';
import { hostWorkOwedFix, hostWorkOwedMessage } from '../src/core/migration-ledger.ts';
import { minionsMigrationEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { codeEntry } from '../src/core/error-catalogue.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OWED = '0.53.0';
const INSPECT = ['gbrain', 'apply-migrations', '--migration', OWED, '--dry-run', '--json'];
const FORCE_RETRY = '--force-retry';
const owedRow = (n: number) => ({ ts: `2026-10-0${n}T00:00:00.000Z`, version: OWED, status: 'partial', apply_migrations_pending: true,
  phases: [{ name: 'content-checkpoints', status: 'complete', detail: 'Mechanical inventory is durable; publication and enrollment are NOT complete.' }] });
/** v0.11.0 records apply_migrations_pending on every partial run that left host TODOs: an ordinary wedge, never a source conflict. */
const LEGACY = '0.11.0';
const legacyRow = (n: number) => ({ ts: `2026-10-0${n}T00:00:00.000Z`, version: LEGACY, status: 'partial', apply_migrations_pending: true,
  phases: [{ name: 'record', status: 'complete', detail: 'status=partial (ledger write in runner)' }] });
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

/** The read-only inspect alone, with no ask: the surface could not read which sources are in conflict now. */
function expectInspectFix(fix: any): void {
  expect(fix).toMatchObject({ argv: INSPECT });
  expect(fix.ask_user).toBeUndefined();
  expect(fix.then).toBeUndefined();
  expect(JSON.stringify(fix)).not.toContain(FORCE_RETRY);
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
    expect(out).not.toContain(FORCE_RETRY);
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
    expect(run.stderr).toContain('its preview finds no source in conflict now, so nothing waits on a person');
    expect(run.stderr).not.toContain(FORCE_RETRY);
    expect(ledger()).toBe(before);
  }, 120_000);

  test('--yes still fails migrations_pending (exit 1) when nothing ran past it, with the inspect step as its fix', async () => {
    owe(false);
    const before = ledger();
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope).toMatchObject({ code: 'migrations_pending', reason: 'wedged' });
    expect(envelope.fix).toMatchObject({ next: 'run', argv: INSPECT });
    expect(envelope.fix.then).toBeUndefined();
    expect(run.stdout + run.stderr).not.toContain(FORCE_RETRY);
    expect(ledger()).toBe(before);
  }, 120_000);

  test('a superseded wedge of another migration that recorded host TODOs stays history, never owed host work', async () => {
    writeFileSync(ledgerPath(), [...base.filter(line => JSON.parse(line).version !== LEGACY), JSON.stringify({ version: '0.60.31', status: 'complete' }),
      ...[1, 2, 3].map(n => JSON.stringify(legacyRow(n)))].join('\n') + '\n');
    const list = await cli(['apply-migrations', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    const doc = JSON.parse(list.stdout);
    expect(doc.plan.wedged_superseded).toEqual([LEGACY]);
    expect(doc.plan.wedged_host_work).toEqual([]);
    expect(doc.wedged_host_work).toBeUndefined();
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

  test('a named run of it refuses with the read-only inspect as its fix, never a forced retry, and changes nothing', async () => {
    owe(true);
    const before = ledger();
    const run = await cli(['apply-migrations', '--migration', OWED, '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope).toMatchObject({ code: 'invalid_params' });
    expect(envelope.suggestion).toContain(INSPECT.join(' '));
    expectInspectFix(envelope.fix);
    expect(run.stdout + run.stderr).not.toContain(FORCE_RETRY);
    expect(ledger()).toBe(before);
  }, 120_000);
});

describe('the other surfaces say the same thing', () => {
  function ledgerHome(superseded: boolean, wedge: object[] = [1, 2, 3].map(owedRow)): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-host-work-owed-ledger-'));
    mkdirSync(join(dir, '.gbrain', 'migrations'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    const rows = [...wedge, { version: '0.60.31', status: 'complete', ...(superseded ? {} : { fresh_install: true }) }];
    writeFileSync(join(dir, '.gbrain', 'migrations', 'completed.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return dir;
  }
  const scoped = <T>(superseded: boolean, fn: () => Promise<T>, wedge?: object[]) => {
    const dir = ledgerHome(superseded, wedge);
    return withEnv({ HOME: dir, GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn)
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  };

  /** This ledger holds only the wedge and one newer run, so the other migrations still read as not run; the notice may name those, never the wedge. */
  const quietAboutWedge = (why: string) => {
    expect(why).not.toContain('wedged');
    expect(why).not.toContain('conflict');
    expect(why).not.toContain(FORCE_RETRY);
  };

  test('the connect and serve notice says nothing about it once a newer migration ran past it, as apply-migrations does', async () => {
    for (const command of ['serve', 'remember', 'recall', 'config']) {
      quietAboutWedge((await scoped(true, () => pendingUpgradeMigrationsNotice({ getConfig: async () => null } as never, command, VERSION)))?.why ?? '');
    }
  });

  test('with nothing past it the notice names the read-only inspect and asks nothing', async () => {
    const notice = await scoped(false, () => pendingUpgradeMigrationsNotice({ getConfig: async () => null } as never, 'serve', VERSION));
    expect(notice?.code).toBe('migrations_pending');
    expect(notice!.why).toContain(INSPECT.join(' '));
    expect(notice!.why).not.toContain(FORCE_RETRY);
    expectInspectFix(notice!.fix);
  });

  for (const superseded of [true, false]) {
    test(`doctor warns with the inspect step (${superseded ? 'a newer migration ran past it' : 'nothing ran past it'})`, async () => {
      const rows = await scoped(superseded, async () => (await buildChecks(null, ['--fast', '--json'], getDbUrlSource())).filter(c => c.name === 'minions_migration'));
      expect(rows.some(c => c.status === 'fail')).toBe(false);
      const row = rows.find(c => (c.details as any)?.code === 'migration_host_work_owed');
      expect(row?.status).toBe('warn');
      expect(row!.message).toContain(INSPECT.join(' '));
      expect(row!.message).not.toContain(FORCE_RETRY);
      expectInspectFix(row!.fix);
    });
  }

  test('the remote doctor reports it as a warning on the brain host', async () => {
    const rows = await scoped(true, async () => (await doctorReportRemote(engine, { remote: true })).checks.filter(c => c.name === 'minions_migration'));
    expect(rows.some(c => c.status === 'fail')).toBe(false);
    const row = rows.find(c => (c.details as any)?.code === 'migration_host_work_owed');
    expect(row?.status).toBe('warn');
    expect(row!.message).toContain(INSPECT.join(' '));
    expect(row!.message).not.toContain(FORCE_RETRY);
  }, 120_000);

  test('a superseded wedge of another migration that recorded host TODOs is not reported as owed host work', async () => {
    expect(SHARED_SKILLS_HOST_WORK_VERSION).toBe(OWED);
    const legacy = [1, 2, 3].map(legacyRow);
    const rows = await scoped(true, async () => (await buildChecks(null, ['--fast', '--json'], getDbUrlSource())).filter(c => c.name === 'minions_migration'), legacy);
    expect(rows.some(c => (c.details as any)?.code === 'migration_host_work_owed')).toBe(false);
    const remote = await scoped(true, async () => (await doctorReportRemote(engine, { remote: true })).checks.filter(c => c.name === 'minions_migration'), legacy);
    expect(remote.some(c => (c.details as any)?.code === 'migration_host_work_owed')).toBe(false);
    quietAboutWedge((await scoped(true, () => pendingUpgradeMigrationsNotice({ getConfig: async () => null } as never, 'serve', VERSION), legacy))?.why ?? '');
    const line = await scoped(true, () => describeMigrationFailure(new Error('exit 1'), VERSION), legacy);
    expect(line).not.toContain(`--migration ${LEGACY}`);
  }, 120_000);

  test('the doctor code has a registry row: gbrain errors explains it, its default fix is read-only and it never advises a forced retry', async () => {
    const entry = codeEntry('migration_host_work_owed');
    expect(entry?.class).toBe('host_only');
    expect(entry?.retryable).toBe(false);
    expect(entry!.fix!.argv).toEqual(['gbrain', 'apply-migrations', '--list', '--json']);
    expect(entry!.suggestion).toContain('--dry-run --json');
    expect(entry!.suggestion).toContain('shared_skills_unmanifested');
    expect(JSON.stringify(entry)).not.toContain(FORCE_RETRY);
    const out = await cli(['errors', 'migration_host_work_owed']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('migration_host_work_owed (host_only');
    expect(out.stdout).not.toContain(FORCE_RETRY);
  }, 120_000);

  test('upgrade\'s failure line names the inspect step and no forced retry', async () => {
    const line = await scoped(true, () => describeMigrationFailure(new Error('exit 1'), VERSION));
    expect(line).toContain(INSPECT.join(' '));
    expect(line).not.toContain(FORCE_RETRY);
  });
});

describe('the box ledger shape: three old partial rows for v0.53.0 and a newer migration completed', () => {
  const ordinary = [
    ['config', 'get', 'search.mode'],
    ['remember', 'Alice Example likes zebracorn tea', '--entity', 'people/alice-example', '--content-origin', 'user_said', '--provenance', 'test'],
    ['recall', 'zebracorn', '--json'],
  ];
  async function expectQuiet(): Promise<void> {
    for (const args of ordinary) {
      const run = await cli(args);
      expect({ args, exitCode: run.exitCode }).toEqual({ args, exitCode: 0 });
      expect(run.stderr).not.toContain('migrations_pending');
      expect(run.stderr).not.toContain(FORCE_RETRY);
    }
  }

  test('remember, recall and config get print nothing about it, with and without a database-only source', async () => {
    owe(true);
    await expectQuiet();
    expect((await cli(['transcripts', 'archive', 'on', '--json'])).exitCode).toBe(0);
    expect((await cli(['transcripts', 'archive', 'run', '--json'])).exitCode).toBe(0);
    const sources = JSON.parse((await cli(['sources', 'list', '--json'])).stdout);
    const rows: any[] = Array.isArray(sources) ? sources : sources.sources;
    expect(rows.find(row => row.id === 'conversations')?.local_path ?? null).toBeNull();
    expect(rows.some(row => row.id === 'conversations')).toBe(true);
    owe(true);
    await expectQuiet();
  }, 240_000);

  test('every command the advice names runs and exits 0', async () => {
    owe(true);
    for (const args of [INSPECT.slice(1), ['apply-migrations', '--dry-run', '--json'], ['sources', 'shared-skills', 'default', 'off'], ['sources', 'shared-skills', 'default', 'on']]) {
      const run = await cli(args);
      expect({ args, exitCode: run.exitCode }).toEqual({ args, exitCode: 0 });
    }
  }, 240_000);

  test('with a source in conflict, --dry-run and --yes name it with its code, never a forced retry, and ordinary commands stay quiet', async () => {
    const pack = join(home, 'source-b');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'skillpack.json'), '[]');
    writeFileSync(join(pack, 'note.md'), '# Note\n');
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']]) {
      expect(Bun.spawnSync(['git', ...args], { cwd: pack }).exitCode).toBe(0);
    }
    expect((await cli(['sources', 'add', 'source-b', '--path', pack])).exitCode).toBe(0);
    try {
      owe(true);
      const dry = await cli(['apply-migrations', '--dry-run', '--json']);
      expect(dry.exitCode).toBe(0);
      expect(dry.stderr).toContain('source-b (local_conflict)');
      expect(dry.stderr).not.toContain(FORCE_RETRY);
      const before = ledger();
      const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install']);
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toContain('source-b (local_conflict)');
      expect(run.stdout + run.stderr).not.toContain(FORCE_RETRY);
      expect(ledger()).toBe(before);
      const post = await cli(['post-upgrade', '--no-autopilot-install']);
      expect(post.exitCode).toBe(0);
      expect(post.stdout + post.stderr).toContain('source-b (local_conflict)');
      expect(post.stdout + post.stderr).not.toContain(FORCE_RETRY);
      const quiet = await cli(['config', 'get', 'search.mode']);
      expect(quiet.stderr).not.toContain('migrations_pending');
    } finally {
      await cli(['sources', 'remove', 'source-b', '--confirm-destructive']);
    }
  }, 240_000);
});

describe('doctor, connected, reads which sources are in conflict now', () => {
  let live: PGLiteEngine;
  let pack: string;
  beforeAll(async () => {
    live = new PGLiteEngine();
    await live.connect({});
    await live.initSchema();
    pack = mkdtempSync(join(tmpdir(), 'gbrain-host-work-owed-pack-'));
    writeFileSync(join(pack, 'skillpack.json'), '[]');
  }, 120_000);
  afterAll(async () => {
    await live?.disconnect();
    rmSync(pack, { recursive: true, force: true });
  });

  async function owedChecks(): Promise<Check[]> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-host-work-owed-doctor-'));
    try {
      mkdirSync(join(dir, '.gbrain', 'migrations'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
      const rows = [...[1, 2, 3].map(owedRow), { version: '0.60.31', status: 'complete' }];
      writeFileSync(join(dir, '.gbrain', 'migrations', 'completed.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const ctx = { engine: live, progress: { heartbeat() {}, finish() {} }, args: [] } as unknown as DoctorContext;
      return await withEnv({ HOME: dir, GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => (await minionsMigrationEntry.run(ctx) as Check[]).filter(c => (c.details as any)?.code === 'migration_host_work_owed'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test('names each source in conflict with its code and the user\'s decision, never a forced retry; quiet once none is left', async () => {
    await live.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', ['source-b', realpathSync(pack)]);
    const [row] = await owedChecks();
    expect(row?.status).toBe('warn');
    expect(row!.message).toContain('source-b (local_conflict)');
    expect(row!.message).toContain(INSPECT.join(' '));
    expect(row!.message).not.toContain(FORCE_RETRY);
    expect((row!.details as any).conflicts).toEqual([expect.objectContaining({ source_id: 'source-b', code: 'local_conflict' })]);
    expect(row!.fix).toMatchObject({ argv: INSPECT, then: { ask_user: true } });
    expect(row!.fix!.then!.user_message).toContain('source-b');
    expect(JSON.stringify(row!.fix)).not.toContain(FORCE_RETRY);
    await live.executeRaw("DELETE FROM sources WHERE id = 'source-b'");
    expect(await owedChecks()).toEqual([]);
  }, 120_000);

  test('a source whose policy read fails is not inspected, so doctor keeps the warning with the inspect step', async () => {
    await live.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', ['source-b', realpathSync(pack)]);
    const executeRaw = live.executeRaw.bind(live);
    live.executeRaw = (async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT config FROM sources WHERE id=$1')) throw new Error('Connection terminated unexpectedly');
      return executeRaw(sql, params as any);
    }) as typeof live.executeRaw;
    try {
      const [row] = await owedChecks();
      expect(row?.status).toBe('warn');
      expect(row!.message).toContain(INSPECT.join(' '));
      expect(row!.message).not.toContain('nothing waits on a person');
      expect((row!.details as any).conflicts).toBeUndefined();
      expectInspectFix(row!.fix);
    } finally {
      live.executeRaw = executeRaw;
      await live.executeRaw("DELETE FROM sources WHERE id = 'source-b'");
    }
  }, 120_000);
});

describe('the advice for each conflict code', () => {
  test('skills nobody declared: declare them, or take the source out with sources shared-skills <id> off', () => {
    const conflicts = [{ source_id: 'source-a', code: 'shared_skills_unmanifested', reason: 'Unmanifested source-local skills require reviewed adoption; no files or private markers were replaced.' }];
    const message = hostWorkOwedMessage([OWED], conflicts);
    expect(message).toContain('source-a (shared_skills_unmanifested)');
    expect(message).toContain('skillpack.json');
    expect(message).toContain('gbrain sources shared-skills source-a off');
    expect(message).not.toContain(FORCE_RETRY);
    const fix = hostWorkOwedFix([OWED], conflicts);
    expect(fix).toMatchObject({ argv: INSPECT, then: { ask_user: true, argv: ['gbrain', 'sources', 'shared-skills', 'source-a', 'off'] } });
    expect(JSON.stringify(fix)).not.toContain(FORCE_RETRY);
  });
});
