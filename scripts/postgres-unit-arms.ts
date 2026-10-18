#!/usr/bin/env bun
/**
 * test/postgres-unit-arms.txt: the unit-lane suites whose PostgreSQL arm runs
 * only in persistence-validation's `unit-postgres-arms` job and the race hunt.
 *
 *   bun scripts/postgres-unit-arms.ts list              every listed path
 *   bun scripts/postgres-unit-arms.ts shard <n> <m>     shard n of m, balanced by measured runtime
 *   bun scripts/postgres-unit-arms.ts mine <job.log>…   rewrite scripts/postgres-arm-weights.json
 *                                                       from unit-postgres-arms job logs
 *
 * Weights are milliseconds per file (both arms, one Bun process) mined from
 * the job's `::group::<file>` timestamps; a file without a weight gets the
 * p75 (scripts/sharding.ts). The job runs ARM_SHARDS shards, each inside an
 * ARM_STEP_TIMEOUT_MS step; re-mine after adding heavy files.
 * test/scripts/postgres-unit-arms.test.ts fails when a shard's weighted sum
 * passes ARM_SHARD_BUDGET_MS, and ci:ubicloud's pg-arms lane fails when a
 * shard's measured sum passes the step timeout (scripts/ubicloud/README.md).
 * Docs: docs/TESTING.md#postgres-arm-lanes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWeights, partition } from './sharding.ts';

export const ARMS_LIST = 'test/postgres-unit-arms.txt';
export const ARM_WEIGHTS = 'scripts/postgres-arm-weights.json';
/** persistence-validation's unit-postgres-arms matrix size; test/scripts/postgres-unit-arms.test.ts pins the workflow to it. */
export const ARM_SHARDS = 16;
/** The workflow step's `timeout-minutes: 20`: a shard whose files run longer is cut off mid-list. */
export const ARM_STEP_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * A shard's weighted sum may be at most this: on a runner twice as slow as the mined weights (Bun 1.4.0 runners
 * measured 1.3-2x) it still ends a minute inside the step timeout.
 */
export const ARM_SHARD_BUDGET_MS = (ARM_STEP_TIMEOUT_MS - 60_000) / 2;
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
 * Per-file durations from GitHub job logs: each `##[group]<file>` line to the
 * next group or endgroup, the median across logs. The median balances shards
 * on a typical run; one slow runner's outlier would otherwise set a file's
 * weight (a max did, and pushed most of the slow suites into one shard).
 */
export function mineArmWeights(logs: string[]): Map<string, number> {
  const samples = new Map<string, number[]>();
  for (const log of logs) {
    let open: { file: string; at: number } | undefined;
    for (const line of log.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(?:##\[group\]|::group::)(test\/[\w./-]+\.test\.ts)\s*$/.exec(line);
      const end = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+##\[endgroup\]/.exec(line);
      const at = m ? Date.parse(m[1]!) : end ? Date.parse(end[1]!) : NaN;
      if (!Number.isFinite(at) || (!m && !open)) continue;
      if (open && (m || end)) {
        samples.set(open.file, [...(samples.get(open.file) ?? []), at - open.at]);
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

/** Shard n of m (1-based), as persistence-validation's unit-postgres-arms matrix runs it and ci:ubicloud's pg-arms lane reports it. */
export function armShards(root: string, files: string[], m: number): string[][] {
  return partition(files, loadWeights(join(root, ARM_WEIGHTS)), m).map(shard => [...shard].sort());
}

function main(argv: string[]): number {
  const root = join(import.meta.dir, '..');
  const [command, ...rest] = argv;
  const list = readArmsList(root);
  if (command !== 'mine' && list.errors.length) {
    console.error(`${list.errors.join('\n')}\n  Why: the Postgres-arm lanes read this list; a bad row would drop or duplicate an arm.\n  Fix: correct the named line in ${ARMS_LIST}\n  Docs: ${DOCS}`);
    return 1;
  }
  if (command === 'list') {
    console.log(list.files.join('\n'));
    return 0;
  }
  if (command === 'shard') {
    const [n, m] = rest.map(Number);
    if (!Number.isInteger(n) || !Number.isInteger(m) || n! < 1 || n! > m!) {
      console.error('usage: bun scripts/postgres-unit-arms.ts shard <n> <m>   (1 <= n <= m)');
      return 2;
    }
    console.log(armShards(root, list.files, m!)[n! - 1]!.join('\n'));
    return 0;
  }
  if (command === 'mine' && rest.length) {
    const mined = mineArmWeights(rest.map(path => readFileSync(path, 'utf8')));
    const sorted = Object.fromEntries([...mined].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(join(root, ARM_WEIGHTS), `${JSON.stringify(sorted, null, 2)}\n`);
    const missing = list.files.filter(f => !mined.has(f));
    console.log(`postgres-arm weights: ${mined.size} files mined into ${ARM_WEIGHTS}${missing.length ? `; no timing for ${missing.join(', ')}` : ''}`);
    return 0;
  }
  console.error('usage: bun scripts/postgres-unit-arms.ts list | shard <n> <m> | mine <job.log>…');
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
