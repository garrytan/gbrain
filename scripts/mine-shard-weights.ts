#!/usr/bin/env bun
/**
 * scripts/mine-shard-weights.ts — extract per-file test wallclock from a
 * real CI run's logs, write scripts/test-weights.json.
 *
 * Why this exists: scripts/sharding.ts does LPT bin-packing over per-file
 * weights, but the weights have to come from somewhere. The original
 * design ran each test file in isolation (`bun test <file>` per file)
 * which (a) takes ~57min to run all 676 files, and (b) measures cold-
 * start dominantly because each invocation pays a fresh `bun test`
 * startup. CI shards run ~150 files in ONE bun process — cold-start is
 * amortized away. Per-file isolated profiles are wrong-by-methodology.
 *
 * This script scrapes per-file wallclock from a real CI shard's log via
 * GitHub's `gh run view --log` output. bun emits an `##[group]test/foo.
 * test.ts:` header before each file with an ISO timestamp; the
 * difference between consecutive headers = how long the previous file
 * took. This is the actual CI shard runtime per file, in the right
 * execution mode, for free on every green run.
 *
 * Usage:
 *   bun run scripts/mine-shard-weights.ts --run <RUN_ID> [--out PATH]
 *   bun run scripts/mine-shard-weights.ts --from-file <LOG_FILE> [--out PATH]
 *   gh run view <RUN_ID> --log | bun run scripts/mine-shard-weights.ts [--out PATH]
 *
 * Default output: scripts/test-weights.json (overwrites). Use --out to
 * write elsewhere (useful for diffing before commit). Output is JSON
 * with sorted keys for stable diffs.
 *
 * Regen cadence: there is none. Weights drift continuously but missing
 * files fall back to the corpus median in sharding.ts, so stale weights
 * degrade gracefully. Run this script when you notice a specific shard
 * starts running long, or after a wave that added many heavy tests.
 *
 * Exit codes:
 *   0   wrote weights file (count > 0)
 *   1   internal error
 *   2   usage error
 *   3   no usable timing data found (parsed log but extracted 0 weights)
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_OUT = resolve(REPO_ROOT, "scripts/test-weights.json");

interface Args {
  runId?: string;
  fromFile?: string;
  fromStdin: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { fromStdin: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run" || a === "--run-id") {
      out.runId = argv[++i];
    } else if (a === "--from-file") {
      out.fromFile = argv[++i];
    } else if (a === "--out") {
      out.out = resolve(argv[++i] ?? "");
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: bun run scripts/mine-shard-weights.ts (--run <ID> | --from-file <PATH> | <stdin>) [--out <PATH>]",
      );
      process.exit(0);
    } else {
      console.error(`error: unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.runId && !out.fromFile) {
    out.fromStdin = true;
  }
  return out;
}

async function readSource(args: Args): Promise<string> {
  if (args.runId) {
    const r = spawnSync("gh", ["run", "view", args.runId, "--log"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024, // CI logs can be 50-80MB
    });
    if (r.status !== 0) {
      throw new Error(
        `gh run view ${args.runId} --log failed (exit ${r.status}): ${r.stderr}`,
      );
    }
    return r.stdout;
  }
  if (args.fromFile) {
    return readFileSync(args.fromFile, "utf8");
  }
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parsed timing event from a CI log line. timestamp is ms-since-epoch.
 */
interface TimingEvent {
  job: string;
  timestampMs: number;
  file: string;
}

/**
 * Parse a CI log into a list of `##[group]test/X.test.ts:` events keyed
 * by job (so timing deltas don't cross shard boundaries).
 *
 * GH log line shape:
 *   <job-name>\tUNKNOWN STEP\t<ISO-timestamp> ##[group]test/foo.test.ts:
 * or:
 *   <job-name>\t<step-name>\t<ISO-timestamp> ##[group]test/foo.test.ts:
 *
 * Exported for unit testing.
 */
export function parseLog(raw: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  const lines = raw.split("\n");
  // Match: <job>TAB<step>TAB<iso-ts> ##[group]<path>:
  const re = /^([^\t]+)\t[^\t]*\t(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+##\[group\](test\/[^\s:]+\.test\.ts):?\s*$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const job = m[1]!.trim();
    const ts = Date.parse(m[2]!);
    const file = m[3]!;
    if (Number.isNaN(ts)) continue;
    events.push({ job, timestampMs: ts, file });
  }
  return events;
}

/**
 * From a list of file-start events grouped by job, compute per-file
 * runtime as (timestamp[i+1] - timestamp[i]) within each job. The last
 * file in each job is dropped (we don't know when it ended without
 * also parsing the bun summary line; the loss is acceptable since
 * sharding.ts's median fallback covers missing files).
 *
 * When the same file appears in multiple jobs (shouldn't happen, but
 * defensive against shard remix during the in-flight CI run that
 * generated this log), take the max — heaviest observation wins.
 *
 * Exported for unit testing.
 */
export function computeWeights(events: TimingEvent[]): Map<string, number> {
  // Group events by job, in stream order.
  const byJob = new Map<string, TimingEvent[]>();
  for (const e of events) {
    let bucket = byJob.get(e.job);
    if (!bucket) {
      bucket = [];
      byJob.set(e.job, bucket);
    }
    bucket.push(e);
  }

  const weights = new Map<string, number>();
  for (const [, jobEvents] of byJob) {
    for (let i = 0; i + 1 < jobEvents.length; i++) {
      const file = jobEvents[i]!.file;
      const delta = jobEvents[i + 1]!.timestampMs - jobEvents[i]!.timestampMs;
      if (delta < 0) continue; // log out-of-order; defensive
      // Round to nearest ms; sub-ms doesn't matter for shard balancing.
      const ms = Math.round(delta);
      const prev = weights.get(file);
      if (prev === undefined || ms > prev) {
        weights.set(file, ms);
      }
    }
    // Drop the last event's file (no successor → unknown duration).
  }
  return weights;
}

/**
 * Serialize a weights map to canonical JSON (keys sorted asc) so the
 * committed file produces stable diffs run-to-run.
 *
 * Exported for unit testing.
 */
export function serializeWeights(weights: Map<string, number>): string {
  const sorted = Array.from(weights.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const obj: Record<string, number> = {};
  for (const [k, v] of sorted) obj[k] = v;
  return JSON.stringify(obj, null, 2) + "\n";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `[mine-shard-weights] source=${args.runId ?? args.fromFile ?? "<stdin>"}`,
  );
  let raw: string;
  try {
    raw = await readSource(args);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const events = parseLog(raw);
  console.error(`[mine-shard-weights] parsed ${events.length} file-start events`);
  if (events.length === 0) {
    console.error(
      "error: no ##[group]test/*.test.ts: events found in input. Was this a CI test run log?",
    );
    return 3;
  }
  const weights = computeWeights(events);
  if (weights.size === 0) {
    console.error("error: parsed events but extracted 0 weights (every job had ≤1 file?)");
    return 3;
  }
  const json = serializeWeights(weights);
  writeFileSync(args.out, json);
  // Summary: min/median/max/total. Useful for spot-checking the file.
  const values = Array.from(weights.values()).sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const median = values[Math.floor(values.length / 2)]!;
  const total = values.reduce((a, b) => a + b, 0);
  console.error(
    `[mine-shard-weights] wrote ${weights.size} weights to ${args.out}`,
  );
  console.error(
    `[mine-shard-weights] stats: min=${min}ms median=${median}ms max=${max}ms total=${(total / 1000).toFixed(1)}s`,
  );
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
