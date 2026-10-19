// ci-cost-ledger.test.ts — scripts/ci-cost-ledger.ts, the weekly CI cost
// ledger (ci-health.yml runs it report-only).
//
// Protects: Ubicloud runner pricing ($0.000625 per vCPU-minute, billed per
// started minute; GitHub-hosted runners $0; jobs that never got a runner $0),
// run listing that splits a created window over the 1000-result cap, sampling
// that stays inside the request budget and scales each group back to its run
// count, $/week by workflow x event x conclusion, the median $/run of
// successful runs, and the exit code when a tracked median rose more than 20%
// over the committed baseline (report-only keeps exit 0 and warns).
// Fails when: a price, rounding or scaling rule changes, a capped window is
// silently truncated, the budget is exceeded, or a regression exits 0 without
// --report-only.
// Network: none (a recorded fake HTTP client).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  jobCostUsd,
  listRuns,
  pickSample,
  runLedger,
  ubicloudVcpus,
  type Http,
  type Job,
  type Run,
} from "../../scripts/ci-cost-ledger.ts";

const T0 = Date.parse("2026-10-11T00:00:00Z");
const job = (labels: string[], seconds: number, runner = "gr1"): Job => ({
  labels,
  runner_name: runner,
  started_at: new Date(T0).toISOString(),
  completed_at: new Date(T0 + seconds * 1000).toISOString(),
});

describe("pricing", () => {
  it("reads the vCPU count from Ubicloud labels; GitHub-hosted is 0; unknown Ubicloud labels are null", () => {
    expect(ubicloudVcpus(["ubicloud-standard-16-ubuntu-2404"])).toBe(16);
    expect(ubicloudVcpus(["ubicloud-standard-4-arm-ubuntu-2404"])).toBe(4);
    expect(ubicloudVcpus(["ubicloud-standard-30"])).toBe(30);
    expect(ubicloudVcpus(["ubicloud"])).toBe(2);
    expect(ubicloudVcpus(["ubuntu-latest"])).toBe(0);
    expect(ubicloudVcpus(["macos-26"])).toBe(0);
    expect(ubicloudVcpus(["ubicloud-gpu-standard-1"])).toBeNull();
  });

  it("bills each started minute at $0.000625 per vCPU-minute and nothing for jobs that never ran", () => {
    expect(jobCostUsd(job(["ubicloud-standard-4-ubuntu-2404"], 61))).toBeCloseTo(2 * 4 * 0.000625, 10);
    expect(jobCostUsd(job(["ubicloud-standard-16-ubuntu-2404"], 7))).toBeCloseTo(16 * 0.000625, 10);
    expect(jobCostUsd(job(["ubicloud-standard-2-ubuntu-2404"], 120))).toBeCloseTo(2 * 2 * 0.000625, 10);
    expect(jobCostUsd(job(["ubuntu-latest"], 600))).toBe(0);
    expect(jobCostUsd(job(["ubicloud-standard-4-ubuntu-2404"], -1, ""))).toBe(0);
    expect(jobCostUsd(job(["ubicloud-standard-4-ubuntu-2404"], 300, ""))).toBe(0);
    expect(jobCostUsd({ ...job(["ubicloud-standard-4-ubuntu-2404"], 300), completed_at: null })).toBe(0);
  });
});

/** A fake API: `runs` answers /actions/runs?created=A..B by window; `jobs` answers /runs/{id}/jobs. */
function fakeHttp(runs: Run[], jobs: Record<number, Job[]>, calls: string[] = []): Http {
  return {
    async get(path: string) {
      calls.push(path);
      const created = /created=([^&]+)/.exec(path);
      if (created) {
        const [a, b] = decodeURIComponent(created[1]!).split("..").map((s) => Date.parse(s));
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
        const inWindow = runs.filter((r) => Date.parse(r.created_at) >= a! && Date.parse(r.created_at) <= b!);
        return { total_count: inWindow.length, workflow_runs: inWindow.slice((page - 1) * 100, page * 100) };
      }
      const id = Number(/runs\/(\d+)\/jobs/.exec(path)?.[1]);
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      const all = jobs[id] ?? [];
      return { total_count: all.length, jobs: all.slice((page - 1) * 100, page * 100) };
    },
  };
}

let nextId = 1;
const run = (name: string, event: string, conclusion: string, atMs: number): Run => ({
  id: nextId++, name, event, conclusion, status: "completed", created_at: new Date(atMs).toISOString(),
});

describe("listRuns", () => {
  it("splits a window whose result count passes the 1000 cap and reads every page", async () => {
    const runs = Array.from({ length: 1500 }, (_, i) => run("Test", "pull_request", "success", T0 + i * 60_000));
    const calls: string[] = [];
    const listed = await listRuns(fakeHttp(runs, {}, calls), "o/r", T0, T0 + 1500 * 60_000, { concurrency: 4 });
    expect(listed.complete).toBe(true);
    expect(new Set(listed.runs.map((r) => r.id)).size).toBe(1500);
    expect(calls.every((c) => c.includes("per_page=100"))).toBe(true);
  });
});

describe("pickSample", () => {
  it("keeps every run when the budget allows; a capped sample spreads over each group and gives tracked green groups three times the cap", () => {
    const runs = [
      ...Array.from({ length: 100 }, (_, i) => run("Test", "pull_request", "success", T0 + i * 1000)),
      ...Array.from({ length: 3 }, (_, i) => run("Test", "push", "success", T0 + i * 1000)),
      ...Array.from({ length: 100 }, (_, i) => run("Semgrep", "pull_request", "success", T0 + i * 1000)),
    ];
    expect(pickSample(runs, 500).length).toBe(203);
    const capped = pickSample(runs, 43);
    expect(capped.length).toBeLessThanOrEqual(43);
    expect(capped.filter((r) => r.event === "push").length).toBe(3);
    expect(capped.filter((r) => r.name === "Semgrep").length).toBe(10);
    const pr = capped.filter((r) => r.name === "Test" && r.event === "pull_request").map((r) => r.id).sort((a, b) => a - b);
    expect(pr.length).toBe(30);
    expect(pr[pr.length - 1]! - pr[0]!).toBeGreaterThan(80);
  });
});

describe("runLedger", () => {
  const until = T0 + 7 * 86_400_000;
  function fixture(prCost: number) {
    nextId = 1000;
    const runs: Run[] = [];
    const jobs: Record<number, Job[]> = {};
    for (let i = 0; i < 10; i++) {
      const r = run("Test", "pull_request", "success", T0 + i * 3_600_000);
      runs.push(r);
      jobs[r.id] = [job(["ubicloud-standard-4-ubuntu-2404"], Math.round(prCost / (4 * 0.000625)) * 60), job(["ubuntu-latest"], 900), job(["ubicloud-standard-2-ubuntu-2404"], 0, "")];
    }
    for (let i = 0; i < 6; i++) {
      const r = run("Test", "pull_request", "cancelled", T0 + i * 3_600_000 + 1);
      runs.push(r);
      jobs[r.id] = [job(["ubicloud-standard-16-ubuntu-2404"], 60)];
    }
    for (let i = 0; i < 6; i++) {
      const r = run("E2E Tests", "push", "success", T0 + i * 3_600_000 + 2);
      runs.push(r);
      jobs[r.id] = [job(["ubicloud-standard-2-ubuntu-2404"], 720)];
    }
    runs.push({ ...run("Test", "push", "", T0 + 5), status: "in_progress", conclusion: null });
    runs.push(run("Heavy Tests", "pull_request", "skipped", T0 + 6));
    return { runs, jobs };
  }
  const baseline = JSON.stringify({ generated_at: "2026-10-18T00:00:00Z", threshold: 0.2, median_usd_per_run: { "Test|pull_request": 1.0, "E2E Tests|push": 0.015 } });

  it("prints $/week by workflow x event x conclusion and the median of successful runs, exit 0 within 20%", async () => {
    const { runs, jobs } = fixture(1.1);
    const calls: string[] = [];
    const r = await runLedger(["--repo", "o/r", "--days", "7", "--until", new Date(until).toISOString()], { http: fakeHttp(runs, jobs, calls), readFile: () => baseline });
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/\| Test \| pull_request \| success \| 10 \| 10 \| \$11\.00 \|/);
    expect(r.report).toMatch(/\| Test \| pull_request \| cancelled \| 6 \| 6 \| \$0\.06 \|/);
    expect(r.report).toMatch(/\| E2E Tests \| push \| success \| 6 \| 6 \| \$0\.09 \|/);
    expect(r.report).toContain("Total: $11.15/week");
    expect(r.report).toMatch(/\| Test \| pull_request \| 10 \| \$1\.100 \| \$1\.000 \| \+10% \|/);
    expect(r.report).toContain("1 run(s) still in progress were left out");
    expect(r.report).toMatch(/\| Heavy Tests \| pull_request \| skipped \| 1 \| 0 \| \$0\.00 \|\n/);
    expect(calls.some((c) => c.includes(`runs/${runs.at(-1)!.id}/jobs`))).toBe(false);
  });

  it("exits 1 naming the workflow and event when a median rose more than 20%; --report-only exits 0 with a warning", async () => {
    const { runs, jobs } = fixture(1.25);
    const r = await runLedger(["--repo", "o/r", "--days", "7", "--until", new Date(until).toISOString()], { http: fakeHttp(runs, jobs), readFile: () => baseline });
    expect(r.code).toBe(1);
    expect(r.messages.join("\n")).toContain("median $/run for Test pull_request rose 25% (from $1.000 to $1.250");
    const quiet = await runLedger(["--repo", "o/r", "--days", "7", "--until", new Date(until).toISOString(), "--report-only"], { http: fakeHttp(runs, jobs), readFile: () => baseline });
    expect(quiet.code).toBe(0);
    expect(quiet.messages.join("\n")).toContain("::warning title=CI cost::");
  });

  it("samples inside --max-requests and scales each group back to its run count", async () => {
    const { runs, jobs } = fixture(1.0);
    const calls: string[] = [];
    const r = await runLedger(["--repo", "o/r", "--days", "7", "--until", new Date(until).toISOString(), "--max-requests", "20"], { http: fakeHttp(runs, jobs, calls), readFile: () => baseline });
    expect(calls.length).toBeLessThanOrEqual(20);
    expect(r.report).toMatch(/\| Test \| pull_request \| success \| 10 \| \d \| \$10\.00 \|/);
  });

  it("ci-health.yml runs it weekly, report-only, into the step summary within the GITHUB_TOKEN budget", () => {
    const wf = readFileSync(join(import.meta.dir, "../../.github/workflows/ci-health.yml"), "utf8");
    expect(wf).toMatch(/schedule:\s*\n\s*- cron:/);
    const step = /- name: CI cost ledger[\s\S]*?run: (.*)\n/.exec(wf);
    expect(step?.[1]).toBe('bun scripts/ci-cost-ledger.ts --repo "$GITHUB_REPOSITORY" --report-only --step-summary --max-requests 500');
    expect(step?.[0]).toContain("GH_TOKEN: ${{ github.token }}");
    expect(JSON.parse(readFileSync(join(import.meta.dir, "../../scripts/ci-cost-baseline.json"), "utf8")).threshold).toBe(0.2);
  });

  it("--write-baseline writes the tracked medians", async () => {
    const { runs, jobs } = fixture(1.0);
    let written = "";
    const r = await runLedger(["--repo", "o/r", "--days", "7", "--until", new Date(until).toISOString(), "--write-baseline"], { http: fakeHttp(runs, jobs), readFile: () => baseline, writeFile: (_p, text) => (written = text) });
    expect(r.code).toBe(0);
    const json = JSON.parse(written);
    expect(json.threshold).toBe(0.2);
    expect(json.median_usd_per_run).toEqual({ "Test|pull_request": 1, "E2E Tests|push": 0.015 });
  });
});
