/**
 * Three ways the self-upgrade restart left a host unable to finish an upgrade:
 *
 * - #8840: the autopilot swap exited for a supervisor to relaunch it, but the ephemeral-container start script runs
 *   the daemon once at container boot and a hand-started daemon has no launcher, so autopilot stayed dead. With no
 *   supervisor known, the daemon now starts itself again once it has exited.
 * - #9483: a serve run by an operator-named systemd unit or a container's process manager refused every upgrade with
 *   restart_refused and no exact command. The refusal now names the unit's restart command (or the command line serve
 *   was started with), and `self_upgrade.serve_launcher external` lets the upgrade restart that unit, or stop serve
 *   and wait for the supervisor to start the new build.
 * - #9725: on macOS the process table never showed GBRAIN_HOME, so a second brain's serve on the same host was planned
 *   as this brain's and refused every restart. The home now comes from `ps -E`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  collectHostProcesses, homeFromPsEnvironment, planRestart, restartProblems, runRestartSteps, unitFromCgroup, PENDING_BUILD,
  type AutopilotLauncher, type HostProcess, type ProcessSources, type RestartContext, type RestartExecutor,
} from '../src/core/upgrade-restart.ts';
import { planServeRestart, restartRefusal, serveLauncher, upgradeRestartReadiness } from '../src/commands/upgrade-restart.ts';
import { relaunchAfterSwap, spawnRelauncher } from '../src/commands/autopilot/relaunch.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor/checks/upgrade-health.ts';
import { parseSelfUpgradeConfigValue, SELF_UPGRADE_CONFIG_LEAVES } from '../src/core/self-upgrade.ts';
import { withEnv } from './helpers/with-env.ts';

const NEW = '0.60.800.0';
const OLD = '0.60.790.0';
const LAUNCHER: AutopilotLauncher = { kind: 'declared', wait_ms: 360_000, pid: null };
const MCP_UNIT = { name: 'gbrain-mcp.service', scope: 'user' as const };
const ctx = (over: Partial<RestartContext> = {}): RestartContext => ({ expected: PENDING_BUILD, serveService: null, autopilotService: null, stopMcp: false, ...over });
const serve = (pid = 40, over: Partial<HostProcess> = {}): HostProcess =>
  ({ pid, ppid: null, role: 'serve', version: OLD, started_ms: 1_000, ancestors: [1], args: ['serve', '--http', '--port', '3131'], ...over });

describe('#9725: another brain\'s serve on the same macOS host', () => {
  const command = 'bun /opt/brain-b/node_modules/gbrain/src/cli.ts serve --http --port 3133';
  const withEnvironment = `${command} TERM=xterm FOO=bar GBRAIN_HOME=/Users/alice-example/brain b-example PWD=/Users/alice-example HOME=/Users/alice-example`;

  test('ps -E\'s environment words give the process\'s GBRAIN_HOME, else HOME; none shown means unknown', () => {
    expect(homeFromPsEnvironment(command, withEnvironment)).toBe('/Users/alice-example/brain b-example');
    expect(homeFromPsEnvironment(command, `${command} PWD=/x HOME=/Users/alice-example`)).toBe('/Users/alice-example');
    expect(homeFromPsEnvironment(command, command)).toBeUndefined();
    expect(homeFromPsEnvironment(command, 'something else')).toBeUndefined();
    expect(homeFromPsEnvironment(command, `${command} NOTE=x GBRAIN_HOME=/Users/alice-example GBRAIN_HOME=/Users/bob-example`)).toBeUndefined();
  });

  test('with the home read, the other brain\'s serve is not this brain\'s, so the restart neither refuses nor targets it', async () => {
    const sources = (home: string | null | undefined): ProcessSources => ({
      heartbeats: async () => [], supervisor: () => null, workers: () => [], home: '/Users/alice-example', exclude: [],
      processTable: () => [{ pid: 50, ppid: 1, command, started_ms: 1_000, gbrain_home: home }],
    });
    const unread = await collectHostProcesses(sources(undefined));
    const refusal = restartRefusal(planRestart(unread, ctx()), ['gbrain', 'upgrade'], false);
    expect(refusal?.code).toBe('restart_refused');
    expect(unread[0]!.home_unread).toBe(true);
    const read = await collectHostProcesses(sources(homeFromPsEnvironment(command, withEnvironment)));
    expect(read).toEqual([]);
    expect(restartRefusal(planRestart(read, ctx()), ['gbrain', 'upgrade'], false)).toBeNull();
  });
});

test.skipIf(process.platform !== 'linux')('doctor ignores a sync that exited or is an unreaped zombie after ps listed it, but not a live sync whose brain home is unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-restart-ps-'));
  const running = Bun.spawn(['/bin/sleep', '30'], { env: {} });
  const holder = Bun.spawn(['/bin/sh', '-c', '/bin/true & echo $!; exec /bin/sleep 30'], { env: {}, stdout: 'pipe' });
  try {
    const zombie = Number(new TextDecoder().decode((await holder.stdout.getReader().read()).value).trim());
    for (let i = 0; i < 100 && !readFileSync(`/proc/${zombie}/stat`, 'utf8').includes(') Z '); i++) await Bun.sleep(20);
    expect(readFileSync(`/proc/${zombie}/stat`, 'utf8')).toContain(') Z ');
    writeFileSync(join(dir, 'ps'), `#!/bin/sh\nprintf '%s\\n' '2147483647 1 00:01 gbrain sync' '${zombie} 1 00:01 gbrain sync' '${running.pid} 1 00:01 gbrain sync'\n`, { mode: 0o700 });
    await withEnv({ GBRAIN_HOME: dir, PATH: `${dir}:${process.env.PATH}` }, async () => {
      const plan = await upgradeRestartReadiness();
      expect(plan?.manual.map(step => step.pid)).toEqual([running.pid]);
    });
  } finally {
    running.kill();
    holder.kill();
    await Promise.all([running.exited, holder.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('#9483: a serve run by an operator-named unit or a container supervisor', () => {
  test('the systemd unit comes from the cgroup: user and system units; a session scope, the user manager or a container root is none', () => {
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/gbrain-mcp.service\n')).toEqual(MCP_UNIT);
    expect(unitFromCgroup('0::/system.slice/gbrain-http.service\n')).toEqual({ name: 'gbrain-http.service', scope: 'system' });
    expect(unitFromCgroup('12:pids:/\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/gbrain-mcp.service\n')).toEqual(MCP_UNIT);
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service\n')).toBeNull();
    expect(unitFromCgroup('0::/\n')).toBeNull();
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/-H.service\n')).toBeNull();
  });

  test('undeclared: the refusal names the unit\'s exact restart command, or the command line serve was started with, and the key', () => {
    const inUnit = planRestart([serve(40, { unit: MCP_UNIT })], ctx());
    expect(inUnit.manual.map(m => m.argv)).toEqual([['systemctl', '--user', 'restart', '--', 'gbrain-mcp.service']]);
    expect(inUnit.manual[0]!.instruction).toContain('runs under the systemd unit gbrain-mcp.service');
    expect(inUnit.manual[0]!.instruction).toContain('`gbrain upgrade --no-restart`, then restart it with `systemctl --user restart -- gbrain-mcp.service`');
    expect(restartRefusal(inUnit, ['gbrain', 'upgrade'], false)?.fix).toMatchObject({ argv: ['systemctl', '--user', 'restart', '--', 'gbrain-mcp.service'] });
    const byHand = planRestart([serve()], ctx());
    expect(byHand.manual[0]!.instruction).toContain('(`gbrain serve --http --port 3131`)');
    expect(byHand.manual[0]!.instruction).toContain('gbrain config set self_upgrade.serve_launcher external');
  });

  test('declared: the unit is restarted with its own command; any other serve of this brain is handed to the supervisor', () => {
    expect(planRestart([serve(40, { unit: MCP_UNIT }), serve(41, { unit: MCP_UNIT })], ctx({ serveLauncher: LAUNCHER })))
      .toMatchObject({ manual: [], steps: [{ kind: 'service', role: 'serve', argv: ['systemctl', '--user', 'restart', '--', 'gbrain-mcp.service'], pids: [40, 41] }] });
    const handed = planRestart([serve()], ctx({ serveLauncher: LAUNCHER }));
    expect(handed.manual).toEqual([]);
    expect(handed.steps).toEqual([{ kind: 'handoff', role: 'serve', pid: 40, started_ms: 1_000, launcher: LAUNCHER, command: 'gbrain serve --http --port 3131' }]);
    expect(restartRefusal(handed, ['gbrain', 'upgrade'], false)).toBeNull();
  });

  test('declared, but a serve whose environment could not be read is never stopped or restarted: it is a manual step', () => {
    for (const over of [{ home_unread: true }, { home_unread: true, unit: MCP_UNIT }, { args: undefined, started_ms: null }]) {
      const plan = planRestart([serve(40, over)], ctx({ serveLauncher: LAUNCHER }));
      expect(plan.steps).toEqual([]);
      expect(plan.manual.map(m => m.argv)).toEqual([['kill', '40']]);
    }
  });

  test('gbrain\'s own serve service still wins over the declared launcher', () => {
    const service = { argv: ['systemctl', '--user', 'restart', 'gbrain-serve.service'], pid: 9 };
    expect(planRestart([serve(40, { ancestors: [9] })], ctx({ serveService: service, serveLauncher: LAUNCHER })).steps)
      .toEqual([{ kind: 'service', role: 'serve', argv: service.argv, pids: [40] }]);
  });

  test('the hand-off stops only the serve the plan saw, and is done only when a serve started after the restart is back', async () => {
    const plan = planRestart([serve()], ctx({ expected: NEW, serveLauncher: LAUNCHER }));
    const seen: string[] = [];
    const exec: RestartExecutor = { run: () => ({ status: 0, output: '' }), terminate: (pid, _s, role) => { seen.push(`${role} ${pid}`); return 'stopped'; }, supervisorPid: () => null, sleep: async () => {} };
    const [result] = await runRestartSteps(plan, exec);
    expect(seen).toEqual(['serve 40']);
    expect(result!.detail).toBe('stopped serve pid 40; the launcher self_upgrade.serve_launcher declares starts it again');
    const warm = { before: { state: 'absent' as const }, after: { state: 'absent' as const } };
    expect(restartProblems(plan, [], 5_000, warm)).toEqual(['serve did not come back after it was stopped for the launcher self_upgrade.serve_launcher declares to start again: start it with `gbrain serve --http --port 3131` the way it was launched.']);
    expect(restartProblems(plan, [serve(140, { version: NEW, started_ms: 9_000 })], 5_000, warm)).toEqual([]);
  });

  test('the autopilot channel\'s serve restart takes the declared launcher when no gbrain serve service exists', () => {
    const plan = planServeRestart([serve()], null, NEW, null, null, LAUNCHER);
    expect('steps' in plan && plan.steps).toMatchObject([{ kind: 'handoff', role: 'serve', pid: 40 }]);
    expect(planServeRestart([serve()], null, NEW, null)).toMatchObject({ outcome: 'manual' });
  });

  test('self_upgrade.serve_launcher is a registered leaf that accepts external only, and doctor stops warning once it is set', async () => {
    expect(SELF_UPGRADE_CONFIG_LEAVES).toContain('serve_launcher');
    expect(parseSelfUpgradeConfigValue('serve_launcher', 'external')).toEqual({ ok: true, value: 'external' });
    expect(parseSelfUpgradeConfigValue('serve_launcher', 'systemd').ok).toBe(false);
    expect(serveLauncher('external')).toEqual(LAUNCHER);
    expect(serveLauncher(undefined)).toBeNull();
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'auto' }, () => {
      expect(checkSelfUpgradeHealth(planRestart([serve(40, { unit: MCP_UNIT })], ctx())).status).toBe('warn');
      const unit = checkSelfUpgradeHealth(planRestart([serve(40, { unit: MCP_UNIT })], ctx({ serveLauncher: LAUNCHER })));
      expect(unit.status).toBe('ok');
      expect(unit.message).toContain('upgrades restart serve pid 40 with `systemctl --user restart -- gbrain-mcp.service`');
      const handed = checkSelfUpgradeHealth(planRestart([serve()], ctx({ serveLauncher: LAUNCHER })));
      expect(handed.status).toBe('ok');
      expect(handed.message).toContain('upgrades restart serve pid 40 through the launcher self_upgrade.serve_launcher declares');
    });
  });
});

describe('#10291: a jobs worker run by a container process manager', () => {
  const home = '/srv/brain-example';
  const command = 'gbrain jobs work --queue source-a --max-rss 5120';
  const workerSources = (rows: ReturnType<ProcessSources['processTable']>): ProcessSources => ({
    home, exclude: [], heartbeats: async () => [], supervisor: () => null, workers: () => [], processTable: () => rows,
  });
  const foreignWorker = async () => (await collectHostProcesses(workerSources([
    { pid: 30, ppid: 1, command: `/usr/bin/tini -s -- ${command}`, started_ms: 900, gbrain_home: home },
    { pid: 40, ppid: 30, command, started_ms: 1_000, gbrain_home: home },
  ])))[0]!;

  test('undeclared: the upgrade refusal still names the foreign parent and manual restart', async () => {
    const plan = planRestart([await foreignWorker()], ctx());
    expect(plan.steps).toEqual([]);
    const manual = 'worker pid 40 (build not recorded) is not run by a jobs supervisor this restart can relaunch (its parent, pid 30 (`tini`), is not a process this restart recognises as gbrain): stop it (`kill 40`, SIGTERM drains its jobs) and start `gbrain jobs work` again the way it was launched, or run workers under `gbrain jobs supervisor start --detach`.';
    expect(plan.manual[0]?.instruction).toBe(manual);
    expect(restartRefusal(plan, ['gbrain', 'upgrade'], false)?.code).toBe('restart_refused');
  });

  test('declared: the upgrade hands off a foreign-managed worker and verifies a new worker for this brain', async () => {
    const worker = await foreignWorker();
    const plan = planRestart([worker], ctx({ expected: NEW, workerLauncher: LAUNCHER }));
    expect(plan.manual).toEqual([]);
    expect(plan.steps).toEqual([{ kind: 'handoff', role: 'worker', pid: 40, started_ms: 1_000, launcher: LAUNCHER, command }]);
    expect(restartRefusal(plan, ['gbrain', 'upgrade'], false)).toBeNull();
    const terminateCalls: unknown[][] = [];
    const exec: RestartExecutor = { run: () => ({ status: 0, output: '' }), terminate: (...args) => { terminateCalls.push(args); return 'stopped'; }, supervisorPid: () => null, sleep: async () => {} };
    const [result] = await runRestartSteps(plan, exec);
    expect(terminateCalls).toEqual([[40, 1_000, 'worker']]);
    expect(result?.detail).toBe('stopped worker pid 40; the launcher self_upgrade.worker_launcher declares starts it again');
    const warm = { before: { state: 'absent' as const }, after: { state: 'absent' as const } };
    const missing = `worker did not come back after it was stopped for the launcher self_upgrade.worker_launcher declares to start again: start it with \`${command}\` the way it was launched.`;
    const replacement = { pid: 140, ppid: 1, command, started_ms: 9_000, gbrain_home: home };
    const collect = (gbrain_home: string | undefined) => collectHostProcesses({
      ...workerSources([{ ...replacement, gbrain_home }]), workers: () => [{ pid: 140, version: NEW }],
    });
    expect(restartProblems(plan, [], 5_000, warm)).toEqual([missing]);
    expect(restartProblems(plan, await collect('/srv/brain-b-example'), 5_000, warm)).toEqual([missing]);
    expect(restartProblems(plan, await collect(undefined), 5_000, warm)).toContain(missing);
    const [fresh] = await collect(home);
    expect(restartProblems(plan, [{ ...fresh!, started_ms: 2_000 }], 5_000, warm)).toContain(missing);
    expect(restartProblems(plan, [{ ...fresh!, version: OLD, install_version: NEW }], 5_000, warm)).toContain(missing);
    expect(restartProblems(plan, [{ ...fresh!, version: null }], 5_000, warm)).toContain(missing);
    expect(restartProblems(plan, [{ ...fresh!, ppid: 20 }], 5_000, warm)).toContain(missing);
    expect(restartProblems(plan, [{ ...fresh!, version: null, install_version: NEW }], 5_000, warm)).toEqual([]);
    expect(restartProblems(plan, [fresh!], 5_000, warm)).toEqual([]);
  });

  test('declared: each handed-off worker needs its own replacement launched the same way', async () => {
    const other = 'gbrain jobs work --queue source-b --max-rss 5120';
    const workers = await collectHostProcesses(workerSources([
      { pid: 30, ppid: 1, command: `/usr/bin/tini -s -- ${command}`, started_ms: 900, gbrain_home: home },
      { pid: 40, ppid: 30, command, started_ms: 1_000, gbrain_home: home },
      { pid: 31, ppid: 1, command: `/usr/bin/tini -s -- ${other}`, started_ms: 900, gbrain_home: home },
      { pid: 41, ppid: 31, command: other, started_ms: 1_000, gbrain_home: home },
    ]));
    const plan = planRestart(workers, ctx({ expected: NEW, workerLauncher: LAUNCHER }));
    expect(plan.steps.map(step => step.kind === 'handoff' ? step.command : null).sort()).toEqual([command, other]);
    const warm = { before: { state: 'absent' as const }, after: { state: 'absent' as const } };
    const back = (rows: Array<{ pid: number; command: string }>) => collectHostProcesses({
      ...workerSources(rows.map(row => ({ ...row, ppid: 1, started_ms: 9_000, gbrain_home: home }))),
      workers: () => rows.map(row => ({ pid: row.pid, version: NEW })),
    });
    const missingOther = `worker did not come back after it was stopped for the launcher self_upgrade.worker_launcher declares to start again: start it with \`${other}\` the way it was launched.`;
    expect(restartProblems(plan, await back([{ pid: 140, command }]), 5_000, warm)).toEqual([missingOther]);
    expect(restartProblems(plan, await back([{ pid: 140, command }, { pid: 141, command: other }]), 5_000, warm)).toEqual([]);
  });

  test('declared: an unread worker stays manual and a gbrain-supervised worker still restarts with its supervisor', async () => {
    const worker = await foreignWorker();
    const configured = ctx({ workerLauncher: LAUNCHER });
    for (const over of [{ home_unread: true }, { args: undefined }, { started_ms: null }]) {
      const plan = planRestart([{ ...worker, ...over }], configured);
      expect(plan.steps).toEqual([]);
      expect(plan.manual.map(step => step.pid)).toEqual([40]);
    }
    const supervisor: HostProcess = { pid: 20, ppid: null, role: 'supervisor', version: OLD, started_ms: 900, args: ['jobs', 'supervisor', 'start', '--detach'] };
    const plan = planRestart([supervisor, { ...worker, ppid: 20, unclassified_parent: undefined }], configured);
    expect(plan.manual).toEqual([]);
    expect(plan.steps).toMatchObject([{ kind: 'supervisor', pid: 20, workers: [40] }]);
  });

  test.skipIf(process.platform !== 'linux')('doctor stops warning about an externally launched worker when the repo-less brain declares it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-worker-launcher-'));
    const running = Bun.spawn(['/bin/sleep', '30'], { env: { GBRAIN_HOME: dir } });
    try {
      mkdirSync(join(dir, '.gbrain'));
      writeFileSync(join(dir, 'ps'), `#!/bin/sh\nprintf '%s\\n' '2147483647 1 00:02 /usr/bin/tini -s -- ${command}' '${running.pid} 2147483647 00:01 ${command}'\n`, { mode: 0o700 });
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_SELF_UPGRADE_MODE: 'auto', PATH: `${dir}:${process.env.PATH}` }, async () => {
        const config = { engine: 'pglite', database_path: join(dir, '.gbrain', 'brain.db') };
        const configPath = join(dir, '.gbrain', 'config.json');
        writeFileSync(configPath, JSON.stringify(config));
        expect(checkSelfUpgradeHealth(await upgradeRestartReadiness()).status).toBe('warn');
        writeFileSync(configPath, JSON.stringify({ ...config, self_upgrade: { worker_launcher: 'external' } }));
        const health = checkSelfUpgradeHealth(await upgradeRestartReadiness());
        expect(health.status).toBe('ok');
        expect(health.message).toContain(`upgrades restart worker pid ${running.pid} through the launcher self_upgrade.worker_launcher declares`);
      });
    } finally {
      running.kill();
      await running.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#8840: the autopilot swap never exits into nothing', () => {
  const deps = (over: Partial<Parameters<typeof relaunchAfterSwap>[0]> = {}) => {
    const spawned: Array<[number, string[]]> = [];
    return { spawned, deps: { underService: async () => false, launcher: async () => null, argv: () => ['/usr/local/bin/gbrain', 'autopilot', '--repo', '/srv/brain-example'],
      spawnRelauncher: (pid: number, argv: string[]) => { spawned.push([pid, argv]); }, ...over } };
  };

  test('with no supervisor (the ephemeral-container start script, a daemon started by hand) it relaunches itself with the same command line', async () => {
    const { spawned, deps: d } = deps();
    expect(await relaunchAfterSwap(d)).toEqual({ by: 'self', argv: ['/usr/local/bin/gbrain', 'autopilot', '--repo', '/srv/brain-example'] });
    expect(spawned).toEqual([[process.pid, ['/usr/local/bin/gbrain', 'autopilot', '--repo', '/srv/brain-example']]]);
  });

  test('under its installed service, this brain\'s cron line or a declared launcher it exits for that supervisor and starts nothing', async () => {
    for (const over of [{ underService: async () => true }, { launcher: async () => LAUNCHER }]) {
      const { spawned, deps: d } = deps(over);
      expect(await relaunchAfterSwap(d)).toEqual({ by: 'supervisor' });
      expect(spawned).toEqual([]);
    }
  });

  test('when no relaunch can be set up it stays running on its loaded build instead of exiting', async () => {
    const { deps: d } = deps({ argv: () => { throw new Error('Could not resolve the gbrain CLI path'); } });
    expect(await relaunchAfterSwap(d)).toEqual({ by: 'stay', reason: 'Could not resolve the gbrain CLI path' });
  });

  test('the relauncher runs the command once the exiting pid is a zombie its parent never reaps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-8840-'));
    const parent = spawn('/bin/sh', ['-c', 'sleep 1 & echo $!; exec sleep 10'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const marker = join(dir, 'relaunched');
      const pid = await new Promise<number>(r => parent.stdout!.once('data', d => r(Number(String(d).trim()))));
      spawnRelauncher(pid, ['/bin/sh', '-c', `touch '${marker}'`]);
      for (let i = 0; i < 24 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 250));
      expect(existsSync(marker)).toBe(true);
    } finally {
      parent.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('the relauncher waits for the exiting pid, then runs the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-8840-'));
    try {
      const marker = join(dir, 'relaunched');
      const exiting = spawn('sleep', ['2'], { stdio: 'ignore' });
      spawnRelauncher(exiting.pid!, ['/bin/sh', '-c', `date +%s > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'`]);
      await new Promise(r => setTimeout(r, 1_000));
      expect(existsSync(marker)).toBe(false);
      await new Promise(r => exiting.on('exit', r));
      for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 250));
      expect(readFileSync(marker, 'utf8').trim()).toMatch(/^\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
