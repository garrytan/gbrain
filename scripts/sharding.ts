#!/usr/bin/env bun
/**
 * scripts/sharding.ts — weight-aware test file partitioning.
 *
 * Replaces FNV-1a path-hash sharding in scripts/test-shard.sh. Uses
 * longest-processing-time-first (LPT) greedy bin-packing over measured
 * per-file runtimes to balance total wallclock across N shards.
 *
 * LPT is a textbook approximation algorithm: sort jobs by weight desc,
 * assign each to the bin (shard) with the current minimum total. Worst-
 * case makespan is within 4/3 of optimal. Runs in O(n log n).
 *
 * Weights live in scripts/test-weights.json — committed, mined from real
 * CI run logs via scripts/mine-shard-weights.ts. Files absent from the
 * weights map fall back to the corpus median (not zero — that would
 * favor unknown new files into the smallest shard, defeating balance).
 *
 * CLI:
 *   bun run scripts/sharding.ts <shard-index> <total-shards>
 *     Reads test file list from stdin (one path per line). Prints the
 *     subset assigned to <shard-index> to stdout, one per line.
 *
 *   bun run scripts/sharding.ts <shard-index> <total-shards> --files <glob>
 *     Walks the filesystem for matching files instead of reading stdin.
 *
 * Exit codes:
 *   0   success
 *   1   internal error (e.g., malformed weights JSON)
 *   2   usage error
 *
 * Used by: scripts/test-shard.sh (thin wrapper), test/scripts/sharding.test.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_WEIGHTS_PATH = resolve(REPO_ROOT, "scripts/test-weights.json");

export type WeightMap = Map<string, number>;

export class WeightsLoadError extends Error {
  constructor(public readonly path: string, public readonly cause: unknown) {
    super(`failed to load weights from ${path}: ${cause}`);
    this.name = "WeightsLoadError";
  }
}

/**
 * Read a weights JSON file. Fail-soft on missing file (returns empty map).
 * Throws WeightsLoadError on malformed JSON or non-object shape — the
 * caller decides whether to fall through to defaults or surface.
 */
export function loadWeights(path: string = DEFAULT_WEIGHTS_PATH): WeightMap {
  if (!existsSync(path)) return new Map();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new WeightsLoadError(path, e);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new WeightsLoadError(path, `JSON.parse: ${e}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WeightsLoadError(path, "expected top-level object {path: ms}");
  }
  const out: WeightMap = new Map();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new WeightsLoadError(
        path,
        `value for "${k}" must be a non-negative finite number, got ${JSON.stringify(v)}`,
      );
    }
    out.set(k, v);
  }
  return out;
}

/**
 * Median of a list of numbers. Used as the fallback weight for files
 * absent from the weights map. Empty input returns 0 (no signal).
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export interface PartitionOpts {
  /**
   * Weight to assign files that are absent from the weights map. Defaults
   * to the median of present weights (computed inside `partition`) so
   * unknown new files cluster around the typical file's cost.
   *
   * Override mainly for tests; production callers should use the default.
   */
  fallbackWeight?: number;
}

/**
 * Partition `files` into `n` shards using LPT greedy bin-packing.
 *
 * Returns an array of length `n` where each entry is the (deterministic)
 * file list for that shard. Files in each shard are returned in
 * assignment order (heaviest first). Same input always produces same
 * output — no Math.random, stable sort key (weight desc, then path asc).
 *
 * Contracts:
 *   - Every file in `files` appears in exactly one returned shard.
 *   - If `files` is empty, returns `n` empty arrays.
 *   - If `n <= 0`, throws RangeError.
 *   - Files missing from `weights` get `opts.fallbackWeight` (or median).
 */
export function partition(
  files: string[],
  weights: WeightMap,
  n: number,
  opts: PartitionOpts = {},
): string[][] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`shard count must be a positive integer, got ${n}`);
  }
  const shards: string[][] = Array.from({ length: n }, () => []);
  if (files.length === 0) return shards;

  // Compute fallback weight from the median of present weights, unless
  // the caller supplied an explicit override.
  let fallback: number;
  if (opts.fallbackWeight !== undefined) {
    if (!Number.isFinite(opts.fallbackWeight) || opts.fallbackWeight < 0) {
      throw new RangeError(
        `fallbackWeight must be non-negative finite, got ${opts.fallbackWeight}`,
      );
    }
    fallback = opts.fallbackWeight;
  } else {
    fallback = computeMedian(Array.from(weights.values()));
  }
  // Cold-start guard: if the weights map is empty AND no explicit
  // fallback was supplied, every effective weight would be 0 and LPT
  // collapses (all ties → lowest-index wins → every file in shard 0).
  // Normalize fallback to 1 so LPT degenerates to round-robin, which is
  // a strictly better default than "everything in shard 1" until
  // test-weights.json gets mined.
  if (fallback === 0 && opts.fallbackWeight === undefined) {
    fallback = 1;
  }

  // Build [weight, path] tuples. Sort by weight desc, then path asc for
  // determinism on ties (multiple files with the same weight).
  const tuples = files.map((f) => ({
    path: f,
    weight: weights.get(f) ?? fallback,
  }));
  tuples.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Running per-shard totals. argmin tiebreaker: lowest index (stable).
  const totals = new Array<number>(n).fill(0);
  for (const t of tuples) {
    let minIdx = 0;
    for (let i = 1; i < n; i++) {
      if (totals[i]! < totals[minIdx]!) minIdx = i;
    }
    shards[minIdx]!.push(t.path);
    totals[minIdx] = totals[minIdx]! + t.weight;
  }
  return shards;
}

/**
 * Imbalance ratio: max-total / min-total over the partition. 1.0 = perfect.
 * Returns Infinity when any shard is empty (degenerate). Use ≤1.5 as a
 * loose health gate; LPT typically hits ≤1.1 on real corpora.
 *
 * Exposed for tests + the slow-test regression that pins corpus health.
 */
export function imbalanceRatio(shards: string[][], weights: WeightMap, fallback: number): number {
  if (shards.length === 0) return 1;
  const totals = shards.map((s) =>
    s.reduce((sum, f) => sum + (weights.get(f) ?? fallback), 0),
  );
  const max = Math.max(...totals);
  const min = Math.min(...totals);
  if (min === 0) return max === 0 ? 1 : Infinity;
  return max / min;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

async function readStdinLines(): Promise<string[]> {
  // Bun gives us a readable stream on process.stdin. Read to end.
  if (process.stdin.isTTY) return []; // no piped input
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error("usage: bun run scripts/sharding.ts <shard-index> <total-shards>");
    console.error("       (reads file list from stdin, one path per line)");
    return 2;
  }
  const idx = Number.parseInt(argv[0]!, 10);
  const total = Number.parseInt(argv[1]!, 10);
  if (!Number.isInteger(idx) || !Number.isInteger(total) || idx < 1 || total < 1 || idx > total) {
    console.error(
      `error: shard index ${argv[0]} / total ${argv[1]} invalid (need 1 <= index <= total, both ints)`,
    );
    return 2;
  }
  const files = await readStdinLines();
  if (files.length === 0) {
    // Caller asked for a shard but piped no files. Exit clean — the wrapper
    // will warn or no-op as it sees fit.
    return 0;
  }
  let weights: WeightMap;
  try {
    weights = loadWeights();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const shards = partition(files, weights, total);
  for (const f of shards[idx - 1]!) {
    process.stdout.write(`${f}\n`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
