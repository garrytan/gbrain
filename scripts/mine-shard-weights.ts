#!/usr/bin/env bun
/** Mine timings from successful CI execution in its real execution mode.
 * Unit: consecutive headers + final Bun summary, milliseconds.
 * Serial: per-file runner PASS records, seconds (not buffered log timestamps).
 * E2E: per-file Bun summaries, milliseconds. Partial selections merge old weights.
 * Refresh after large test additions or sustained shard imbalance.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWeights } from "./sharding.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type Lane = "unit" | "serial" | "e2e";
const OUTPUTS = { unit: "test-weights", serial: "serial-weights", e2e: "e2e-weights" };
interface TimingEvent { job: string; timestampMs: number; file: string; summaryCount?: number; failures?: number }
interface LogLine { job: string; step: string; timestampMs: number; text: string }
function logLines(raw: string): LogLine[] {
  return raw.split("\n").flatMap(line => {
    const m = /^([^\t]+)\t([^\t]*)\t(\d{4}-\d{2}-\d{2}T\S+Z)\s+(.*)$/.exec(line);
    if (!m || !Number.isFinite(Date.parse(m[3]!))) return [];
    return [{ job: m[1]!.trim(), step: m[2]!.trim(), timestampMs: Date.parse(m[3]!), text: m[4]!.replace(/\x1b\[[0-9;]*m/g, "") }];
  });
}
function isJob(job: string, lane: Lane): boolean {
  if (lane === "unit") return /^test \(\d+\)$/.test(job);
  if (lane === "serial") return /^serial-tests(?: \(\d+\))?$/.test(job);
  return /^Selected E2E \(diff-relevant\)(?: \(\d+\)| \d+)?$/.test(job);
}

/** File starts and the LAST summary per unit job; nested CLI summaries are ignored. */
export function parseLog(raw: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  const ends = new Map<string, TimingEvent>();
  const failures = new Map<string, number>();
  for (const line of logLines(raw)) {
    if (!isJob(line.job, "unit")) continue;
    // Captured artifacts retain Bun's raw workflow command; GitHub's rendered
    // logs rewrite that same command to the bracketed form.
    const m = /^(?:##\[group\]|::group::)((?:test|evals)\/[^\s:]+\.test\.ts):?\s*$/.exec(line.text);
    if (m) events.push({ job: line.job, timestampMs: line.timestampMs, file: m[1]! });
    const fail = /^\s*(\d+) fail\s*$/.exec(line.text);
    if (fail) failures.set(line.job, Number(fail[1]));
    const summary = /^Ran \d+ tests? across (\d+) files?\./.exec(line.text);
    if (summary) ends.set(line.job, { job: line.job, timestampMs: line.timestampMs, file: "", summaryCount: Number(summary[1]), failures: failures.get(line.job) });
  }
  return [...events, ...ends.values()];
}
export function computeWeights(events: TimingEvent[]): Map<string, number> {
  const byJob = new Map<string, TimingEvent[]>();
  for (const e of events) {
    if (!byJob.has(e.job)) byJob.set(e.job, []);
    byJob.get(e.job)!.push(e);
  }
  const weights = new Map<string, number>();
  for (const list of byJob.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]!, b = list[i + 1]!;
      if (!a.file || b.timestampMs < a.timestampMs) continue;
      weights.set(a.file, Math.max(weights.get(a.file) ?? 0, Math.round(b.timestampMs - a.timestampMs)));
    }
  }
  return weights;
}

/** Refuse partial/failed sources before any output is replaced. */
export function mineWeights(raw: string, lane: Lane, opts: { expectedJobs?: readonly string[] } = {}): Map<string, number> {
  const lines = logLines(raw).filter(line => isJob(line.job, lane));
  if (lines.some(l => /^##\[error\]/.test(l.text))) throw new Error(`${lane}: failed job log`);
  const byJob = new Map<string, LogLine[]>();
  for (const line of lines) {
    if (!byJob.has(line.job)) byJob.set(line.job, []);
    byJob.get(line.job)!.push(line);
  }
  if (opts.expectedJobs) {
    const expected = new Set(opts.expectedJobs);
    const missing = [...expected].filter(job => !byJob.has(job));
    const unexpected = [...byJob.keys()].filter(job => !expected.has(job));
    if (missing.length || unexpected.length) throw new Error(`${lane}: timing job set differs from run metadata (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
  }
  for (const [job, records] of byJob) {
    const captured = records.filter(line => line.step === 'capture');
    if (!captured.length) continue;
    if (captured[0]!.text !== '##[gbrain-capture-start]' ||
        captured.at(-1)!.text !== '##[gbrain-capture-complete] exit=0' ||
        captured.filter(line => line.text === '##[gbrain-capture-start]').length !== 1 ||
        captured.filter(line => line.text.startsWith('##[gbrain-capture-complete]')).length !== 1) {
      throw new Error(`${job}: missing or unsuccessful capture completion`);
    }
  }
  if (lane === "unit") {
    const events = parseLog(raw);
    for (const job of byJob.keys()) {
      const files = events.filter(e => e.job === job && e.file);
      const end = events.find(e => e.job === job && e.summaryCount !== undefined);
      if (!end || end.failures !== 0 || end.summaryCount !== files.length || !files.length) throw new Error(`${job}: missing, failed, or incomplete Bun summary`);
      const ordered = [...files, end];
      if (ordered.some((e, i) => i > 0 && e.timestampMs < ordered[i - 1]!.timestampMs)) throw new Error(`${job}: out-of-order timing records`);
      if (new Set(files.map(e => e.file)).size !== files.length) throw new Error(`${job}: duplicate file headers`);
    }
    const weights = computeWeights(events);
    if (!weights.size) throw new Error("unit: no complete timing data");
    return weights;
  }
  const duration = (text: string, multiplier: number, job: string) => {
    const value = Number(text) * multiplier;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${job}: invalid duration ${text}`);
    return value;
  };
  const weights = new Map<string, number>();
  for (const [job, records] of byJob) {
    const found = new Map<string, number>();
    let expected: number | undefined, current: string | undefined;
    let failures: number | undefined;
    for (const { text } of records) {
      if (lane === "serial") {
        const pass = /^\[serial-tests\] PASS ([\d.]+)s (test\/\S+\.serial\.test\.ts)(?:\s|$)/.exec(text);
        if (pass) found.set(pass[2]!, Math.max(found.get(pass[2]!) ?? 0, duration(pass[1]!, 1, job)));
        const end = /^\[serial-tests\] all (\d+) file\(s\) passed/.exec(text);
        if (end) expected = Number(end[1]);
      } else {
        const start = /^=== ([^/]+\.test\.ts) ===$/.exec(text);
        if (start) {
          if (current) throw new Error(`${job}: file missing Bun summary: ${current}`);
          current = `test/e2e/${start[1]}`;
          failures = undefined;
        }
        const fail = /^\s*(\d+) fail\s*$/.exec(text);
        if (fail) failures = Number(fail[1]);
        const summary = /^Ran \d+ tests? across 1 file\. \[([\d.]+)(ms|s)\]/.exec(text);
        if (current && summary) {
          if (failures !== 0 || found.has(current)) throw new Error(`${job}: failed or duplicate file ${current}`);
          found.set(current, duration(summary[1]!, summary[2] === "s" ? 1000 : 1, job));
          current = undefined;
        }
        const end = /^Files: (\d+) total, \d+ passed, (\d+) failed$/.exec(text);
        if (end && Number(end[2]) === 0) expected = Number(end[1]);
        if (/^ERROR: HOME isolation breach/.test(text)) throw new Error(`${job}: isolation failure`);
      }
    }
    // Only the runner's explicit no-work sentinel permits a job without a
    // summary. Setup-only/truncated jobs must not disappear from the evidence.
    if (lane === 'e2e' && !found.size && expected === undefined && !current &&
        records.some(line => line.text === 'selected E2E: explicit empty selection; no tests launched')) continue;
    if (current || expected === undefined || expected !== found.size) throw new Error(`${job}: incomplete ${lane} execution`);
    for (const [file, duration] of found) weights.set(file, Math.max(weights.get(file) ?? 0, duration));
  }
  if (!weights.size) throw new Error(`${lane}: no complete timing data`);
  return weights;
}
export function serializeWeights(weights: Map<string, number>): string {
  for (const [file, value] of weights) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid weight for ${file}: ${value}`);
  }
  return JSON.stringify(Object.fromEntries([...weights].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2) + "\n";
}
function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
async function main(): Promise<void> {
  let lane: Lane = "unit", run: string | undefined, input: string | undefined, out: string | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log("usage: bun run weights:mine [--lane unit|serial|e2e] [--run ID | --from-file PATH | <stdin>] [--out PATH]");
      return;
    }
    if (!["--lane", "--run", "--run-id", "--from-file", "--out"].includes(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error(`unknown/incomplete option: ${arg}`);
    const value = argv[++i]!;
    if (arg === "--lane") {
      if (!["unit", "serial", "e2e"].includes(value)) throw new Error(`invalid lane: ${value}`);
      lane = value as Lane;
    } else if (arg === "--run" || arg === "--run-id") run = value;
    else if (arg === "--from-file") input = value;
    else out = resolve(value);
  }
  if (run && input) throw new Error("choose --run or --from-file, not both");
  out ??= resolve(ROOT, `scripts/${OUTPUTS[lane]}.json`);
  let commit: string | null = null;
  let expectedJobs: string[] | undefined;
  if (run) {
    const info = JSON.parse(gh(["run", "view", run, "--json", "conclusion,headSha,jobs"]));
    if (info.conclusion !== "success") throw new Error(`run ${run} is not successful`);
    const jobs = info.jobs.filter((j: { name: string }) => isJob(j.name, lane));
    if (!jobs.length || jobs.some((j: { conclusion: string }) => j.conclusion !== "success")) throw new Error(`run ${run} has no complete ${lane} lane`);
    expectedJobs = jobs.map((j: { name: string }) => j.name);
    commit = info.headSha;
  }
  const raw = run ? gh(["run", "view", run, "--log"]) : input ? readFileSync(input, "utf8") : await new Response(Bun.stdin.stream()).text();
  const measured = mineWeights(raw, lane, { expectedJobs });
  // Downloaded artifacts/stdin may cover only one shard. Only an authoritative
  // complete GitHub unit/serial run replaces the full map; selected E2E always
  // merges because its executed corpus depends on the diff.
  const mergeExisting = !run || lane === "e2e";
  const weights = mergeExisting && existsSync(out) ? loadWeights(out) : new Map<string, number>();
  for (const [file, duration] of measured) weights.set(file, duration);
  const metadata = { lane, unit: lane === "serial" ? "seconds" : "milliseconds", run: run ?? null, commit, source: run ? "github" : input ? "file" : "stdin", measuredFiles: measured.size, totalFiles: weights.size, mergeExisting };
  const temp = `${out}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, serializeWeights(weights));
    renameSync(temp, out);
    writeFileSync(out.endsWith(".json") ? out.replace(/\.json$/, ".metadata.json") : `${out}.metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
  } finally { rmSync(temp, { force: true }); }
  console.error(`[weights:mine] ${lane}: ${measured.size} measured, ${weights.size} total (${metadata.unit}); ${out}`);
}
if (import.meta.main) main().catch(error => { console.error(`weights:mine: ${error.message}`); process.exitCode = 1; });
