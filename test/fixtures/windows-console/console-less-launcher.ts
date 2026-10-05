/**
 * Launcher for test/windows-hidden-console.test.ts (Windows only).
 *
 * The test starts it with spawnDetachedSupervisor, the production
 * `gbrain jobs supervisor start --detach` path, so it runs with no console like
 * every detached gbrain process. It launches the console probe (argv[3], also
 * on PATH as git.exe) through raw child_process without windowsHide (the
 * control), the supervisor's worker spawn, the Stop-hook push's git call and
 * every launcher in src/core/spawn.ts, then writes what each probe saw to
 * <argv[2]>/result.json.
 */
import { spawnSync as unhiddenSpawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChildWorkerSupervisor } from '../../../src/core/minions/child-worker-supervisor.ts';
import { resolveWorkspaceRoot } from '../../../src/core/workspace-push.ts';
import { consoleState } from './console-state.ts';

const [dir, probe] = process.argv.slice(2);
const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
process.env[pathKey] = `${dirname(probe)};${process.env[pathKey] ?? ''}`;
const results: Record<string, unknown> = { launcher: consoleState() };

async function record(label: string, launch: () => unknown): Promise<void> {
  const out = join(dir, `${label.replace(/\W+/g, '-')}.json`);
  process.env.GBRAIN_TEST_CONSOLE_STATE_OUT = out;
  try {
    await launch();
    for (let waited = 0; !existsSync(out) && waited < 30_000; waited += 50) await Bun.sleep(50);
    results[label] = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : 'probe did not run';
  } catch (error) {
    results[label] = `launch failed: ${error}`;
  }
}

const env = () => ({ ...process.env });
const exited = (child: { once(event: 'exit', listener: () => void): unknown }) => new Promise<void>(resolve => child.once('exit', resolve));

await record('control', () => unhiddenSpawnSync(probe, [], { env: env() }));
await record('worker', async () => {
  let stopping = false;
  await new ChildWorkerSupervisor({
    cliPath: probe, args: [], maxCrashes: 1, _backoffFloorMs: 1,
    isStopping: () => stopping,
    onMaxCrashesExceeded: () => { stopping = true; },
    onEvent: event => { if (event.kind === 'worker_exited') stopping = true; },
  }).run();
});
await record('git', () => resolveWorkspaceRoot(dir));

let seam: Record<string, (...args: any[]) => any> | null = null;
try {
  seam = await import('../../../src/core/spawn.ts');
} catch (error) {
  results.seam = `missing: ${error}`;
}
if (seam) {
  const s = seam;
  await record('spawn', () => exited(s.spawn(probe, [], { env: env(), stdio: 'ignore' })));
  await record('spawnSync', () => s.spawnSync(probe, { env: env() }));
  await record('execFile', () => new Promise(resolve => s.execFile(probe, { env: env() }, resolve)));
  await record('execFileSync', () => s.execFileSync(probe, [], { env: env() }));
  await record('exec', () => new Promise(resolve => s.exec(`"${probe}"`, { env: env() }, resolve)));
  await record('execSync', () => s.execSync(`"${probe}"`, { env: env() }));
  await record('bunSpawn', () => s.bunSpawn([probe], { env: env() }).exited);
  await record('bunSpawnSync', () => s.bunSpawnSync({ cmd: [probe], env: env() }));
}

writeFileSync(join(dir, 'result.tmp'), JSON.stringify(results));
renameSync(join(dir, 'result.tmp'), join(dir, 'result.json'));
process.exit(0);
