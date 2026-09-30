import { describe, expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { ChildWorkerSupervisor } from '../src/core/minions/child-worker-supervisor.ts';
import { OwnerProcessingState, readAutopilotProcessingStatus, readOwnerProcessingStatus, writeWorkerProcessingStatus } from '../src/core/minions/processing-state.ts';
import { MinionSupervisor } from '../src/core/minions/supervisor.ts';
import { guardAutopilotEngine } from '../src/commands/autopilot.ts';
import { autopilotLockPath } from '../src/core/autopilot-paths.ts';
import { killProcessGroup } from '../src/core/minions/job-isolation.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

async function isolated(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-blocked-owner-'));
  try { await withEnv({ GBRAIN_HOME: root, HOME: root }, () => fn(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe('configuration-blocked worker ownership', () => {
  test('real spawn keeps the owner handoff through hostile-cwd quarantine without restoring untrusted values', async () => isolated(async (root) => {
    const quarantineModule = pathToFileURL(join(import.meta.dir, '../src/core/env-trust.ts')).href;
    const preflightModule = pathToFileURL(join(import.meta.dir, '../src/core/cli-preflight.ts')).href;
    const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
    const supervisorModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/child-worker-supervisor.ts')).href;
    const poisonedPath = join(root, 'untrusted-status');
    writeFileSync(join(root, '.env'), `GBRAIN_WORKER_STATUS_PATH=${poisonedPath}\nGBRAIN_WORKER_STATUS_TOKEN=untrusted\n`);
    const worker = join(root, 'worker.ts');
    writeFileSync(worker, `
import {writeFileSync} from 'node:fs';
import {runCliPreflight,CWD_ENV_QUARANTINED_MARKER} from ${JSON.stringify(preflightModule)};
import {writeWorkerProcessingStatus} from ${JSON.stringify(statusModule)};
const neutral=JSON.parse(process.env[CWD_ENV_QUARANTINED_MARKER]!).neutral;
await runCliPreflight();
const published=writeWorkerProcessingStatus({state:'ready'});
writeFileSync('worker-observation.json',JSON.stringify({cwd:process.cwd(),neutral,marker:process.env[CWD_ENV_QUARANTINED_MARKER]??null,published,supervised:process.env.GBRAIN_SUPERVISED,path:process.env.GBRAIN_WORKER_STATUS_PATH}));
process.exit(1);
`);
    const parent = join(root, 'parent.ts');
    writeFileSync(parent, `
import {quarantineCwdDotenv} from ${JSON.stringify(quarantineModule)};
import {OwnerProcessingState} from ${JSON.stringify(statusModule)};
import {ChildWorkerSupervisor} from ${JSON.stringify(supervisorModule)};
quarantineCwdDotenv();
const state=new OwnerProcessingState('supervisor','fixture');
await new ChildWorkerSupervisor({cliPath:process.execPath,args:['./worker.ts'],env:{...process.env,GBRAIN_SUPERVISED:undefined},processingState:state,maxCrashes:1,hardStopMaxCrashes:1,isStopping:()=>false,onMaxCrashesExceeded:()=>{},onEvent:()=>{}}).run();
state.close();
`);
    const child = Bun.spawn([process.execPath, '--no-env-file', parent], {
      cwd: root, env: { ...process.env, GBRAIN_WORKER_STATUS_PATH: poisonedPath, GBRAIN_WORKER_STATUS_TOKEN: 'untrusted' }, stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      expect(await child.exited, `${await stdout}\n${await stderr}`).toBe(0);
      const observation = JSON.parse(readFileSync(join(root, 'worker-observation.json'), 'utf8'));
      expect(observation.published).toBe(true);
      expect(observation.supervised).toBeUndefined();
      expect(observation.marker).toBeNull();
      expect(observation.cwd).toBe(root);
      expect(observation.path).not.toBe(poisonedPath);
      expect(existsSync(poisonedPath)).toBe(false);
      expect(existsSync(observation.neutral)).toBe(false);
    } finally { clearTimeout(timer); }
  }));

  test('unpublished readiness is bounded independently of health, retries softly, and stops at hard equality', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    const worker = join(root, 'unready.ts');
    writeFileSync(worker, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(root, 'worker-pids'))},process.pid+'\\n');
process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    let timeouts = 0;
    let hard = 0;
    let degraded = 0;
    const retrySnapshots: any[] = [];
    const sup = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [worker], processingState: state,
      maxCrashes: 1, hardStopMaxCrashes: 2, _startupReadyTimeoutMs: 500, _startupKillGraceMs: 20, _backoffFloorMs: 50,
      isStopping: () => false, onMaxCrashesExceeded: (count, ceiling) => { expect(count).toBe(ceiling); hard++; },
      onEvent: e => {
        if (e.kind === 'worker_startup_timeout') { timeouts++; expect(state.snapshot.processing_stage).toBe('startup_timeout'); }
        if (e.kind === 'health_warn' && e.reason === 'crash_budget_degraded') degraded++;
        if (e.kind === 'backoff') queueMicrotask(() => retrySnapshots.push(state.snapshot));
      },
    });
    await sup.run();
    expect({ timeouts, hard, degraded }).toEqual({ timeouts: 2, hard: 1, degraded: 1 });
    expect(sup.crashCount).toBe(2);
    expect(retrySnapshots).toHaveLength(1);
    expect(retrySnapshots[0].processing_stage).toBe('retry_backoff');
    expect(Number.isFinite(Date.parse(retrySnapshots[0].retry_at))).toBe(true);
    expect(state.snapshot.processing_stage).toBe('stopped');
    expect(state.snapshot.retry_at).toBeNull();
    const pids = readFileSync(join(root, 'worker-pids'), 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    state.close();
  }), 10_000);

  test('a confirmed ready worker survives the startup deadline and blocked state has no retry timestamp', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('autopilot', 'default');
    const worker = join(root, 'ready.ts');
    const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
    writeFileSync(worker, `import {writeWorkerProcessingStatus} from ${JSON.stringify(statusModule)};
writeWorkerProcessingStatus({state:'ready'});
setTimeout(()=>{writeWorkerProcessingStatus({state:'configuration_blocked',reason_code:'child_protocol_incompatible'});process.exit(16);},800);`);
    let timeouts = 0;
    const sup = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [worker], processingState: state,
      maxCrashes: 1, _startupReadyTimeoutMs: 500, _startupKillGraceMs: 20,
      isStopping: () => false, onMaxCrashesExceeded: () => {},
      onEvent: e => { if (e.kind === 'worker_startup_timeout') timeouts++; },
    });
    await sup.run();
    expect(timeouts).toBe(0);
    expect(state.snapshot.processing_stage).toBe('configuration_blocked');
    expect(state.snapshot.retry_at).toBeNull();
    expect(sup.crashCount).toBe(0);
    state.close();
  }));

  test('autopilot status binds processing state to the live lock holder PID', async () => isolated(async () => {
    const state = new OwnerProcessingState('autopilot', 'default');
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const otherPid = other.pid!;
      const autopilot = { readProcessCommand: () => 'gbrain autopilot' };
      expect(readAutopilotProcessingStatus()).toBeNull();
      writeFileSync(autopilotLockPath(), String(process.pid));
      expect(readAutopilotProcessingStatus()?.owner_pid).toBe(process.pid);
      writeFileSync(autopilotLockPath(), String(otherPid));
      expect(readAutopilotProcessingStatus(autopilot)).toBeNull();
      const runtime = join(autopilotLockPath(), '..', 'runtime');
      const ownerFile = join(runtime, readdirSync(runtime).find(f => f.startsWith('autopilot-') && f.endsWith('.json'))!);
      writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(readFileSync(ownerFile, 'utf8')), owner_pid: otherPid, processing_state: 'ready', processing_stage: 'ready' }));
      expect(readAutopilotProcessingStatus({ readProcessCommand: () => 'sleep 30' })).toBeNull();
      expect(readAutopilotProcessingStatus({ isPidAlive: () => false })).toBeNull();
      expect(readAutopilotProcessingStatus(autopilot)?.processing_ready).toBe(true);
    } finally {
      other.kill('SIGKILL');
      state.close();
    }
  }));

  test('startup timeout also reaps an unready direct worker without tini', async () => withEnv({ PATH: '' }, () => isolated(async () => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let pid = 0;
    let timeouts = 0;
    const sup = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], processingState: state,
      maxCrashes: 1, hardStopMaxCrashes: 1, _startupReadyTimeoutMs: 300, _startupKillGraceMs: 20,
      isStopping: () => false, onMaxCrashesExceeded: () => {},
      onEvent: e => {
        if (e.kind === 'worker_spawned') pid = e.pid;
        if (e.kind === 'worker_startup_timeout') timeouts++;
      },
    });
    expect(sup.isTiniDetected).toBe(false);
    await sup.run();
    expect(timeouts).toBe(1);
    expect(sup.crashCount).toBe(1);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    state.close();
  })));

  test('managed spawns leave GBRAIN_SUPERVISED to the owner and always hand off the status channel', async () => withEnv({ GBRAIN_SUPERVISED: '1' }, () => isolated(async (root) => {
    const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
    const observations = join(root, 'observations');
    const worker = join(root, 'env-observer.ts');
    writeFileSync(worker, `import {appendFileSync} from 'node:fs';
import {writeWorkerProcessingStatus} from ${JSON.stringify(statusModule)};
appendFileSync(${JSON.stringify(observations)},JSON.stringify({supervised:process.env.GBRAIN_SUPERVISED??null,path:Boolean(process.env.GBRAIN_WORKER_STATUS_PATH),token:Boolean(process.env.GBRAIN_WORKER_STATUS_TOKEN),published:writeWorkerProcessingStatus({state:'ready'})})+'\\n');
process.exit(1);`);
    const observe = async (kind: 'autopilot' | 'supervisor', env: NodeJS.ProcessEnv) => {
      const state = new OwnerProcessingState(kind, 'fixture');
      await new ChildWorkerSupervisor({
        cliPath: process.execPath, args: [worker], env, processingState: state, maxCrashes: 1, hardStopMaxCrashes: 1,
        isStopping: () => false, onMaxCrashesExceeded: () => {}, onEvent: () => {},
      }).run();
      state.close();
    };
    await observe('autopilot', { ...process.env, GBRAIN_SUPERVISED: undefined });
    await observe('supervisor', { ...process.env, GBRAIN_SUPERVISED: '1' });
    const [autopilot, supervisor] = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(autopilot).toEqual({ supervised: null, path: true, token: true, published: true });
    expect(supervisor).toEqual({ supervised: '1', path: true, token: true, published: true });
  })));

  test.skipIf(process.platform === 'win32')('without tini, killing the owner process group also kills its managed worker', async () => isolated(async (root) => {
    const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
    const supervisorModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/child-worker-supervisor.ts')).href;
    const workerPidFile = join(root, 'worker.pid');
    const worker = join(root, 'worker.ts');
    writeFileSync(worker, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(workerPidFile)},String(process.pid));
setInterval(()=>{},1000);`);
    const ownerScript = join(root, 'owner.ts');
    writeFileSync(ownerScript, `import {OwnerProcessingState} from ${JSON.stringify(statusModule)};
import {ChildWorkerSupervisor} from ${JSON.stringify(supervisorModule)};
const state=new OwnerProcessingState('autopilot','default');
const sup=new ChildWorkerSupervisor({cliPath:process.execPath,args:[${JSON.stringify(worker)}],env:{...process.env,GBRAIN_SUPERVISED:undefined},processingState:state,maxCrashes:5,isStopping:()=>false,onMaxCrashesExceeded:()=>{},onEvent:()=>{}});
if (sup.isTiniDetected) process.exit(3);
void sup.run();
setInterval(()=>{},1000);`);
    const alive = (pid: number) => {
      try { process.kill(pid, 0); } catch { return false; }
      if (process.platform !== 'linux') return true;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch { return false; }
    };
    const owner = spawn(process.execPath, [ownerScript], {
      cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, PATH: '', TMPDIR: root },
    });
    let workerPid = 0;
    try {
      const started = Date.now() + 10_000;
      while (!existsSync(workerPidFile) && owner.exitCode === null && Date.now() < started) await Bun.sleep(20);
      expect(owner.exitCode).toBeNull();
      workerPid = Number(readFileSync(workerPidFile, 'utf8'));
      expect(workerPid).toBeGreaterThan(0);
      expect(killProcessGroup(owner.pid!, 'SIGKILL')).toBe(true);
      const reaped = Date.now() + 5_000;
      while (alive(workerPid) && Date.now() < reaped) await Bun.sleep(20);
      expect(alive(workerPid)).toBe(false);
    } finally {
      killProcessGroup(owner.pid!, 'SIGKILL');
      if (workerPid) {
        killProcessGroup(workerPid, 'SIGKILL');
        try { process.kill(workerPid, 'SIGKILL'); } catch {}
      }
    }
  }), 20_000);

  test('unwritable managed status fails publication before admission and follows ordinary bounded retry', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('autopilot', 'default');
    const reporter = pathToFileURL(join(import.meta.dir, '../src/commands/jobs-readiness.ts')).href;
    const worker = join(root, 'unwritable.ts');
    writeFileSync(worker, `import {mkdirSync,appendFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {reportWorkerReady} from ${JSON.stringify(reporter)};
unlinkSync(process.env.GBRAIN_WORKER_STATUS_PATH!);
mkdirSync(process.env.GBRAIN_WORKER_STATUS_PATH!);
try {reportWorkerReady();writeFileSync(${JSON.stringify(join(root, 'admitted'))},'unexpected');}
catch(error){appendFileSync(${JSON.stringify(join(root, 'publication-failures'))},String(error)+'\\n');process.exit(1);}`);
    let spawns = 0;
    let hardStops = 0;
    let timeouts = 0;
    const sup = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [worker], processingState: state,
      env: { ...process.env, GBRAIN_SUPERVISED: undefined }, maxCrashes: 1, hardStopMaxCrashes: 2,
      _startupReadyTimeoutMs: 10_000, _backoffFloorMs: 1, isStopping: () => false,
      onMaxCrashesExceeded: () => { hardStops++; },
      onEvent: e => {
        if (e.kind === 'worker_spawned') spawns++;
        if (e.kind === 'worker_startup_timeout') timeouts++;
      },
    });
    await sup.run();
    expect({ spawns, hardStops, timeouts }).toEqual({ spawns: 2, hardStops: 1, timeouts: 0 });
    expect(existsSync(join(root, 'admitted'))).toBe(false);
    const failures = readFileSync(join(root, 'publication-failures'), 'utf8').trim().split('\n');
    expect(failures).toHaveLength(2);
    expect(failures.every(line => line.includes('no jobs were admitted'))).toBe(true);
    expect(state.snapshot.processing_ready).toBe(false);
    expect(state.snapshot.processing_stage).toBe('stopped');
    state.close();
  }));

  test('authenticated startup phases and bounded retry timestamps survive offline status reads', async () => isolated(async () => {
    const state = new OwnerProcessingState('autopilot', 'default');
    const env = state.prepareChild();
    for (const stage of ['database_readiness', 'child_readiness', 'worker_startup'] as const) {
      writeWorkerProcessingStatus({ state: 'starting', stage }, env);
      expect(state.snapshot.processing_stage).toBe(stage);
      expect(readOwnerProcessingStatus('autopilot', 'default')?.processing_stage).toBe(stage);
    }
    state.workerExited();
    state.waiting('retry_backoff', Date.now() + 1000);
    const offline = readOwnerProcessingStatus('autopilot', 'default');
    expect(offline?.processing_stage).toBe('retry_backoff');
    expect(Date.parse(offline!.retry_at!)).toBeGreaterThan(Date.now());
    state.close();
  }));

  test('publication rejects absent channels, retired generations, and another bound worker PID', async () => isolated(async (root) => {
    const missing = { GBRAIN_WORKER_STATUS_PATH: join(root, 'missing', 'status.json'), GBRAIN_WORKER_STATUS_TOKEN: 'fixture-token' };
    expect(writeWorkerProcessingStatus({ state: 'ready' }, missing)).toBe(false);
    expect(existsSync(join(root, 'missing'))).toBe(false);
    const state = new OwnerProcessingState('supervisor', 'fixture');
    const first = state.prepareChild();
    expect(writeWorkerProcessingStatus({ state: 'ready' }, { ...first, GBRAIN_WORKER_STATUS_TOKEN: 'wrong-token' })).toBe(false);
    const status = JSON.parse(readFileSync(first.GBRAIN_WORKER_STATUS_PATH!, 'utf8'));
    writeFileSync(first.GBRAIN_WORKER_STATUS_PATH!, JSON.stringify({ ...status, worker_pid: process.pid + 1 }));
    expect(writeWorkerProcessingStatus({ state: 'ready' }, first)).toBe(false);
    const current = state.prepareChild();
    expect(writeWorkerProcessingStatus({ state: 'ready' }, first)).toBe(false);
    expect(existsSync(first.GBRAIN_WORKER_STATUS_PATH!)).toBe(false);
    expect(writeWorkerProcessingStatus({ state: 'starting', stage: 'worker_startup' }, current)).toBe(true);
    state.waiting('startup_timeout');
    expect(writeWorkerProcessingStatus({ state: 'ready' }, current)).toBe(false);
    expect(existsSync(current.GBRAIN_WORKER_STATUS_PATH!)).toBe(false);
    state.close();
  }));

  test('retirement after atomic publication but before its return fails the generation recheck', async () => isolated(async () => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    const previous = state.prepareChild();
    const originalRename = fs.renameSync;
    let intercepted = false;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      originalRename(from, to);
      if (to === previous.GBRAIN_WORKER_STATUS_PATH && !intercepted) {
        intercepted = true;
        state.prepareChild();
      }
    });
    try {
      expect(writeWorkerProcessingStatus({ state: 'ready' }, previous)).toBe(false);
      expect(intercepted).toBe(true);
      expect(state.snapshot.processing_ready).toBe(false);
      expect(existsSync(previous.GBRAIN_WORKER_STATUS_PATH!)).toBe(false);
    } finally {
      rename.mockRestore();
      state.close();
    }
  }));

  test('an old worker resumed by the timeout signal cannot publish ready or admit during the kill grace', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    const reporter = pathToFileURL(join(import.meta.dir, '../src/commands/jobs-readiness.ts')).href;
    const worker = join(root, 'late-ready.ts');
    writeFileSync(worker, `import {writeFileSync} from 'node:fs';
import {reportWorkerReady} from ${JSON.stringify(reporter)};
process.on('SIGTERM',()=>{
 try {reportWorkerReady();writeFileSync(${JSON.stringify(join(root, 'late-admission'))},'unexpected');}
 catch(error){writeFileSync(${JSON.stringify(join(root, 'late-refusal'))},String(error));}
 process.exit(1);
});
setInterval(()=>{},1000);`);
    let timeouts = 0;
    const sup = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [worker], processingState: state,
      maxCrashes: 1, hardStopMaxCrashes: 1, _startupReadyTimeoutMs: 1000, _startupKillGraceMs: 1000,
      isStopping: () => false, onMaxCrashesExceeded: () => {},
      onEvent: event => { if (event.kind === 'worker_startup_timeout') timeouts++; },
    });
    await sup.run();
    expect(timeouts).toBe(1);
    expect(existsSync(join(root, 'late-admission'))).toBe(false);
    expect(readFileSync(join(root, 'late-refusal'), 'utf8')).toContain('no jobs were admitted');
    expect(state.snapshot.processing_ready).toBe(false);
    state.close();
  }));

  for (const kind of ['supervisor', 'autopilot'] as const) {
    test.skipIf(process.platform === 'win32')(`${kind} survives Restart=always, retains singleton and recovers only after explicit restart`, async () => isolated(async (root) => {
      mkdirSync(join(root, '.gbrain'), { recursive: true });
      writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres' }));
      const fixture = join(root, 'owner.ts');
      const worker = join(root, 'cli.ts');
      writeFileSync(join(root, 'gbrain'), `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
      const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
      const ownerModule = pathToFileURL(join(import.meta.dir, kind === 'supervisor' ? '../src/core/minions/supervisor.ts' : '../src/commands/autopilot.ts')).href;
      const pidFile = join(root, 'supervisor.pid');
      const key = kind === 'supervisor' ? pidFile : 'default';
      writeFileSync(worker, `#!${process.execPath}
import {existsSync,appendFileSync} from 'node:fs';
import {writeWorkerProcessingStatus} from ${JSON.stringify(statusModule)};
appendFileSync(${JSON.stringify(join(root, 'spawns'))}, 'spawn\\n');
if (!existsSync(${JSON.stringify(join(root, 'repaired'))})) {
 writeWorkerProcessingStatus({state:'configuration_blocked',reason_code:'postgres_cancellation_unavailable'});
 process.exit(16);
}
writeWorkerProcessingStatus({state:'ready',worker_identity:{executable:'/fixture/gbrain',version:'1.0.0'}});
appendFileSync(${JSON.stringify(join(root, 'handlers'))}, 'completed\\n');
setInterval(()=>{}, 1000);
process.on('SIGTERM',()=>process.exit(0));
`, { mode: 0o755 });
      writeFileSync(fixture, `
import {${kind === 'supervisor' ? 'MinionSupervisor' : 'runAutopilot'}} from ${JSON.stringify(ownerModule)};
const engine = {
 kind:'postgres', sql:async()=>[{id:'fixture',fence:'1'}],
 getConfig:async()=>null, executeRaw:async()=>[], executeRawDirect:async()=>[{id:'fixture'}],
 getHealth:async()=>({brain_score:100}), disconnect:async()=>{}, reconnect:async()=>{}
};
${kind === 'supervisor'
  ? `await new MinionSupervisor(engine as any,{cliPath:process.execPath,cliArgsPrefix:[${JSON.stringify(worker)}],pidFile:${JSON.stringify(pidFile)},healthInterval:10,_backoffFloorMs:1}).start();`
  : `process.argv[1]=${JSON.stringify(worker)}; await runAutopilot(engine as any,['--repo',${JSON.stringify(root)},'--interval','1']);`}
`);
      let owner: ChildProcess;
      let logs = '';
      let outerRestarts = 0;
      const launch = () => {
        owner = spawn(process.execPath, [fixture], {
          env: { ...process.env, HOME: root, GBRAIN_HOME: root, PATH: `${root}:${process.env.PATH}`, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GBRAIN_SKIP_STARTUP_HOOKS: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        owner.stdout?.on('data', data => { logs += data; });
        owner.stderr?.on('data', data => { logs += data; });
      };
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 15_000;
        while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        if (!predicate()) throw new Error(`Owner fixture timed out: ${logs}`);
      };
      const stop = async () => {
        owner.kill('SIGTERM');
        await until(() => owner.exitCode !== null || owner.signalCode !== null);
      };
      launch();
      try {
        await until(() => readOwnerProcessingStatus(kind, key)?.processing_state === 'configuration_blocked');
        const firstPid = owner!.pid;
        for (let tick = 0; tick < 8; tick++) {
          await new Promise(r => setTimeout(r, 30));
          if (owner!.exitCode !== null || owner!.signalCode !== null) { outerRestarts++; launch(); }
        }
        expect(outerRestarts).toBe(0);
        expect(owner!.pid).toBe(firstPid);
        expect(readFileSync(join(root, 'spawns'), 'utf8').trim().split('\n')).toHaveLength(1);
        expect(readdirSync(root)).not.toContain('handlers');
        const lock = kind === 'supervisor' ? pidFile : join(root, '.gbrain', 'autopilot.lock');
        expect(readFileSync(lock, 'utf8').trim().split('\n')[0]).toBe(String(firstPid));
        writeFileSync(join(root, 'repaired'), 'yes');
        await new Promise(r => setTimeout(r, 150));
        expect(readOwnerProcessingStatus(kind, key)?.processing_state).toBe('configuration_blocked');
        await stop();
        launch();
        await until(() => readOwnerProcessingStatus(kind, key)?.processing_ready === true);
        expect(readFileSync(join(root, 'handlers'), 'utf8').trim()).toBe('completed');
        await stop();
        expect(owner!.exitCode).toBe(0);
      } finally {
        if (owner!.exitCode === null && owner!.signalCode === null) {
          owner!.kill('SIGTERM');
          await until(() => owner!.exitCode !== null || owner!.signalCode !== null).catch(() => { owner!.kill('SIGKILL'); });
        }
      }
    }), 40_000);
  }

  test('exit 16 blocks once before hard threshold, recovery and backoff', async () => isolated(async (root) => {
    const script = join(root, 'worker.mjs');
    writeFileSync(script, 'process.exit(16)');
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let spawns = 0;
    let recoveries = 0;
    let blocked = 0;
    let hardStops = 0;
    let backoffs = 0;
    const supervisor = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [script], processingState: state,
      maxCrashes: 1, hardStopMaxCrashes: 1, _backoffFloorMs: 0,
      isStopping: () => false, beforeSpawn: async () => { recoveries++; },
      onConfigurationBlocked: () => { blocked++; },
      onMaxCrashesExceeded: () => { hardStops++; },
      onEvent: (e) => { if (e.kind === 'worker_spawned') spawns++; if (e.kind === 'backoff') backoffs++; },
    });
    await supervisor.run();
    await supervisor.run();
    await supervisor.restartCurrentChild(0);
    expect({ spawns, recoveries, blocked, hardStops, backoffs }).toEqual({ spawns: 1, recoveries: 1, blocked: 1, hardStops: 0, backoffs: 0 });
    expect(supervisor.crashCount).toBe(0);
    expect(readOwnerProcessingStatus('supervisor', 'fixture', process.pid)).toMatchObject({ processing_ready: false, processing_state: 'configuration_blocked', reason_code: null });
    state.close();
  }));

  test('runtime handoff latches during drain and wins over a later clean exit', async () => isolated(async (root) => {
    const script = join(root, 'worker.mjs');
    const statusModule = pathToFileURL(join(import.meta.dir, '../src/core/minions/processing-state.ts')).href;
    writeFileSync(script, `import {writeWorkerProcessingStatus} from ${JSON.stringify(statusModule)};
      writeWorkerProcessingStatus({state:'configuration_blocked',reason_code:'postgres_cancellation_unavailable'});
      setTimeout(()=>process.exit(0), 350);`);
    const state = new OwnerProcessingState('autopilot', 'default');
    let observedAlive = false;
    let spawns = 0;
    const supervisor = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: [script], processingState: state, maxCrashes: 1,
      isStopping: () => false, onMaxCrashesExceeded: () => {},
      onConfigurationBlocked: () => { observedAlive = supervisor.childAlive; },
      onEvent: (event) => { if (event.kind === 'worker_spawned') spawns++; },
    });
    await supervisor.run();
    expect(observedAlive).toBe(true);
    expect(spawns).toBe(1);
    expect(state.snapshot.reason_code).toBe('postgres_cancellation_unavailable');
    state.close();
  }));

  test('stale child token cannot make a new runtime ready or blocked; restart resets observation', async () => isolated(async () => {
    const state = new OwnerProcessingState('autopilot', 'default');
    const oldEnv = state.prepareChild();
    const freshEnv = state.prepareChild();
    expect(writeWorkerProcessingStatus({ state: 'configuration_blocked', reason_code: 'child_protocol_incompatible' }, oldEnv)).toBe(false);
    expect(state.snapshot.processing_state).toBe('starting');
    writeWorkerProcessingStatus({ state: 'ready', worker_identity: { executable: '/fixture/gbrain', version: '1.2.3' }, child_identity: { executable: '/fixture/child', version: '1.2.2', protocol_version: 1 } }, freshEnv);
    expect(state.snapshot.processing_ready).toBe(true);
    writeWorkerProcessingStatus({ state: 'configuration_blocked', reason_code: 'child_protocol_incompatible' }, freshEnv);
    expect(state.blocked).toBe(true);
    expect(state.snapshot.child_identity).toEqual({ executable: '/fixture/child', version: '1.2.2', protocol_version: 1 });
    writeWorkerProcessingStatus({ state: 'ready' }, freshEnv);
    expect(state.blocked).toBe(true);
    const restarted = new OwnerProcessingState('autopilot', 'default');
    expect(restarted.snapshot.processing_state).toBe('starting');
    state.close();
    expect(readOwnerProcessingStatus('autopilot', 'default')?.runtime_id).toBe(restarted.snapshot.runtime_id);
    expect(readOwnerProcessingStatus('autopilot', 'default', process.pid + 1)).toBeNull();
    restarted.close();
  }));

  test('block while beforeSpawn is suspended prevents spawn on its continuation', async () => isolated(async () => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let resume!: () => void;
    let spawns = 0;
    const supervisor = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: ['-e', 'process.exit(0)'], processingState: state,
      maxCrashes: 1, isStopping: () => false,
      beforeSpawn: () => new Promise<void>(r => { resume = r; }),
      onMaxCrashesExceeded: () => {}, onEvent: (e) => { if (e.kind === 'worker_spawned') spawns++; },
    });
    const running = supervisor.run();
    state.block('child_executable_invalid');
    resume();
    await running;
    expect(spawns).toBe(0);
    state.close();
  }));

  test('configuration block cancels an already pending watchdog backoff', async () => isolated(async () => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let spawns = 0;
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const supervisor = new ChildWorkerSupervisor({
      cliPath: process.execPath, args: ['-e', 'process.exit(12)'], processingState: state,
      maxCrashes: 1, watchdogBackoffMs: 60_000, isStopping: () => false,
      onMaxCrashesExceeded: () => {},
      onEvent: (e) => {
        if (e.kind === 'worker_spawned') spawns++;
        if (e.kind === 'backoff') blockTimer = setTimeout(() => state.block('child_protocol_incompatible'), 10);
      },
    });
    try {
      await supervisor.run();
      expect(spawns).toBe(1);
      expect(supervisor.inBackoff).toBe(false);
      expect(supervisor.configurationBlocked).toBe(true);
    } finally {
      if (blockTimer) clearTimeout(blockTimer);
      state.close();
    }
  }));

  test('autopilot blocks dispatch continuations and reconnect but still permits engine shutdown', async () => isolated(async () => {
    const state = new OwnerProcessingState('autopilot', 'default');
    let resume!: () => void;
    let writes = 0;
    let disconnects = 0;
    const engine = guardAutopilotEngine({
      getConfig: () => new Promise<void>(r => { resume = r; }),
      executeRaw: async () => { writes++; return []; },
      reconnect: async () => { writes++; },
      disconnect: async () => { disconnects++; },
    } as unknown as BrainEngine, state);
    const dispatch = (async () => { await engine.getConfig('version'); await engine.executeRaw('fixture'); })();
    state.block('postgres_cancellation_unavailable');
    resume();
    await expect(dispatch).rejects.toThrow('configuration-blocked');
    expect(() => engine.reconnect()).toThrow('configuration-blocked');
    await engine.disconnect();
    expect({ writes, disconnects }).toEqual({ writes: 0, disconnects: 1 });
    state.close();
  }));

  test('standalone suppresses an in-flight health failure and failed lock refresh while blocked', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let rejectHealth!: (error: Error) => void;
    let reconnects = 0;
    const engine = {
      executeRaw: () => new Promise((_r, reject) => { rejectHealth = reject; }),
      reconnect: async () => { reconnects++; },
    } as unknown as BrainEngine;
    const supervisor = new MinionSupervisor(engine, { cliPath: process.execPath, pidFile: join(root, 'owner.pid') });
    Object.assign(supervisor, { processingState: state, consecutiveHealthFailures: 2 });
    writeWorkerProcessingStatus({ state: 'ready' }, state.prepareChild());
    const health = supervisor._healthCheckOnceForTests();
    state.block('postgres_cancellation_unavailable');
    rejectHealth(new Error('temporary outage'));
    await health;
    supervisor._setDbLockForTests({ refresh: async () => false } as any);
    await supervisor._refreshDbLockForTests();
    supervisor._setDbLockForTests({ refresh: async () => { throw new Error('offline'); } } as any);
    for (let i = 0; i < 4; i++) await supervisor._refreshDbLockForTests();
    expect(reconnects).toBe(0);
    expect(supervisor.processingStatus?.processing_state).toBe('configuration_blocked');
    state.close();
  }));

  test('configuration reported during maintenance shutdown keeps the owner and singleton alive', async () => isolated(async (root) => {
    const state = new OwnerProcessingState('supervisor', 'fixture');
    let released = 0;
    const supervisor = new MinionSupervisor({} as BrainEngine, { cliPath: process.execPath, pidFile: join(root, 'owner.pid') });
    Object.assign(supervisor, {
      processingState: state,
      childSupervisor: {
        killChild: () => {}, childAlive: false,
        awaitChildExit: async () => { state.block('postgres_cancellation_unavailable'); },
      },
    });
    supervisor._setDbLockForTests({ release: async () => { released++; } } as any);
    const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected owner exit'); });
    try {
      await Reflect.get(supervisor, 'shutdown').call(supervisor, 'supervisor_lock_lost', 4);
      expect(exit).not.toHaveBeenCalled();
      expect(released).toBe(0);
      expect(Reflect.get(supervisor, 'stopping')).toBe(false);
    } finally {
      exit.mockRestore();
      state.close();
    }
  }));
});
