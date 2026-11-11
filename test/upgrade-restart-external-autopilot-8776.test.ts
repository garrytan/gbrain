/**
 * #8776: `gbrain upgrade` refused on every host where autopilot runs outside launchd and systemd, gbrain's own
 * linux-cron install target included, so the stable auto-upgrade path could never finish there. An autopilot whose
 * launcher starts it again when it exits (this brain's gbrain cron line, or one the operator declares with
 * `self_upgrade.autopilot_launcher external`) is now handed to that launcher: stopped only while the pid is still that
 * autopilot, then verified back on the installed build. Without a launcher the upgrade still refuses, naming
 * `gbrain autopilot --install`, and doctor's `self_upgrade_health` warns before the upgrade fails.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { planRestart, restartProblems, runRestartSteps, verifyRestart, PENDING_BUILD, type AutopilotLauncher, type HostProcess, type RestartContext, type RestartExecutor } from '../src/core/upgrade-restart.ts';
import { autopilotLauncher, launcherFor, restartRefusal } from '../src/commands/upgrade-restart.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor/checks/upgrade-health.ts';
import { resolveAutopilotJob } from '../src/core/autopilot-paths.ts';
import { parseSelfUpgradeConfigValue, SELF_UPGRADE_CONFIG_LEAVES } from '../src/core/self-upgrade.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { logSelfUpgrade } from '../src/core/audit/self-upgrade-audit.ts';

const NEW = '0.60.400.0';
const OLD = '0.60.390.0';
const CRON: AutopilotLauncher = { kind: 'cron', wait_ms: 360_000, pid: 30 };
const DECLARED: AutopilotLauncher = { kind: 'declared', wait_ms: 360_000, pid: 30 };
const ctx = (over: Partial<RestartContext> = {}): RestartContext => ({ expected: NEW, serveService: null, autopilotService: null, stopMcp: false, ...over });
/** An autopilot cron started through a wrapper shell: no installed service is among its ancestors. */
const autopilot = (pid = 30, version: string | null = OLD, over: Partial<HostProcess> = {}): HostProcess =>
  ({ pid, ppid: null, role: 'autopilot', version, started_ms: 1_000, ancestors: [7, 6], args: ['autopilot', '--repo', '/srv/brain-example'], ...over });

describe('planRestart: an autopilot started outside gbrain\'s service', () => {
  test('without a known launcher the upgrade refuses and names gbrain autopilot --install and the declared hand-off', () => {
    const plan = planRestart([autopilot()], ctx({ expected: PENDING_BUILD }));
    expect(plan.steps).toEqual([]);
    expect(plan.manual.map(m => [m.role, m.pid, m.argv])).toEqual([['autopilot', 30, ['gbrain', 'autopilot', '--install']]]);
    expect(plan.manual[0]!.instruction).toContain('started outside gbrain\'s autopilot service');
    expect(plan.manual[0]!.instruction).toContain('gbrain config set self_upgrade.autopilot_launcher external');
    const refusal = restartRefusal(plan, ['gbrain', 'upgrade'], false)!;
    expect(refusal.code).toBe('restart_refused');
    expect(refusal.fix).toMatchObject({ actor: 'user', argv: ['gbrain', 'autopilot', '--install'] });
  });

  test('with this brain\'s gbrain cron line, or a declared launcher, the upgrade hands autopilot over instead of refusing', () => {
    for (const launcher of [CRON, DECLARED]) {
      const plan = planRestart([autopilot()], ctx({ expected: PENDING_BUILD, autopilotLauncher: launcher }));
      expect(plan.manual).toEqual([]);
      expect(restartRefusal(plan, ['gbrain', 'upgrade'], false)).toBeNull();
      expect(plan.steps).toEqual([{ kind: 'handoff', role: 'autopilot', pid: 30, started_ms: 1_000, launcher }]);
    }
  });

  test('an installed service still wins; a worker of a handed-off autopilot goes with it; a current autopilot is left alone', () => {
    const underService = planRestart([autopilot(30, OLD, { ancestors: [29] })], ctx({ autopilotService: { argv: ['systemctl', '--user', 'restart', 'gbrain-autopilot.service'], pid: 29 }, autopilotLauncher: CRON }));
    expect(underService.steps).toMatchObject([{ kind: 'service', role: 'autopilot', pids: [30] }]);
    const worker: HostProcess = { pid: 31, ppid: 30, role: 'worker', version: OLD, started_ms: 1_000, ancestors: [30, 7], args: ['jobs', 'work'] };
    const withWorker = planRestart([autopilot(30, NEW), worker], ctx({ autopilotLauncher: CRON }));
    expect(withWorker.manual).toEqual([]);
    expect(withWorker.steps).toEqual([{ kind: 'handoff', role: 'autopilot', pid: 30, started_ms: 1_000, launcher: CRON }]);
    expect(planRestart([autopilot(30, NEW)], ctx({ autopilotLauncher: CRON })).steps).toEqual([]);
  });

  test('only the daemon this brain\'s autopilot lock names is handed over; any other autopilot still refuses', () => {
    const plan = planRestart([autopilot(30), autopilot(31)], ctx({ autopilotLauncher: CRON }));
    expect(plan.steps).toEqual([{ kind: 'handoff', role: 'autopilot', pid: 30, started_ms: 1_000, launcher: CRON }]);
    expect(plan.manual.map(m => m.pid)).toEqual([31]);
    expect(planRestart([autopilot(30)], ctx({ autopilotLauncher: { ...CRON, pid: null } })).manual.map(m => m.pid)).toEqual([30]);
  });

  test('with a launcher known but a lock that names another pid or none, the refusal says so instead of asking for the launcher again', async () => {
    for (const launcher of [{ ...DECLARED, pid: null }, { ...DECLARED, pid: 31 }, { ...CRON, pid: null }]) {
      const plan = planRestart([autopilot(30)], ctx({ expected: PENDING_BUILD, autopilotLauncher: launcher }));
      expect(plan.steps).toEqual([]);
      expect(plan.manual.map(m => [m.role, m.pid, m.argv])).toEqual([['autopilot', 30, ['kill', '30']]]);
      expect(plan.manual[0]!.instruction).toContain(launcher.pid ? 'names pid 31' : 'names no running autopilot');
      expect(plan.manual[0]!.instruction).not.toContain('gbrain config set self_upgrade.autopilot_launcher external');
    }
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'auto' }, () => {
      const check = checkSelfUpgradeHealth(planRestart([autopilot(30)], ctx({ expected: PENDING_BUILD, autopilotLauncher: { ...DECLARED, pid: null } })));
      expect(check.status).toBe('warn');
      expect(check.fix).not.toMatchObject({ ask_user: true });
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'upgrade', '--restart-only', '--dry-run', '--json'] });
    });
  });

  test('an autopilot from another install that is not a Bun global copy still refuses: the hand-off never moves a clone', () => {
    const plan = planRestart([autopilot(30, OLD, { install_root: '/srv/gbrain-checkout', install_version: OLD })], ctx({ ownInstallRoot: '/opt/gbrain', autopilotLauncher: CRON }));
    expect(plan.steps).toEqual([]);
    expect(plan.manual[0]!.instruction).toContain('runs from another gbrain install');
  });
});

describe('runRestartSteps and verifyRestart: the hand-off', () => {
  const plan = planRestart([autopilot()], ctx({ autopilotLauncher: CRON }));
  const exec = (terminate: RestartExecutor['terminate']): RestartExecutor => ({ run: () => ({ status: 0, output: '' }), terminate, supervisorPid: () => null, sleep: async () => {} });

  test('signals the autopilot only while the pid is still that autopilot', async () => {
    const seen: Array<[number, number | null, string]> = [];
    const ok = await runRestartSteps(plan, exec((pid, started, role) => { seen.push([pid, started, role]); return 'stopped'; }));
    expect(seen).toEqual([[30, 1_000, 'autopilot']]);
    expect(ok[0]).toMatchObject({ ok: true });
    expect(ok[0]!.detail).toContain('this brain\'s gbrain cron line starts it again');
    const changed = await runRestartSteps(plan, exec(() => 'changed'));
    expect(changed[0]).toMatchObject({ ok: false });
    expect(changed[0]!.detail).toContain('no longer the autopilot the plan saw');
  });

  test('done once the launcher starts autopilot on the build; until then it names the launcher', async () => {
    const back = autopilot(130, NEW, { started_ms: 9_000 });
    expect(restartProblems(plan, [back], 5_000, { before: { state: 'absent' }, after: { state: 'absent' } }, 130)).toEqual([]);
    expect(restartProblems(plan, [], 5_000, { before: { state: 'absent' }, after: { state: 'absent' } }, null))
      .toEqual(['autopilot did not come back after it was stopped for this brain\'s gbrain cron line to start again (this brain\'s autopilot lock names no autopilot).']);
    let clock = 0;
    let round = 0;
    const verified = await verifyRestart(plan, 5_000, { state: 'absent' }, {
      collect: async () => (round++ < 3 ? [] : [back]), probeWarmSocket: async () => ({ state: 'absent' }), sleep: async ms => { clock += ms; }, now: () => clock,
      autopilotLockPid: () => (round > 3 ? 130 : null),
    }, { timeoutMs: CRON.wait_ms, pollMs: 2_000 });
    expect(verified.ok).toBe(true);
    expect(clock).toBe(6_000);
  });
});

describe('verifyRestart: the hand-off is done only when this brain\'s autopilot lock names a fresh autopilot', () => {
  const plan = planRestart([autopilot()], ctx({ autopilotLauncher: CRON }));
  const absent = { state: 'absent' } as const;
  const verify = (processes: HostProcess[], lockPid: () => number | null) => verifyRestart(plan, 5_000, absent,
    { collect: async () => processes, probeWarmSocket: async () => absent, sleep: async () => {}, now: () => 0, autopilotLockPid: lockPid }, { timeoutMs: 0, pollMs: 2_000 });

  test('two brains: only brain B\'s new autopilot alive after this brain\'s was handed off does not verify', async () => {
    const brainB = autopilot(130, NEW, { started_ms: 9_000, args: ['autopilot', '--repo', '/srv/brain-b'] });
    const result = await verify([brainB], () => 30);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['autopilot did not come back after it was stopped for this brain\'s gbrain cron line to start again (this brain\'s autopilot lock names pid 30, which is not an autopilot started after the restart).']);
  });

  test('a lock missing or unreadable at verify time reports that autopilot did not come back, naming the lock, and never verifies', async () => {
    const fresh = autopilot(130, NEW, { started_ms: 9_000 });
    for (const lockPid of [() => null, () => { throw new Error('EACCES'); }]) {
      const result = await verify([fresh], lockPid);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual(['autopilot did not come back after it was stopped for this brain\'s gbrain cron line to start again (this brain\'s autopilot lock names no autopilot).']);
    }
  });

  test('single brain: the launcher\'s new autopilot holding this brain\'s lock verifies', async () => {
    const result = await verify([autopilot(130, NEW, { started_ms: 9_000 })], () => 130);
    expect(result).toMatchObject({ ok: true, problems: [] });
  });
});

describe('planRestart: an autopilot known only from its heartbeat row', () => {
  test('is not handed off, since the upgrade cannot confirm the process to stop, and names kill <pid>', () => {
    const plan = planRestart([autopilot(30, OLD, { started_ms: null, args: undefined, ancestors: undefined })], ctx({ expected: PENDING_BUILD, autopilotLauncher: CRON }));
    expect(plan.steps).toEqual([]);
    expect(plan.manual.map(m => [m.role, m.pid, m.argv])).toEqual([['autopilot', 30, ['kill', '30']]]);
    expect(plan.manual[0]!.instruction).toContain('known only from its heartbeat row');
  });
});

describe('autopilotLauncher', () => {
  test('this brain\'s gbrain cron line is a launcher; a commented line, a monitor-only line, a line that does not start its wrapper every 5 minutes or none is not; the declared key is the fallback', () => {
    const job = resolveAutopilotJob();
    const line = `*/5 * * * * '${join(job.homeDir, 'autopilot-run.sh')}' >> '${job.logPath}' 2>&1${job.cronMarker ? ` ${job.cronMarker}` : ''}`;
    expect(autopilotLauncher(() => `MAILTO=""\n${line}\n`, undefined, 30)).toEqual({ kind: 'cron', wait_ms: 360_000, pid: 30 });
    expect(autopilotLauncher(() => `# ${line}\n*/30 * * * * gbrain autopilot --status\n`, undefined, 30)).toBeNull();
    expect(autopilotLauncher(() => null, undefined, 30)).toBeNull();
    expect(autopilotLauncher(() => `0 0 * * * gbrain autopilot pause${job.cronMarker ? ` ${job.cronMarker}` : ''}\n`, undefined, 30)).toBeNull();
    expect(autopilotLauncher(() => `${line.replace('*/5 * * * *', '0 3 * * *')}\n`, undefined, 30)).toBeNull();
    expect(autopilotLauncher(() => null, 'external', null)).toEqual({ kind: 'declared', wait_ms: 360_000, pid: null });
  });

  test('the plan reads the crontab only when an autopilot is running: none, no read and no launcher; one, the cron line is read and the hand-off plans', () => {
    const job = resolveAutopilotJob();
    const line = `*/5 * * * * '${join(job.homeDir, 'autopilot-run.sh')}' >> '${job.logPath}' 2>&1${job.cronMarker ? ` ${job.cronMarker}` : ''}`;
    let reads = 0;
    const launcher = () => autopilotLauncher(() => { reads++; return `${line}\n`; }, undefined, 30);
    const serve: HostProcess = { pid: 8, ppid: null, role: 'serve', version: OLD, started_ms: 1_000, ancestors: [1], args: ['serve'] };
    expect(launcherFor([], launcher)).toBeNull();
    expect(launcherFor([serve], launcher)).toBeNull();
    expect(reads).toBe(0);
    const found = launcherFor([serve, autopilot()], launcher);
    expect(reads).toBe(1);
    expect(found).toEqual(CRON);
    expect(planRestart([autopilot()], ctx({ expected: PENDING_BUILD, autopilotLauncher: found })).steps)
      .toEqual([{ kind: 'handoff', role: 'autopilot', pid: 30, started_ms: 1_000, launcher: CRON }]);
  });

  test('self_upgrade.autopilot_launcher is a registered leaf that accepts external only', () => {
    expect(SELF_UPGRADE_CONFIG_LEAVES).toContain('autopilot_launcher');
    expect(parseSelfUpgradeConfigValue('autopilot_launcher', 'external')).toEqual({ ok: true, value: 'external' });
    expect(parseSelfUpgradeConfigValue('autopilot_launcher', 'cron').ok).toBe(false);
  });
});

describe('doctor self_upgrade_health with the restart plan', () => {
  test('warns that gbrain upgrade refuses, naming the autopilot pid, with gbrain autopilot --install as an ask-user fix', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'auto' }, () => {
      const check = checkSelfUpgradeHealth(planRestart([autopilot()], ctx({ expected: PENDING_BUILD })));
      expect(check.status).toBe('warn');
      expect(check.message).toContain('gbrain upgrade refuses on this host: ');
      expect(check.message).not.toContain('auto-upgrades cannot finish');
      expect(check.message).toContain('autopilot pid 30');
      expect(check.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'autopilot', '--install'] });
      expect(check.fix?.user_message).toContain('self_upgrade.autopilot_launcher external');
    });
  });

  test('names a hand-off and a second Bun global install in an ok message; no plan, or an empty one, leaves the message as it was', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'notify' }, () => {
      const copy = '/home/alice-example/.bun-pinned/install/global/node_modules/gbrain';
      const serve: HostProcess = { pid: 9, ppid: null, role: 'serve', version: OLD, started_ms: 1_000, ancestors: [8], args: ['serve', '--http'], install_root: copy, install_version: OLD };
      const check = checkSelfUpgradeHealth(planRestart([autopilot(), serve], ctx({ expected: PENDING_BUILD, autopilotLauncher: CRON, ownInstallRoot: '/opt/gbrain', serveService: { argv: ['true'], pid: 8 } })));
      expect(check.status).toBe('ok');
      expect(check.message).toContain('upgrades restart autopilot pid 30 through this brain\'s gbrain cron line');
      expect(check.message).toContain(`pid 9 runs from a second install at ${copy} (v${OLD}), which upgrades replace too`);
      const plain = checkSelfUpgradeHealth().message;
      expect(checkSelfUpgradeHealth(null).message).toBe(plain);
      expect(checkSelfUpgradeHealth(planRestart([], ctx({ expected: PENDING_BUILD }))).message).toBe(plain);
    });
  });
  test('an MCP server a harness started does not warn (--stop-mcp stops it); a running sync still does, since a sync --watch never finishes', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'auto' }, () => {
      const mcp: HostProcess = { pid: 40, ppid: null, role: 'mcp', version: OLD, started_ms: 1_000, ancestors: [99], args: ['serve'] };
      const sync: HostProcess = { pid: 41, ppid: null, role: 'sync', version: OLD, started_ms: 1_000, ancestors: [98], args: ['sync', '--watch'] };
      const mcpOnly = planRestart([mcp], ctx({ expected: PENDING_BUILD }));
      expect(mcpOnly.manual.map(m => m.role)).toEqual(['mcp']);
      expect(checkSelfUpgradeHealth(mcpOnly).status).toBe('ok');
      const check = checkSelfUpgradeHealth(planRestart([mcp, sync], ctx({ expected: PENDING_BUILD })));
      expect(check.status).toBe('warn');
      expect(check.message).toContain('pid 41');
      expect(check.message).not.toContain('pid 40');
    });
  });

  test('a held auto-upgrade is reported ahead of the restart warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-8776-held-'));
    try {
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_AUDIT_DIR: join(dir, 'audit'), GBRAIN_SELF_UPGRADE_MODE: 'auto' }, () => {
        logSelfUpgrade({ channel: 'autopilot', action: 'unsupported_runtime', current: '0.43.0', latest: '0.99.0', outcome: 'skipped', reason: 'gbrain 0.99.0 requires Bun >=9.0.0' });
        const check = checkSelfUpgradeHealth(planRestart([autopilot()], ctx({ expected: PENDING_BUILD })));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('Auto-upgrade to 0.99.0 held');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
