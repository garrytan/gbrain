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
 * p75 (scripts/sharding.ts). Docs: docs/TESTING.md#postgres-arm-lanes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWeights, partition } from './sharding.ts';

export const ARMS_LIST = 'test/postgres-unit-arms.txt';
export const ARM_WEIGHTS = 'scripts/postgres-arm-weights.json';
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

/** Per-file durations from GitHub job logs: each `##[group]<file>` line to the next group or endgroup. */
export function mineArmWeights(logs: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const log of logs) {
    let open: { file: string; at: number } | undefined;
    for (const line of log.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(?:##\[group\]|::group::)(test\/[\w./-]+\.test\.ts)\s*$/.exec(line);
      const end = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+##\[endgroup\]/.exec(line);
      const at = m ? Date.parse(m[1]!) : end ? Date.parse(end[1]!) : NaN;
      if (!Number.isFinite(at) || (!m && !open)) continue;
      if (open && (m || end)) {
        weights.set(open.file, Math.max(weights.get(open.file) ?? 0, at - open.at));
        open = undefined;
      }
      if (m) open = { file: m[2]!, at };
    }
  }
  return weights;
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
    const shards = partition(list.files, loadWeights(join(root, ARM_WEIGHTS)), m!);
    console.log([...shards[n! - 1]!].sort().join('\n'));
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
