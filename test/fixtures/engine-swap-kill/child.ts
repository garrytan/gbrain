/**
 * The process test/engine-swap-kill.serial.test.ts kills. One brain world under `home` (a file-backed PGLite primary at
 * `home/.gbrain/brain.pglite`, a seeded Rust store under `home/shadow`), and one mode per run:
 *
 *   run <home> <state>   opens the world (seeding the store on first open), starts a swap and SIGKILLs itself just before
 *                        the run records `<state>`: no cleanup, no finally block, no flush;
 *   resume <home>        reopens the world without reseeding and resumes the recorded run, as `--resume` does;
 *   inspect <home>       prints the brain as each engine holds it (JSON on stdout): the config's engine, the record's
 *                        state, whether the primary is fenced, and every live page slug with its row count on both sides.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { loadRustAddon } from '../../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../../src/core/rust-engine.ts';
import { openReadSource } from '../../../src/shadow/read-pool.ts';
import { runSwapStates, startRecord, type SwapRunDeps } from '../../../src/core/engine-swap/run.ts';
import { readSwapRecord, type SwapState } from '../../../src/core/engine-swap/record.ts';
import { primaryFenced } from '../../../src/core/engine-swap/fence.ts';
import { registerGraduationRunInProcess } from '../../../src/core/persistence/graduation-custody.ts';
import { readSeedRecord } from '../../../src/shadow/seed.ts';
import { openFollowRig } from '../../helpers/follow-rig.ts';

const [mode, home, killAt] = process.argv.slice(2) as [string, string, SwapState | undefined];
const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON!;
const dbPath = join(home, '.gbrain', 'brain.pglite');
const shadowDir = join(home, 'shadow');
const recordPath = join(home, '.gbrain', 'engine-swap', 'pglite-test', 'run.json');
process.env.GBRAIN_HOME = home; // this process only: the authority switch rewrites this world's config

async function openPrimary(): Promise<PGLiteEngine> {
  const record = existsSync(recordPath) ? readSwapRecord(recordPath) : null;
  if (record) registerGraduationRunInProcess(record.run_id); // a fenced primary admits only the run's own connection
  const primary = new PGLiteEngine();
  await primary.connect({ engine: 'pglite', database_path: dbPath });
  return primary;
}

async function swap(resume: boolean): Promise<void> {
  const primary = await openPrimary();
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
  const rig = await openFollowRig(primary, addon, shadowDir, 'pglite', { reuseSeed: !!readSeedRecord(shadowDir) });
  const reads = openReadSource(primary, { pauseMs: 0 });
  const deps: SwapRunDeps = {
    primary, config: { engine: 'pglite', database_path: dbPath } as never, brainKey: 'pglite-test', shadowDir,
    rustStore: join(shadowDir, 'store'), hostId: '00000000-0000-4000-8000-000000000001',
    openRust: async () => ({ rpc: rig.rpc, reads, close: async () => undefined }),
    prober: async () => ({ effective_engine: 'rust', database_path: join(shadowDir, 'store'), ok: true }),
    routeCheck: () => null, recordPath, intervalRows: 2,
    beforeState: (s) => { if (!resume && s === killAt) process.kill(process.pid, 'SIGKILL'); },
  };
  const record = resume ? readSwapRecord(recordPath)! : startRecord(deps, 'planhash', 'policyhash');
  const done = await runSwapStates(record, deps);
  await rig.close();
  await primary.disconnect();
  process.stdout.write(JSON.stringify({ state: done.state }) + '\n');
}

async function inspect(): Promise<void> {
  const record = existsSync(recordPath) ? readSwapRecord(recordPath) : null;
  const primary = await openPrimary();
  const count = async (e: { executeRaw: (sql: string) => Promise<Array<{ slug: string; n: number }>> }) =>
    Object.fromEntries((await e.executeRaw(`SELECT slug, count(*)::int AS n FROM pages WHERE deleted_at IS NULL GROUP BY slug ORDER BY slug`)).map(r => [r.slug, Number(r.n)]));
  const primaryPages = await count(primary as never);
  const fenced = record ? await primaryFenced(primary, record.run_id) : false;
  await primary.disconnect();
  let rustPages: Record<string, number> | null = null;
  const store = join(shadowDir, 'store');
  if (existsSync(store)) {
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
    const rust = openRustEngine({ addon, databasePath: store });
    await rust.connect({ engine: 'pglite', database_path: store } as never);
    const refs = await (rust as unknown as { listAllPageRefs(): Promise<Array<{ slug: string }>> }).listAllPageRefs();
    rustPages = {};
    for (const r of refs) rustPages[r.slug] = (rustPages[r.slug] ?? 0) + 1;
    await rust.disconnect();
  }
  const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')) as { engine: string };
  process.stdout.write(JSON.stringify({ engine: config.engine, state: record?.state ?? null, fenced, primaryPages, rustPages }) + '\n');
}

await (mode === 'run' ? swap(false) : mode === 'resume' ? swap(true) : inspect());
process.exit(0);
