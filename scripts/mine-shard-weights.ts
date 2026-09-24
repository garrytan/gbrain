#!/usr/bin/env bun
/** Mine timings from successful CI execution in its real execution mode.
 * Unit: consecutive headers + final Bun summary, milliseconds.
 * Serial: per-file runner PASS records, seconds (not buffered log timestamps).
 * E2E: per-file Bun summaries, milliseconds. Partial selections merge old weights;
 * explicit full-profile runs replace them after source-corpus validation.
 * Refresh after large test additions or sustained shard imbalance.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadWeights } from "./sharding.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type Lane = "unit" | "serial" | "e2e";
type E2EProfile = "selected" | "full";
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
function isJob(job: string, lane: Lane, e2eProfile: E2EProfile = "selected"): boolean {
  if (lane === "unit") return /^test \(\d+\)$/.test(job);
  if (lane === "serial") return /^serial-tests(?: \(\d+\))?$/.test(job);
  if (e2eProfile === "full") return /^coverage-full-e2e(?: \(\d+\))?$/.test(job);
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
export function mineWeights(raw: string, lane: Lane, opts: { expectedJobs?: readonly string[]; e2eProfile?: E2EProfile; expectedFiles?: readonly string[] } = {}): Map<string, number> {
  const full = opts.e2eProfile === "full";
  const fullPaths = new Map<string, string>();
  if (full) {
    if (lane !== "e2e" || !opts.expectedFiles?.length) throw new Error("full E2E requires an authoritative source corpus");
    for (const file of opts.expectedFiles) {
      if (fullPaths.has(basename(file))) throw new Error(`full E2E: ambiguous or duplicate basename ${basename(file)}`);
      fullPaths.set(basename(file), file);
    }
  }
  const lines = logLines(raw).filter(line => isJob(line.job, lane, opts.e2eProfile));
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
    let completed: { duration: number; failures: number | undefined } | undefined;
    const finishFile = () => {
      if (!current || !completed || completed.failures !== 0 || found.has(current)) throw new Error(`${job}: missing, failed or duplicate file ${current}`);
      found.set(current, completed.duration);
      current = undefined;
      completed = undefined;
    };
    for (const { text } of records) {
      if (lane === "serial") {
        const pass = /^\[serial-tests\] PASS ([\d.]+)s (test\/\S+\.serial\.test\.ts)(?:\s|$)/.exec(text);
        if (pass) found.set(pass[2]!, Math.max(found.get(pass[2]!) ?? 0, duration(pass[1]!, 1, job)));
        const end = /^\[serial-tests\] all (\d+) file\(s\) passed/.exec(text);
        if (end) expected = Number(end[1]);
      } else {
        const start = /^=== ([^/]+\.test\.ts) ===$/.exec(text);
        if (start) {
          if (current) finishFile();
          if (expected !== undefined) throw new Error(`${job}: file after E2E completion`);
          current = full ? fullPaths.get(start[1]!) : `test/e2e/${start[1]}`;
          if (!current) throw new Error(`${job}: file outside the full source corpus: ${start[1]}`);
          failures = undefined;
        }
        const fail = /^\s*(\d+) fail\s*$/.exec(text);
        if (fail) failures = Number(fail[1]);
        const summary = /^Ran \d+ tests? across 1 file\. \[([\d.]+)(ms|s)\]/.exec(text);
        if (current && summary) {
          completed = { duration: duration(summary[1]!, summary[2] === "s" ? 1000 : 1, job), failures };
          failures = undefined;
        }
        const end = /^Files: (\d+) total, (\d+) passed, (\d+) failed$/.exec(text);
        if (end) {
          if (current) finishFile();
          if (Number(end[3]) !== 0 || end[1] !== end[2]) throw new Error(`${job}: failed or inconsistent E2E totals`);
          expected = Number(end[1]);
        }
        if (/^ERROR: HOME isolation breach/.test(text)) throw new Error(`${job}: isolation failure`);
      }
    }
    // Only the runner's explicit no-work sentinel permits a job without a
    // summary. Setup-only/truncated jobs must not disappear from the evidence.
    if (!full && lane === 'e2e' && !found.size && expected === undefined && !current &&
        records.some(line => line.text === 'selected E2E: explicit empty selection; no tests launched')) continue;
    if (current || expected === undefined || expected !== found.size) throw new Error(`${job}: incomplete ${lane} execution`);
    for (const [file, duration] of found) {
      if (full && weights.has(file)) throw new Error(`full E2E: duplicate execution across jobs: ${file}`);
      weights.set(file, Math.max(weights.get(file) ?? 0, duration));
    }
  }
  if (!weights.size) throw new Error(`${lane}: no complete timing data`);
  if (full) {
    const missing = opts.expectedFiles!.filter(file => !weights.has(file));
    if (missing.length) throw new Error(`full E2E: missing source files: ${missing.join(', ')}`);
  }
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
function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trimEnd();
}
export function sourceE2ECorpus(commit: string): string[] {
  if (commit !== git(["rev-parse", "HEAD"])) throw new Error("full E2E source SHA differs from checkout HEAD");
  const tracked = git(["ls-tree", "-r", "--name-only", commit]).split("\n").filter(file => file.endsWith(".test.ts"));
  const root = mkdtempSync(join(tmpdir(), "gbrain-full-e2e-source-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/run-e2e.sh"), git(["show", `${commit}:scripts/run-e2e.sh`]));
    for (const file of tracked) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    const r = spawnSync("bash", ["scripts/run-e2e.sh", "--dry-run-list"], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: root, GBRAIN_HOME: root, SHARD: "", COVERAGE_DIR: "" },
    });
    if (r.status !== 0) throw new Error(`source E2E discovery failed: ${r.stderr}`);
    const files = r.stdout.trim().split("\n").filter(Boolean);
    if (!files.length || new Set(files).size !== files.length || files.some(file => !tracked.includes(file))) throw new Error("source E2E discovery contains missing or duplicate paths");
    return files;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
async function main(): Promise<void> {
  let lane: Lane = "unit", run: string | undefined, input: string | undefined, out: string | undefined;
  let e2eProfile: E2EProfile = "selected";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log("usage: bun run weights:mine [--lane unit|serial|e2e] [--e2e-profile selected|full] [--run ID | --from-file PATH | <stdin>] [--out PATH]\nfull E2E requires --lane e2e --run and a matching source checkout");
      return;
    }
    if (!["--lane", "--e2e-profile", "--run", "--run-id", "--from-file", "--out"].includes(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error(`unknown/incomplete option: ${arg}`);
    const value = argv[++i]!;
    if (arg === "--lane") {
      if (!["unit", "serial", "e2e"].includes(value)) throw new Error(`invalid lane: ${value}`);
      lane = value as Lane;
    } else if (arg === "--e2e-profile") {
      if (value !== "selected" && value !== "full") throw new Error(`invalid E2E profile: ${value}`);
      e2eProfile = value;
    } else if (arg === "--run" || arg === "--run-id") run = value;
    else if (arg === "--from-file") input = value;
    else out = resolve(value);
  }
  if (run && input) throw new Error("choose --run or --from-file, not both");
  const full = e2eProfile === "full";
  if (full && (lane !== "e2e" || !run)) throw new Error("full E2E requires --lane e2e --run for verified source provenance");
  out ??= resolve(ROOT, `scripts/${OUTPUTS[lane]}.json`);
  let commit: string | null = null;
  let expectedJobs: string[] | undefined;
  let expectedFiles: string[] | undefined;
  let attempt: number | undefined;
  let fullJobs: Array<{ name: string; databaseId: number }> = [];
  if (run) {
    const info = JSON.parse(gh(["run", "view", run, "--json", full ? "attempt,conclusion,headSha,jobs" : "conclusion,headSha,jobs"]));
    if (info.conclusion !== "success") throw new Error(`run ${run} is not successful`);
    const jobs = info.jobs.filter((j: { name: string }) => isJob(j.name, lane, e2eProfile));
    if (!jobs.length || jobs.some((j: { conclusion: string }) => j.conclusion !== "success")) throw new Error(`run ${run} has no complete ${lane} lane`);
    expectedJobs = jobs.map((j: { name: string }) => j.name);
    commit = info.headSha;
    if (full) {
      if (!Number.isInteger(info.attempt) || info.attempt < 1 || jobs.some((j: { databaseId: number }) => !Number.isInteger(j.databaseId) || j.databaseId < 1)) throw new Error("full E2E: missing attempt or job identity");
      attempt = info.attempt;
      fullJobs = jobs.map(({ name, databaseId }: { name: string; databaseId: number }) => ({ name, databaseId }));
      expectedFiles = sourceE2ECorpus(info.headSha);
    }
  }
  const raw = full ? fullJobs.map(job => gh(["run", "view", run!, "--attempt", String(attempt), "--job", String(job.databaseId), "--log"])).join("\n") : run ? gh(["run", "view", run, "--log"]) : input ? readFileSync(input, "utf8") : await new Response(Bun.stdin.stream()).text();
  const measured = mineWeights(raw, lane, { expectedJobs, e2eProfile, expectedFiles });
  // Downloaded artifacts/stdin may cover only one shard. Only an authoritative
  // complete GitHub unit/serial/full-E2E run replaces the full map; selected E2E always
  // merges because its executed corpus depends on the diff.
  const mergeExisting = !full && (!run || lane === "e2e");
  const weights = mergeExisting && existsSync(out) ? loadWeights(out) : new Map<string, number>();
  for (const [file, duration] of measured) weights.set(file, duration);
  const metadata = { lane, unit: lane === "serial" ? "seconds" : "milliseconds", run: run ?? null, commit, source: run ? "github" : input ? "file" : "stdin", measuredFiles: measured.size, totalFiles: weights.size, mergeExisting,
    ...(full ? { e2eProfile, attempt, jobs: fullJobs, logSha256: createHash("sha256").update(raw).digest("hex"), corpusSha256: createHash("sha256").update([...expectedFiles!].sort().join("\n") + "\n").digest("hex") } : {}),
  };
  const temp = `${out}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, serializeWeights(weights));
    renameSync(temp, out);
    writeFileSync(out.endsWith(".json") ? out.replace(/\.json$/, ".metadata.json") : `${out}.metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
  } finally { rmSync(temp, { force: true }); }
  console.error(`[weights:mine] ${lane}: ${measured.size} measured, ${weights.size} total (${metadata.unit}); ${out}`);
}
if (import.meta.main) main().catch(error => { console.error(`weights:mine: ${error.message}`); process.exitCode = 1; });
