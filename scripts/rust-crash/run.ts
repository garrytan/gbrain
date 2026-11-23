#!/usr/bin/env bun
/**
 * The Rust crash cell (scripts/rust-crash/README.md): real writer processes on real redb files, SIGKILLed at chosen
 * points, then reopened and checked against a PGLite oracle.
 *
 *   bun run rust:build
 *   GBRAIN_RUST_ENGINE_ADDON=<the path it prints> bun scripts/rust-crash/run.ts [--seeds=101,202] [--ops=24]
 *       [--jobs=4] [--engine=pglite] [--plant=early-ack] [--expect-caught] [--keep]
 *
 * For each seed the oracle runs the sequence on PGLite and records the read projection after every operation, and a
 * counting pass runs it in a worker with no kill (its brain must equal the oracle at the end), recording where the
 * store's crash points and the persistence fault points fall. Then nine kills per seed, each on a fresh brain and run
 * `--jobs` at a time: two mid-commit (`write:<n>`), one before an fsync (`sync:<n>`), one after an fsync returned
 * (`synced:<n>`), three at the persistence boundaries that unmanaged writes reach (before and after the publication
 * commits, after the consumer prepared a request), one between operations (after an acknowledgement) and one at a
 * seeded time. After each kill the brain is reopened, the requests the dead writer accepted are finished by the
 * reopened owner, and the brain must equal the oracle after every acknowledged operation, with the operation in flight
 * all there or not there at all. Two operations are several commits by design and may be part-applied: a sync (each
 * file imports on its own) and a remember batch (each item commits on its own); each must finish when run again. Then
 * the rest of the sequence runs on the reopened brain and the end must equal the oracle's end.
 *
 * `--engine=pglite` runs the workers on PGLite (the control arm; the store's crash points exist only on Rust).
 * Exit 0 when every run passed (with --expect-caught: when at least one reopened brain was wrong, see DETECTION); 1 otherwise; 2 on bad usage.
 */
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k!, v ?? 'true'] as const;
}));
const SEEDS = (args.get('seeds') ?? '101,202,303,404,505,606,707,808').split(',').map(Number);
const COUNT = Number(args.get('ops') ?? 24);
const JOBS = Number(args.get('jobs') ?? Math.max(1, Math.min(6, availableParallelism() - 1)));
const ENGINE = args.get('engine') ?? 'rust';
const PLANT = args.get('plant');
const EXPECT_CAUGHT = args.has('expect-caught');
/**
 * The failures that mean the killed brain was wrong, as opposed to the harness failing: the reopened brain differs from
 * every state the oracle allows, or the store refuses to open it because its record file no longer matches its FORMAT
 * (what a commit that never reached the disk leaves behind).
 */
const DETECTION = /^(acknowledged writes lost|the brain equals no oracle state|the \w+ in flight .* did not finish when run again|after the reopen the rest of the sequence diverged|.*FORMAT names a different brain than the record file)/;
const KEEP = args.has('keep');
if (SEEDS.some(s => !Number.isInteger(s)) || !Number.isInteger(COUNT) || COUNT < 4 || !(JOBS >= 1) || !['rust', 'pglite'].includes(ENGINE)) {
  console.error('usage: run.ts [--seeds=101,202] [--ops=24] [--jobs=4] [--engine=pglite] [--plant=early-ack] [--expect-caught] [--keep]');
  process.exit(2);
}
const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON;
if (ENGINE === 'rust' && (!addonPath || !existsSync(addonPath))) {
  console.error('GBRAIN_RUST_ENGINE_ADDON must name a built addon (bun run rust:build prints the path).');
  process.exit(2);
}
/** The persistence fault points (src/core/persistence/fault-points.ts) that unmanaged writes reach. */
const SEAMS = ['publication:before_commit', 'publication:after_commit', 'consumer:prepared'];
/**
 * How long the reopened brain may take to finish the dead writer's requests. A request killed inside its publication
 * waits out its claim lease: the publication ceiling the worker sets (60 s) plus about 65 s.
 */
const DRAIN_MS = 180_000;

// A scratch home: no operator brain or config is read. The store's crash points stay off in this process.
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-rust-crash-'));
const home = join(scratch, 'home');
process.env.GBRAIN_HOME = home;
delete process.env.GBRAIN_TEST_RUST_CRASH_LOG;
delete process.env.GBRAIN_TEST_RUST_CRASH_AT;
const { openRustEngine } = await import('../../src/core/rust-engine.ts');
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { disposePersistenceConsumer, startPersistenceConsumer } = await import('../../src/core/persistence/service.ts');
const { generate, initRepo, pendingWork, project, runOp, rng } = await import('./ops.ts');
const { readLog } = await import('./log.ts');
type LogState = import('./log.ts').LogState;
type Range = import('./log.ts').Range;
type CrashOp = ReturnType<typeof generate>[number];
type BrainEngine = import('../../src/core/engine.ts').BrainEngine;

let addon: Parameters<typeof openRustEngine>[0]['addon'] | null = null;
if (ENGINE === 'rust') {
  const { loadRustEngineAddon } = await import('../../src/core/rust-engine/addon-loader.ts');
  const loaded = await loadRustEngineAddon();
  if (!loaded.ok) {
    console.error(`the Rust addon did not load: ${loaded.message}`);
    process.exit(2);
  }
  addon = loaded.addon;
}
const workerPath = join(import.meta.dir, 'worker.ts');
const canon = (value: unknown) => JSON.stringify(value);

async function openBrain(kind: string, dir: string): Promise<BrainEngine> {
  if (kind === 'pglite') {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dir } as never);
    await engine.initSchema();
    return engine;
  }
  const engine = openRustEngine({ addon: addon!, databasePath: dir }) as unknown as BrainEngine;
  await engine.connect({ engine: 'rust', database_path: dir } as never);
  await engine.initSchema();
  return engine;
}

/** The oracle: the sequence on a PGLite brain in this process, with the projection before and after every operation. */
async function oracle(ops: CrashOp[], dir: string): Promise<string[]> {
  const engine = await openBrain('pglite', join(dir, 'brain'));
  const repo = join(dir, 'repo');
  initRepo(repo);
  const states = [canon(await project(engine, ops))];
  for (let i = 0; i < ops.length; i++) {
    await runOp({ engine, repo }, ops[i]!, i);
    states.push(canon(await project(engine, ops)));
  }
  await engine.disconnect();
  return states;
}

interface Run { brain: string; repo: string; log: string }
let runNumber = 0;
function newRun(seed: number): Run {
  const dir = join(scratch, `seed-${seed}`, `run-${++runNumber}`);
  const run = { brain: join(dir, 'brain'), repo: join(dir, 'repo'), log: join(dir, 'events.log') };
  initRepo(run.repo);
  return run;
}

interface Kill { at?: string; seam?: string; afterAck?: number; afterMs?: number }
/** Starts a worker, kills it as `kill` says (no kill: it runs to the end), and returns what its log says. */
async function runWorker(run: Run, seed: number, kill: Kill = {}): Promise<{ log: LogState; exit: number | null; stderr: string; pid: number }> {
  const extra = [
    ...(ENGINE === 'pglite' ? ['engine', 'pglite'] : []),
    ...(kill.seam !== undefined ? ['seam', kill.seam] : []),
    ...(kill.afterAck !== undefined ? ['freeze-after-ack', String(kill.afterAck)] : []),
    ...(PLANT === 'early-ack' ? ['plant', 'early-ack'] : []),
  ];
  const child = Bun.spawn([process.execPath, workerPath, run.brain, run.repo, String(seed), String(COUNT), run.log, ...extra], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmpdir(), GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: addonPath ? resolve(addonPath) : '',
      GBRAIN_TEST_RUST_CRASH_LOG: run.log, GBRAIN_TEST_RUST_CRASH_AT: kill.at ?? '' },
    stdout: 'ignore', stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const deadline = Date.now() + 180_000;
  let openedAt: number | null = null;
  while (child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(10);
    const log = readLog(run.log);
    if (log.open && openedAt === null) openedAt = Date.now();
    const due = kill.afterMs !== undefined && openedAt !== null && Date.now() - openedAt >= kill.afterMs;
    if (log.freeze || due) break;
  }
  if (child.exitCode === null) child.kill('SIGKILL');
  await child.exited;
  return { log: readLog(run.log), exit: child.exitCode, stderr: await stderr, pid: child.pid };
}

function firstDifference(a: string, b: string): string {
  const left = JSON.parse(a) as { pages: { slug: string }[]; sync: unknown };
  const right = JSON.parse(b) as { pages: { slug: string }[]; sync: unknown };
  for (let i = 0; i < Math.max(left.pages.length, right.pages.length); i++) {
    const l = JSON.stringify(left.pages[i]);
    const r = JSON.stringify(right.pages[i]);
    if (l !== r) return `${left.pages[i]?.slug ?? right.pages[i]?.slug}: brain ${l?.slice(0, 500)} | oracle ${r?.slice(0, 500)}`;
  }
  return `sync source: brain ${JSON.stringify(left.sync)} | oracle ${JSON.stringify(right.sync)}`;
}

const inflight = { absent: 0, present: 0, rerun: 0, none: 0 };

/**
 * Reopens a killed brain and checks it. The dead worker's leases are cleared first, as `sync --break-lock` clears a dead
 * holder's (a lease otherwise outlives its holder for its 30-minute TTL on every engine).
 */
async function check(run: Run, pid: number, ops: CrashOp[], states: string[], log: LogState): Promise<string> {
  const engine = await openBrain(ENGINE, run.brain);
  try {
    for (const lock of await engine.readCycleLocks({ by: 'all' })) {
      if (lock.holder_pid === pid) await engine.deleteCycleLock(lock.id, { holderPid: lock.holder_pid, acquisitionToken: lock.acquisition_token });
    }
    // Requests the dead writer accepted are the brain's to finish: the reopened owner's consumer takes each one over
    // when its claim lease ends, and every one must end committed or refused, and every queued projection rebuild must
    // run, before the brain is compared.
    startPersistenceConsumer(engine, { engine: engine.kind, embedding_disabled: true } as never).wake();
    const deadline = Date.now() + DRAIN_MS;
    for (let pending = await pendingWork(engine); pending.length > 0; pending = await pendingWork(engine)) {
      if (Date.now() > deadline) throw new Error(`the work the dead writer left did not finish within ${DRAIN_MS / 1000} s: ${JSON.stringify(pending).slice(0, 300)}`);
      await Bun.sleep(250);
    }
    const now = canon(await project(engine, ops));
    const acked = log.acked;
    const flying = log.started > acked ? log.started : null;
    const partial = flying !== null && (ops[flying]!.kind === 'sync' || (ops[flying]!.kind === 'remember' && (ops[flying] as { facts: string[] }).facts.length > 1));
    let next: number;
    let how: keyof typeof inflight;
    if (now === states[acked + 1]) { next = acked + 1; how = flying === null ? 'none' : 'absent'; }
    else if (flying !== null && now === states[flying + 1]) { next = flying + 1; how = 'present'; }
    else if (partial) {
      await runOp({ engine, repo: run.repo }, ops[flying!]!, flying!);
      const after = canon(await project(engine, ops));
      if (after !== states[flying! + 1]) throw new Error(`the ${ops[flying!]!.kind} in flight (op ${flying}) did not finish when run again: ${firstDifference(after, states[flying! + 1]!)}`);
      next = flying! + 1; how = 'rerun';
    } else {
      const lost = states.findIndex(s => s === now);
      if (lost >= 0 && lost <= acked) throw new Error(`acknowledged writes lost: the brain equals the oracle after op ${lost - 1}, but ops through ${acked} were acknowledged`);
      throw new Error(`the brain equals no oracle state (ops through ${acked} acknowledged, op ${flying ?? 'none'} in flight): ${firstDifference(now, states[acked + 1]!)}`);
    }
    inflight[how]++;
    for (let i = next; i < ops.length; i++) await runOp({ engine, repo: run.repo }, ops[i]!, i);
    const end = canon(await project(engine, ops));
    if (end !== states[ops.length]) throw new Error(`after the reopen the rest of the sequence diverged: ${firstDifference(end, states[ops.length]!)}`);
    return `acked ${acked}, in flight ${flying ?? '-'} ${how}`;
  } finally {
    await disposePersistenceConsumer(engine).catch(() => undefined);
    await engine.disconnect();
  }
}

interface Outcome { seed: number; point: string; ok: boolean; detail: string }
const outcomes: Outcome[] = [];
const tally = { write: 0, sync: 0, synced: 0, seam: 0, ack: 0, timer: 0 };
interface Job { seed: number; label: string; kind: keyof typeof tally; kill: Kill; ops: CrashOp[]; states: string[] }
const jobs: Job[] = [];

const started = performance.now();
console.log(`Rust crash cell (${ENGINE} workers): seeds ${SEEDS.join(',')}, ${COUNT} seeded ops per sequence, ${JOBS} at a time${PLANT ? `, planted bug ${PLANT}` : ''}`);
for (const seed of SEEDS) {
  const ops = generate(seed, COUNT);
  const states = await oracle(ops, join(scratch, `seed-${seed}`, 'oracle'));
  const counting = newRun(seed);
  const pass = await runWorker(counting, seed);
  if (!pass.log.done || pass.log.error) {
    outcomes.push({ seed, point: 'no kill', ok: false, detail: `the run did not finish: ${pass.log.error ?? `exit ${pass.exit}`} ${pass.stderr.slice(-400)}` });
    continue;
  }
  const engine = await openBrain(ENGINE, counting.brain);
  const end = canon(await project(engine, ops));
  await engine.disconnect();
  const equal = end === states[ops.length];
  outcomes.push({ seed, point: 'no kill', ok: equal, detail: equal ? 'equal to the oracle' : firstDifference(end, states[ops.length]!) });
  const rand = rng(seed * 7919);
  const within = (range: Range | null | undefined) => (range ? range[0] + Math.floor(rand() * (range[1] - range[0] + 1)) : null);
  for (const kind of ENGINE === 'rust' ? ['write', 'write', 'sync', 'synced'] as const : []) {
    const n = within(pass.log.events[kind]);
    if (n !== null) jobs.push({ seed, label: `${kind}:${n}`, kind, kill: { at: `${kind}:${n}` }, ops, states });
  }
  for (const point of SEAMS) {
    const n = within(pass.log.seams.get(point));
    if (n !== null) jobs.push({ seed, label: `${point}:${n}`, kind: 'seam', kill: { seam: `${point}:${n}` }, ops, states });
  }
  const afterAck = Math.floor(rand() * (ops.length - 1));
  jobs.push({ seed, label: `after ack ${afterAck}`, kind: 'ack', kill: { afterAck }, ops, states });
  const afterMs = 50 + Math.floor(rand() * 1500);
  jobs.push({ seed, label: `timer ${afterMs} ms`, kind: 'timer', kill: { afterMs }, ops, states });
}

async function runJob(job: Job): Promise<void> {
  const run = newRun(job.seed);
  try {
    const result = await runWorker(run, job.seed, job.kill);
    if (result.log.error) throw new Error(`the worker failed before the kill: ${result.log.error}`);
    if (!result.log.freeze && job.kind !== 'timer') throw new Error(`the worker never reached ${job.label} (exit ${result.exit}) ${result.stderr.slice(-300)}`);
    tally[job.kind]++;
    outcomes.push({ seed: job.seed, point: job.label, ok: true, detail: await check(run, result.pid, job.ops, job.states, result.log) });
  } catch (error) {
    outcomes.push({ seed: job.seed, point: job.label, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}
let nextJob = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (nextJob < jobs.length) await runJob(jobs[nextJob++]!);
}));

outcomes.sort((a, b) => a.seed - b.seed);
for (const o of outcomes) console.log(`  ${o.ok ? 'ok  ' : 'FAIL'}  seed ${o.seed}  ${o.point.padEnd(30)} ${o.detail}`);
const failed = outcomes.filter(o => !o.ok);
const kills = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} runs passed: ${SEEDS.length} seeds, ${kills} SIGKILLs ` +
  `(mid-commit ${tally.write}, before fsync ${tally.sync}, after fsync ${tally.synced}, persistence boundary ${tally.seam}, ` +
  `between operations ${tally.ack}, timed ${tally.timer}); in flight at the kill: absent ${inflight.absent}, present ${inflight.present}, ` +
  `part-applied and finished on rerun ${inflight.rerun}, none ${inflight.none}; ${((performance.now() - started) / 1000).toFixed(0)} s`);
if (KEEP) console.log(`kept ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
if (EXPECT_CAUGHT) {
  // A planted bug is caught only when a run reopened the killed brain and found it wrong (see DETECTION). A worker that never started,
  // a kill point that was never reached or a drain that timed out says nothing about durability.
  const detected = failed.filter(o => DETECTION.test(o.detail));
  console.log(detected.length > 0
    ? `the planted bug was caught by ${detected.length} run(s)${failed.length > detected.length ? ` (${failed.length - detected.length} other failed run(s) were not counted)` : ''}`
    : `the planted bug was NOT caught (${failed.length} run(s) failed, none by a wrong or damaged brain after the kill)`);
  process.exit(detected.length > 0 ? 0 : 1);
}
process.exit(failed.length === 0 ? 0 : 1);
