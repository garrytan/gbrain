#!/usr/bin/env bun
// #5449 large-store harness supervisor. Runs outside the default CI shards.
//
// It creates (or reuses) a PGLite store, optionally scales shared_buffers and
// max_wal_size down with ALTER SYSTEM so a small machine exercises the same
// eviction-plus-inline-checkpoint path as a multi-GB store, then spawns the
// worker as a separate process and watches it from outside: worker CPU from
// /proc, committed-page progress from the worker's progress file, WAL volume
// and checkpoint activity from the data directory. A wedge is a worker that
// burns CPU with no committed page and no checkpoint progress for
// --stall-sec. The run fails on a wedge, on the --timeout-sec cap, or when WAL
// written since the last redo ever exceeds the guard threshold plus the
// largest single transaction.
//
//   bun scripts/pglite-checkpoint-harness/supervisor.ts --dir /tmp/h --pages 3000 \
//     --shared-buffers 16MB --max-wal-size 32MB --stall-sec 120 --timeout-sec 1800
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { checkpointGuardThreshold } from '../../src/core/pglite-engine/checkpoint-guard.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const dir = resolve(arg('dir', '/tmp/gbrain-5449-harness'));
const pages = Number(arg('pages', '3000'));
const pageKb = Number(arg('page-kb', '40'));
const sharedBuffers = arg('shared-buffers', '');
const maxWalSize = arg('max-wal-size', '');
const stallSec = Number(arg('stall-sec', '600'));
const timeoutSec = Number(arg('timeout-sec', '1800'));
const fresh = process.argv.includes('--fresh');
const expectWedge = process.argv.includes('--expect-wedge');
const dataDir = join(dir, 'brain.pglite');
const progressPath = join(dir, 'progress.ndjson');

function dirBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? dirBytes(full) : statSync(full).size;
  }
  return total;
}
function cpuTicks(pid: number): number | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch { return null; }
}
function readProgress(): Array<Record<string, number | boolean | string>> {
  if (!existsSync(progressPath)) return [];
  return readFileSync(progressPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

if (fresh) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let startIndex = 0;
if (existsSync(progressPath)) {
  const prior = readProgress().filter(row => typeof row.i === 'number');
  startIndex = prior.length ? Number(prior[prior.length - 1]!.i) + 1 : 0;
}
writeFileSync(progressPath, '');

const settings = await (async () => {
  const db = await PGlite.create({ dataDir });
  if (sharedBuffers) await db.query(`ALTER SYSTEM SET shared_buffers = '${sharedBuffers}'`);
  if (maxWalSize) {
    await db.query(`ALTER SYSTEM SET max_wal_size = '${maxWalSize}'`);
    await db.query(`ALTER SYSTEM SET min_wal_size = '${maxWalSize}'`);
  }
  await db.close();
  const check = await PGlite.create({ dataDir });
  const read = async (name: string) => (await check.query<{ v: string }>(`SELECT current_setting('${name}') AS v`)).rows[0]!.v;
  const bytes = async (name: string) => Number((await check.query<{ b: string }>(`SELECT pg_size_bytes(current_setting('${name}'))::text AS b`)).rows[0]!.b);
  const out = {
    shared_buffers: await read('shared_buffers'), max_wal_size: await read('max_wal_size'),
    shared_buffers_bytes: await bytes('shared_buffers'), max_wal_size_bytes: await bytes('max_wal_size'),
    wal_segment_bytes: await bytes('wal_segment_size'),
    checkpoint_completion_target: Number(await read('checkpoint_completion_target')),
  };
  await check.close();
  return out;
})();
const checkpointSegments = Math.max(1, Math.floor(settings.max_wal_size_bytes / (settings.wal_segment_bytes * (1 + settings.checkpoint_completion_target))));
const autoCheckpointBytes = (checkpointSegments - 1) * settings.wal_segment_bytes;
const guardThresholdBytes = checkpointGuardThreshold(settings.max_wal_size_bytes, settings.wal_segment_bytes, settings.checkpoint_completion_target);
const storeBytesAtStart = dirBytes(dataDir);
console.log(JSON.stringify({ event: 'start', dir, pages, page_kb: pageKb, start_index: startIndex, ...settings,
  auto_checkpoint_bytes: Math.round(autoCheckpointBytes), guard_threshold_bytes: Math.round(guardThresholdBytes),
  store_bytes: storeBytesAtStart, store_to_shared_buffers: +(storeBytesAtStart / settings.shared_buffers_bytes).toFixed(1) }));

const child = spawn(process.execPath, [join(import.meta.dir, 'worker.ts'), dataDir, progressPath, String(pages), String(startIndex), String(pageKb)],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
const clk = 100;
const started = Date.now();
let lastProgressCount = 0, lastProgressAt = Date.now();
let lastControlMtime = statSync(join(dataDir, 'global', 'pg_control')).mtimeMs, lastCheckpointAt = Date.now();
let lastCpu = cpuTicks(child.pid!) ?? 0, lastSample = Date.now();
let exitCode: number | null | undefined;
child.on('exit', code => { exitCode = code; });

type Verdict = { verdict: 'wedged' | 'completed' | 'timeout' | 'worker_failed'; detail: Record<string, unknown> };
const verdict: Verdict = await new Promise(resolveVerdict => {
  const timer = setInterval(() => {
    const now = Date.now();
    const rows = readProgress();
    const committed = rows.filter(row => typeof row.i === 'number');
    const done = rows.some(row => row.done === true);
    const cpu = cpuTicks(child.pid!);
    const cpuPct = cpu === null ? 0 : ((cpu - lastCpu) / clk) / ((now - lastSample) / 1000) * 100;
    if (cpu !== null) lastCpu = cpu;
    lastSample = now;
    const controlMtime = existsSync(join(dataDir, 'global', 'pg_control')) ? statSync(join(dataDir, 'global', 'pg_control')).mtimeMs : lastControlMtime;
    if (controlMtime !== lastControlMtime) { lastControlMtime = controlMtime; lastCheckpointAt = now; }
    if (committed.length !== lastProgressCount) { lastProgressCount = committed.length; lastProgressAt = now; }
    const last = committed[committed.length - 1];
    const sample = { t_sec: Math.round((now - started) / 1000), committed: committed.length, cpu_pct: Math.round(cpuPct),
      wal_dir_bytes: dirBytes(join(dataDir, 'pg_wal')), store_bytes: dirBytes(dataDir),
      wal_since_redo: last?.since_redo ?? null, stall_sec: Math.round((now - lastProgressAt) / 1000),
      checkpoint_idle_sec: Math.round((now - lastCheckpointAt) / 1000) };
    if (sample.t_sec % 10 === 0) console.log(JSON.stringify({ event: 'sample', ...sample }));
    const finish = (v: Verdict['verdict']) => {
      clearInterval(timer);
      if (exitCode === undefined) child.kill('SIGKILL');
      resolveVerdict({ verdict: v, detail: { ...sample, exit_code: exitCode ?? null } });
    };
    if (done && exitCode !== undefined) return finish('completed');
    if (exitCode !== undefined && !done) return finish('worker_failed');
    if (now - lastProgressAt >= stallSec * 1000 && now - lastCheckpointAt >= stallSec * 1000 && cpuPct >= 80) return finish('wedged');
    if (now - started >= timeoutSec * 1000) return finish('timeout');
  }, 1000);
});

const committed = readProgress().filter(row => typeof row.i === 'number') as Array<{ i: number; since_redo: number; lsn: string }>;
const lsnBytes = (lsn: string) => { const [hi, lo] = lsn.split('/'); return parseInt(hi!, 16) * 2 ** 32 + parseInt(lo!, 16); };
let maxTransactionWal = 0, maxSinceRedo = 0;
for (let k = 0; k < committed.length; k++) {
  maxSinceRedo = Math.max(maxSinceRedo, committed[k]!.since_redo);
  if (k > 0) maxTransactionWal = Math.max(maxTransactionWal, lsnBytes(committed[k]!.lsn) - lsnBytes(committed[k - 1]!.lsn));
}
const walBound = guardThresholdBytes + maxTransactionWal;
const walWithinBound = maxSinceRedo <= walBound;
const report = { event: 'result', ...verdict, committed: committed.length, max_wal_since_redo: maxSinceRedo,
  max_transaction_wal: maxTransactionWal, wal_bound: Math.round(walBound), wal_within_bound: walWithinBound,
  elapsed_sec: Math.round((Date.now() - started) / 1000) };
console.log(JSON.stringify(report));
writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
if (expectWedge) process.exit(verdict.verdict === 'wedged' ? 0 : 1);
process.exit(verdict.verdict === 'completed' && walWithinBound ? 0 : 1);
