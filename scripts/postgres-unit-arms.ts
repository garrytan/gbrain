#!/usr/bin/env bun
/**
 * test/postgres-unit-arms.txt: the unit-lane suites whose PostgreSQL arm runs
 * only in persistence-validation's `unit-postgres-arms` job and the race hunt.
 *
 *   bun scripts/postgres-unit-arms.ts list                     every listed path
 *   bun scripts/postgres-unit-arms.ts shard <n> <m> [--postgres-only]
 *                                                              shard n of m, balanced by measured runtime
 *   bun scripts/postgres-unit-arms.ts run <n> <m> [--postgres-only]
 *                                                              run shard n of m, one file per worker at a time
 *   bun scripts/postgres-unit-arms.ts mine [--postgres-only] <job.log>…
 *                                                              rewrite the cell's weights from unit-postgres-arms job logs
 *
 * `run` starts one worker per URL in GBRAIN_ARM_DATABASE_URLS (space-separated,
 * one PostgreSQL server each; the job runs ARM_WORKERS). Workers take files
 * heaviest first from one queue, one Bun process per file with DATABASE_URL set
 * to the worker's server; each file's output is buffered and printed in queue
 * order inside a `::group::` block that ends with an `ARM_FILE` line carrying
 * its measured duration. With GBRAIN_TEST_RECEIPT_DIR set, each file writes its
 * own executed-test receipt (scripts/lib/test-env.sh describes the format).
 * `--postgres-only` (the Bun 1.4.3 cell) sets GBRAIN_TEST_BACKEND=postgres, so
 * testBackends() suites run only their PostgreSQL side; their PGLite side runs
 * in the unit and serial lanes, and files that read DATABASE_URL directly keep
 * both arms.
 *
 * Weights are milliseconds per file mined from the `ARM_FILE` lines, so they
 * time each file beside another one, as the job runs it (a file ran 1.2-1.5x
 * its solo time on a 4-vCPU runner); older logs time each `::group::<file>`
 * timestamp to the next group or endgroup. The both-arms cell reads
 * ARM_WEIGHTS, the PostgreSQL-only cell ARM_WEIGHTS_POSTGRES_ONLY. A file
 * without a weight gets the p75 (scripts/sharding.ts).
 * test/scripts/postgres-unit-arms.test.ts fails when a shard's two-worker
 * makespan passes ARM_SHARD_BUDGET_MS, and ci:ubicloud's pg-arms lane fails
 * when a shard's measured makespan passes the step timeout
 * (scripts/ubicloud/README.md).
 * Docs: docs/TESTING.md#postgres-arm-lanes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadWeights, partition, type WeightMap } from './sharding.ts';

export const ARMS_LIST = 'test/postgres-unit-arms.txt';
export const ARM_WEIGHTS = 'scripts/postgres-arm-weights.json';
export const ARM_WEIGHTS_POSTGRES_ONLY = 'scripts/postgres-arm-weights-postgres-only.json';
/** persistence-validation's unit-postgres-arms matrix size; test/scripts/postgres-unit-arms.test.ts pins the workflow to it. */
export const ARM_SHARDS = 12;
/** Files run at once per job, each against its own PostgreSQL service; the workflow lists one URL per worker. */
export const ARM_WORKERS = 2;
/** The workflow step's `timeout-minutes: 20`: a shard whose files run longer is cut off mid-list. */
export const ARM_STEP_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * A shard's two-worker makespan may be at most this: on a runner twice as slow as the mined weights (Bun 1.4.0
 * runners measured 1.3-2x) it still ends a minute inside the step timeout.
 */
export const ARM_SHARD_BUDGET_MS = (ARM_STEP_TIMEOUT_MS - 60_000) / 2;
/** Each file's command; ci:ubicloud's pg-arms lane (scripts/ubicloud/ci-item.sh) runs the same one. */
export const ARM_TEST_COMMAND = ['bun', '--no-env-file', 'test', '--timeout=120000'];
const DOCS = 'docs/TESTING.md#postgres-arm-lanes';
const PATH_RE = /^test\/[\w./-]+\.test\.ts$/;

export interface ArmsList { files: string[]; errors: string[] }

/** Parse the list; every malformed, duplicate or unsorted row is an error naming its line. */
export function parseArmsList(text: string): ArmsList {
  const files: string[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (!PATH_RE.test(line)) errors.push(`${ARMS_LIST}:${i + 1}: "${line}" is not a repo-relative test/…/*.test.ts path`);
    else if (files.includes(line)) errors.push(`${ARMS_LIST}:${i + 1}: ${line} is listed twice`);
    else if (files.length && files[files.length - 1]! > line) errors.push(`${ARMS_LIST}:${i + 1}: ${line} is out of sorted order (insert it after the last path that sorts before it)`);
    files.push(line);
  });
  return { files: [...new Set(files)], errors };
}

/** A missing list is empty: the lane guard then reports every gated arm as unlaned. */
export function readArmsList(root: string): ArmsList {
  const path = join(root, ARMS_LIST);
  if (!existsSync(path)) return { files: [], errors: [] };
  return parseArmsList(readFileSync(path, 'utf8'));
}

/**
 * Per-file durations from GitHub job logs, the median across logs. A log with
 * `ARM_FILE file=… ms=…` lines is read from those alone: its groups print when a
 * file's buffered output is flushed, so their timestamps time nothing. An older
 * log times each `##[group]<file>` line to the next group or endgroup. The
 * median balances shards on a typical run; one slow runner's outlier would
 * otherwise set a file's weight (a max did, and pushed most of the slow suites
 * into one shard).
 */
export function mineArmWeights(logs: string[]): Map<string, number> {
  const samples = new Map<string, number[]>();
  const add = (file: string, ms: number) => samples.set(file, [...(samples.get(file) ?? []), ms]);
  for (const log of logs) {
    const explicit = [...log.matchAll(/ARM_FILE file=(test\/[\w./-]+\.test\.ts) worker=\d+ ms=(\d+) rc=\d+/g)];
    if (explicit.length) {
      for (const m of explicit) add(m[1]!, Number(m[2]));
      continue;
    }
    let open: { file: string; at: number } | undefined;
    for (const line of log.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(?:##\[group\]|::group::)(test\/[\w./-]+\.test\.ts)\s*$/.exec(line);
      const end = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+##\[endgroup\]/.exec(line);
      const at = m ? Date.parse(m[1]!) : end ? Date.parse(end[1]!) : NaN;
      if (!Number.isFinite(at) || (!m && !open)) continue;
      if (open && (m || end)) {
        add(open.file, at - open.at);
        open = undefined;
      }
      if (m) open = { file: m[2]!, at };
    }
  }
  return new Map([...samples].map(([file, ms]) => {
    const sorted = [...ms].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return [file, sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)];
  }));
}

/** The cell's weights: the PostgreSQL-only cell falls back to the both-arms weights until its own are mined. */
export function armWeights(root: string, postgresOnly: boolean): WeightMap {
  const own = join(root, ARM_WEIGHTS_POSTGRES_ONLY);
  return loadWeights(postgresOnly && existsSync(own) ? own : join(root, ARM_WEIGHTS));
}

/** Shard n of m (1-based), as persistence-validation's unit-postgres-arms matrix runs it and ci:ubicloud's pg-arms lane reports it. */
export function armShards(root: string, files: string[], m: number, postgresOnly = false): string[][] {
  return partition(files, armWeights(root, postgresOnly), m).map(shard => [...shard].sort());
}

/** A shard's files in the order the workers take them: heaviest first (LPT), ties by path. */
export function armQueue(files: string[], weight: (file: string) => number): string[] {
  return [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
}

/** When the last of `workers` workers finishes `files`, each taking the next queued file when it frees up. */
export function armMakespan(files: string[], weight: (file: string) => number, workers = ARM_WORKERS): number {
  const busy = new Array<number>(workers).fill(0);
  for (const file of armQueue(files, weight)) busy[busy.indexOf(Math.min(...busy))] += weight(file);
  return Math.max(...busy);
}

interface FileRun { file: string; worker: number; ms: number; rc: number; out: string }

/** One executed-test receipt per file, as scripts/lib/test-env.sh receipt_begin writes it. */
function beginReceipt(dir: string, lane: string, shard: number, of: number, file: string): string {
  const base = `${lane}--s${shard}-${basename(file, '.ts')}--primary`;
  let id = base;
  for (let n = 2; existsSync(join(dir, `${id}.receipt`)); n++) id = `${base}-${n}`;
  const sha = process.env.GITHUB_SHA || (Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim() || 'unknown');
  const meta = {
    version: 1, lane, kind: 'primary', tag: `s${shard}-${basename(file, '.ts')}`, shard, of, arm: 'postgres', sha, root: process.cwd(),
    run_id: process.env.GITHUB_RUN_ID ?? '', run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '', job: process.env.GITHUB_JOB ?? '',
    started: Math.floor(Date.now() / 1000),
  };
  writeFileSync(join(dir, `${id}.receipt`), Object.entries(meta).map(([k, v]) => `${k}=${v}\n`).join(''));
  writeFileSync(join(dir, `${id}.files`), `${file}\n`);
  return id;
}

async function run(root: string, shard: number, of: number, postgresOnly: boolean): Promise<number> {
  const urls = (process.env.GBRAIN_ARM_DATABASE_URLS ?? '').split(/\s+/).filter(Boolean);
  if (!urls.length) {
    console.error(`::error::GBRAIN_ARM_DATABASE_URLS is empty. Why: each worker runs its files against its own PostgreSQL server. Fix: list one URL per worker (the job runs ${ARM_WORKERS}). Docs: ${DOCS}`);
    return 2;
  }
  const weights = armWeights(root, postgresOnly);
  const fallback = [...weights.values()].sort((a, b) => a - b)[Math.floor(weights.size * 0.75)] ?? 1;
  const files = armQueue(armShards(root, readArmsList(root).files, of, postgresOnly)[shard - 1] ?? [], f => weights.get(f) ?? fallback);
  if (!files.length) {
    console.error(`::error::shard ${shard}/${of} selected no files from ${ARMS_LIST}. Why: an empty shard would pass without running any PostgreSQL arm. Fix: run 'bun scripts/postgres-unit-arms.ts shard ${shard} ${of}' locally and correct the list. Docs: ${DOCS}`);
    return 1;
  }
  const receiptDir = process.env.GBRAIN_TEST_RECEIPT_DIR ?? '';
  if (receiptDir) mkdirSync(receiptDir, { recursive: true });
  const lane = process.env.GBRAIN_TEST_RECEIPT_LANE || 'pg-arms';
  const env: Record<string, string | undefined> = { ...process.env, ...(postgresOnly ? { GBRAIN_TEST_BACKEND: 'postgres' } : {}) };
  for (const name of ['GBRAIN_TEST_RECEIPT_DIR', 'GBRAIN_TEST_RECEIPT_LANE', 'GBRAIN_ARM_DATABASE_URLS']) delete env[name];
  const workers = Math.min(urls.length, files.length);
  console.log(`postgres-unit-arms: shard ${shard}/${of}, ${files.length} files, ${workers} workers${postgresOnly ? ', PostgreSQL side only (GBRAIN_TEST_BACKEND=postgres)' : ''}`);

  const results: Array<FileRun | undefined> = new Array(files.length);
  const running = new Map<number, { file: string; worker: number; chunks: Buffer[] }>();
  let next = 0;
  let printed = 0;
  const started = Date.now();
  const busy = new Array<number>(workers).fill(0);
  const flush = () => {
    for (; printed < files.length && results[printed]; printed++) {
      const r = results[printed]!;
      process.stdout.write(`::group::${r.file}\n${r.out}${r.out.endsWith('\n') || !r.out ? '' : '\n'}ARM_FILE file=${r.file} worker=${r.worker} ms=${r.ms} rc=${r.rc}\n::endgroup::\n`);
    }
  };
  const runFile = (i: number, worker: number) => new Promise<FileRun>(resolve => {
    const file = files[i]!;
    const id = receiptDir ? beginReceipt(receiptDir, lane, shard, of, file) : '';
    const args = [...ARM_TEST_COMMAND.slice(1), ...(id ? ['--reporter=junit', `--reporter-outfile=${join(receiptDir, `${id}.junit.xml`)}`] : []), file];
    const chunks: Buffer[] = [];
    running.set(i, { file, worker, chunks });
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { env: { ...env, DATABASE_URL: urls[worker] }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => chunks.push(c));
    const done = (rc: number, note = '') => {
      running.delete(i);
      if (id) writeFileSync(join(receiptDir, `${id}.receipt`), `exit=${rc}\n`, { flag: 'a' });
      resolve({ file, worker, ms: Date.now() - t0, rc, out: Buffer.concat(chunks).toString('utf8') + note });
    };
    child.on('error', error => done(127, `postgres-unit-arms: could not start bun: ${error.message}\n`));
    child.on('close', (code, signal) => done(code ?? 1, signal ? `postgres-unit-arms: bun ended on ${signal}\n` : ''));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      flush();
      for (const r of running.values()) process.stdout.write(`::group::${r.file} (interrupted)\n${Buffer.concat(r.chunks).toString('utf8')}\n::endgroup::\n`);
      console.log(`::error::shard ${shard}/${of} stopped on ${signal} with ${files.length - printed} file(s) unfinished; the step timeout (${ARM_STEP_TIMEOUT_MS / 60_000} minutes) or a cancellation ended it.`);
      process.exit(130);
    });
  }
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    while (next < files.length) {
      const i = next++;
      const r = await runFile(i, worker);
      busy[worker] += r.ms;
      results[i] = r;
      flush();
    }
  }));
  const failed = results.filter(r => r!.rc !== 0).map(r => r!.file);
  const backend = postgresOnly ? 'GBRAIN_TEST_BACKEND=postgres ' : '';
  for (const file of failed) console.log(`::error file=${file}::PostgreSQL arm failed. Reproduce: DATABASE_URL=<pgvector test database> GBRAIN_TEST_ALLOW_DATABASE_URL=1 ${backend}${ARM_TEST_COMMAND.join(' ')} ${file}`);
  console.log(`ARM_SHARD shard=${shard}/${of} workers=${workers} files=${files.length} wall_ms=${Date.now() - started} busy_ms=${busy.join(',')} failed=${failed.length}`);
  return failed.length ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const root = join(import.meta.dir, '..');
  const postgresOnly = argv.includes('--postgres-only');
  const [command, ...rest] = argv.filter(a => a !== '--postgres-only');
  const list = readArmsList(root);
  if (command !== 'mine' && list.errors.length) {
    console.error(`${list.errors.join('\n')}\n  Why: the Postgres-arm lanes read this list; a bad row would drop or duplicate an arm.\n  Fix: correct the named line in ${ARMS_LIST}\n  Docs: ${DOCS}`);
    return 1;
  }
  if (command === 'list') {
    console.log(list.files.join('\n'));
    return 0;
  }
  if (command === 'shard' || command === 'run') {
    const [n, m] = rest.map(Number);
    if (rest.length !== 2 || !Number.isInteger(n) || !Number.isInteger(m) || n! < 1 || n! > m!) {
      console.error(`usage: bun scripts/postgres-unit-arms.ts ${command} <n> <m> [--postgres-only]   (1 <= n <= m)`);
      return 2;
    }
    if (command === 'run') return run(root, n!, m!, postgresOnly);
    console.log(armShards(root, list.files, m!, postgresOnly)[n! - 1]!.join('\n'));
    return 0;
  }
  if (command === 'mine' && rest.length) {
    const target = postgresOnly ? ARM_WEIGHTS_POSTGRES_ONLY : ARM_WEIGHTS;
    const mined = mineArmWeights(rest.map(path => readFileSync(path, 'utf8')));
    const sorted = Object.fromEntries([...mined].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(join(root, target), `${JSON.stringify(sorted, null, 2)}\n`);
    const missing = list.files.filter(f => !mined.has(f));
    console.log(`postgres-arm weights: ${mined.size} files mined into ${target}${missing.length ? `; no timing for ${missing.join(', ')}` : ''}`);
    return 0;
  }
  console.error('usage: bun scripts/postgres-unit-arms.ts list | shard <n> <m> [--postgres-only] | run <n> <m> [--postgres-only] | mine [--postgres-only] <job.log>…');
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
