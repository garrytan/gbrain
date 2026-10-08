#!/usr/bin/env bun
/**
 * Order hunt: run the E2E corpus in a seeded random order on one shared
 * Postgres database to catch tests that leak state into the next file (a
 * config row left at teardown, a session setting, leftover pages). Per-iteration
 * fresh databases (the stress gate, the race hunt) cannot see this class.
 *
 *   bun scripts/order-hunt.ts plan --seed N --shard K --of M
 *     prints this shard's files, one per line, in run order: the run-e2e.sh
 *     corpus shuffled by the seed, then dealt round-robin into M shards.
 *   bun scripts/order-hunt.ts classify --order FILE --log FILE
 *     reads the ordered file list and run-e2e.sh's log, reruns each failing
 *     file alone, and reports a file that passes alone as order-dependent with
 *     the exact reproduce command. Exit 1 only for order-dependent failures; a
 *     file that also fails alone is a plain failure the other lanes report.
 *
 * Docs: docs/ci-red-runbook.md#order-hunt
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DOCS = 'docs/ci-red-runbook.md#order-hunt';

/** mulberry32: small, deterministic, good enough to shuffle a file list. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planShard(files: readonly string[], seed: number, shard: number, of: number): string[] {
  const order = [...files].sort();
  const random = seededRandom(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order.filter((_, i) => i % of === shard - 1);
}

/** The `Failing files:` block run-e2e.sh prints, as basenames. */
export function failingFiles(log: string): string[] {
  const start = log.lastIndexOf('\nFailing files:\n');
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of log.slice(start + '\nFailing files:\n'.length).split('\n')) {
    const m = /^ {2}- (\S+)$/.exec(line);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

export function reproduceCommand(order: readonly string[], file: string): string {
  const idx = order.indexOf(file);
  return `bash scripts/run-e2e.sh ${order.slice(0, idx + 1).join(' ')}`;
}

function arg(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return n;
}

function plan(argv: string[]): number {
  const seed = positiveInt(arg(argv, '--seed'), '--seed');
  const of = positiveInt(arg(argv, '--of'), '--of');
  const shard = positiveInt(arg(argv, '--shard'), '--shard');
  if (of < 1 || shard < 1 || shard > of) throw new Error(`--shard must be 1..${of}`);
  // run-e2e.sh reads SHARD (N/M) to pick a weighted slice; the hunt wants the whole corpus.
  const { SHARD: _shard, ...env } = process.env;
  const listed = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], { encoding: 'utf8', env });
  if (listed.status !== 0) throw new Error(`run-e2e.sh --dry-run-list failed: ${listed.stderr.trim()}`);
  const files = listed.stdout.split('\n').filter(Boolean);
  for (const f of planShard(files, seed, shard, of)) console.log(f);
  return 0;
}

function classify(argv: string[]): number {
  const order = readFileSync(arg(argv, '--order'), 'utf8').split('\n').filter(Boolean);
  const failing = failingFiles(readFileSync(arg(argv, '--log'), 'utf8'));
  let orderDependent = 0;
  for (const name of failing) {
    const file = order.find(f => f.endsWith(`/${name}`) || f === name);
    if (!file) { console.log(`::warning title=order hunt::${name} failed but is not in this shard's order list; read the run-e2e.sh log. Docs: ${DOCS}`); continue; }
    const { SHARD: _shard, ...env } = process.env;
    const alone = spawnSync('bash', ['scripts/run-e2e.sh', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    if (alone.status === 0) {
      orderDependent++;
      console.log(`::error file=${file},title=order-dependent test::${file} fails after the files before it in this order but passes alone, so an earlier file leaks state into it. Why: a test that leaves a config row, setting or rows behind breaks the next file on a shared database. Reproduce: ${reproduceCommand(order, file)} (then bisect the files before it). Fix the leaking file's teardown, not this file. Docs: ${DOCS}`);
    } else {
      console.log(`::warning file=${file},title=order hunt::${file} also fails on its own, so it is not an order leak; the full E2E lanes report it. Reproduce: bash scripts/run-e2e.sh ${file}. Docs: ${DOCS}`);
    }
  }
  if (!failing.length) console.log('order hunt: no failing files in this order.');
  return orderDependent ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    process.exit(cmd === 'plan' ? plan(rest) : cmd === 'classify' ? classify(rest) : (console.error('usage: bun scripts/order-hunt.ts plan --seed N --shard K --of M | classify --order FILE --log FILE'), 2));
  } catch (e) {
    console.error(`order-hunt: ${(e as Error).message}. Docs: ${DOCS}`);
    process.exit(2);
  }
}
