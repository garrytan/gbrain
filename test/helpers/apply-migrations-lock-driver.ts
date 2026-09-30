/** Drivers for the #5693 apply-migrations orchestration-lock tests (PGLite and Postgres). */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../../src/version.ts';

const REPO = resolve(import.meta.dir, '..', '..');

export type LockTestEngine = { engine: 'pglite' } | { engine: 'postgres'; database_url: string };

export function makeHome(engine: LockTestEngine): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-am-lock-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const config = engine.engine === 'pglite' ? { engine: 'pglite', database_path: join(home, 'brain.pglite') } : engine;
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  return home;
}

/** A runner whose single pending migration logs start/end and holds for `holdMs`. */
/** `stealLease` adds an earlier migration that hands the Postgres lease to another holder; the probe migration then must not run. */
export function writeDriver(home: string, opts: { holdMs: number; openDatastore: boolean; fail?: boolean; stealLease?: boolean }): string {
  const driver = join(home, `driver-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(driver, `import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
const log = ${JSON.stringify(join(home, 'orchestrator.log'))};
mock.module(${JSON.stringify(join(REPO, 'src/commands/migrations/index.ts'))}, () => ({
  compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  migrations: [{
    version: ${JSON.stringify(VERSION)},
    featurePitch: { headline: 'lock probe' },
    orchestrator: async () => {
      appendFileSync(log, 'start ' + process.pid + '\\n');
      if (${opts.openDatastore}) {
        const { createEngine } = await import(${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))});
        const cfg = JSON.parse(readFileSync(${JSON.stringify(join(home, '.gbrain', 'config.json'))}, 'utf8'));
        const engine = await createEngine(cfg);
        await engine.connect(cfg);
        await engine.disconnect();
        appendFileSync(log, 'opened ' + process.pid + '\\n');
      }
      await new Promise(r => setTimeout(r, ${opts.holdMs}));
      appendFileSync(log, 'end ' + process.pid + '\\n');
      return { version: ${JSON.stringify(VERSION)}, status: ${JSON.stringify(opts.fail ? 'failed' : 'complete')}, phases: [] };
    },
  }, ...(${opts.stealLease === true} ? [{
    version: '0.0.1',
    featurePitch: { headline: 'hands the lease to another holder' },
    orchestrator: async () => {
        const cfg = JSON.parse(readFileSync(${JSON.stringify(join(home, '.gbrain', 'config.json'))}, 'utf8'));
        const { createEngine } = await import(${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))});
        const engine = await createEngine(cfg);
        await engine.connect(cfg);
        await engine.executeRaw("UPDATE gbrain_cycle_locks SET holder_pid=4242, holder_host='host-b', acquisition_token=gen_random_uuid() WHERE id='gbrain-apply-migrations'");
        await engine.disconnect();
      return { version: '0.0.1', status: 'complete', phases: [] };
    },
  }] : [])],
}));
const { runApplyMigrations } = await import(${JSON.stringify(join(REPO, 'src/commands/apply-migrations.ts'))});
await runApplyMigrations(['--yes', '--non-interactive', '--no-autopilot-install']);
process.exit(0);
`);
  return driver;
}

export function spawnDriver(home: string, driver: string) {
  return Bun.spawn([process.execPath, '--no-env-file', driver], {
    cwd: home,
    env: { HOME: home, GBRAIN_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', GBRAIN_SKIP_REFERENCE_SWEEP: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 50));
  }
}

export function logHas(home: string, text: string): boolean {
  const path = join(home, 'orchestrator.log');
  return existsSync(path) && readFileSync(path, 'utf8').includes(text);
}

export async function collect(proc: ReturnType<typeof spawnDriver>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}
