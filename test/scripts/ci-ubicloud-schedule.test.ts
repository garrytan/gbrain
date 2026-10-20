// ci-ubicloud-schedule.test.ts — the Ubicloud fan-out's work queue:
// weighting (trusted tables first, lane p75 fallback), heaviest-first
// same-lane batching with a draining batch target, marker-log parsing, burst
// fleet sizing from `ubi-runner.sh usage`, the explicit-file seams the
// ci:local wrappers expose for it, and the gate-location refusal (a full gate
// outside eu-central-h1 is refused before any VM is requested).

import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildItems,
  burstVms,
  parseItemLog,
  parseUsageTotal,
  readWeightTable,
  sortQueue,
  takeBatch,
  type Item,
  type WeightTable,
} from "../../scripts/ubicloud/schedule.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const table = (entries: Record<string, number>): WeightTable => new Map(Object.entries(entries));
const item = (lane: Item["lane"], file: string, weight: number): Item => ({ lane, file, weight, attempts: 0 });

describe("buildItems", () => {
  it("takes each weight from the most trusted table that knows the file", () => {
    const items = buildItems("unit", ["a", "b"], [table({ "unit:a": 5 }), table({ "unit:a": 50, "unit:b": 7 })]);
    expect(items.map((i) => i.weight)).toEqual([5, 7]);
  });

  it("keys weights by lane", () => {
    const [only] = buildItems("e2e", ["a"], [table({ "unit:a": 5, "e2e:a": 9 })]);
    expect(only!.weight).toBe(9);
  });

  it("weights unknown files at the lane p75 so new heavy files are not starved", () => {
    const known = { "unit:a": 10, "unit:b": 20, "unit:c": 30, "unit:d": 40 };
    const items = buildItems("unit", ["a", "b", "c", "d", "new"], [table(known)]);
    expect(items.find((i) => i.file === "new")!.weight).toBe(30);
  });

  it("falls back to a nonzero weight when nothing is known", () => {
    expect(buildItems("slow", ["x"], [])[0]!.weight).toBeGreaterThan(0);
  });
});

describe("takeBatch", () => {
  it("hands out heavy items alone, heaviest first", () => {
    const queue = [item("unit", "light", 10), item("e2e", "heavy", 90_000), item("unit", "mid", 20_000)];
    sortQueue(queue);
    expect(takeBatch(queue, { slots: 1 }).map((i) => i.file)).toEqual(["heavy"]);
    expect(takeBatch(queue, { slots: 1 }).map((i) => i.file)).toEqual(["mid"]);
  });

  it("batches light items of the head item's lane only", () => {
    const queue = [item("unit", "u1", 100), item("e2e", "e1", 90), item("unit", "u2", 80), item("unit", "u3", 70)];
    const batch = takeBatch(queue, { slots: 1, minTargetMs: 1000 });
    expect(batch.map((i) => i.file)).toEqual(["u1", "u2", "u3"]);
    expect(queue.map((i) => i.file)).toEqual(["e1"]);
  });

  it("shrinks batches as the queue drains so the tail stays balanced", () => {
    const many = Array.from({ length: 400 }, (_, i) => item("unit", `f${i}`, 500));
    expect(takeBatch([...many], { slots: 2 }).length).toBe(16);
    expect(takeBatch([...many], { slots: 200 }).length).toBe(1);
  });

  it("leaves skipped items queued for other slots and leads with the next allowed item", () => {
    const queue = [item("slow", "pole", 200_000), item("unit", "u1", 30_000), item("unit", "u2", 100)];
    const batch = takeBatch(queue, { slots: 1, skip: (i) => i.weight >= 60_000 });
    expect(batch.map((i) => i.file)).toEqual(["u1"]);
    expect(queue.map((i) => i.file)).toEqual(["pole", "u2"]);
    expect(takeBatch([item("slow", "pole", 200_000)], { slots: 1, skip: () => true })).toEqual([]);
  });

  it("respects the per-batch file cap and never loses or duplicates items", () => {
    const queue = Array.from({ length: 100 }, (_, i) => item("unit", `f${i}`, 1));
    const seen: string[] = [];
    for (let batch = takeBatch(queue, { slots: 1, maxFiles: 7 }); batch.length; batch = takeBatch(queue, { slots: 1, maxFiles: 7 })) {
      expect(batch.length).toBeLessThanOrEqual(7);
      seen.push(...batch.map((i) => i.file));
    }
    expect(seen.sort()).toEqual(Array.from({ length: 100 }, (_, i) => `f${i}`).sort());
  });
});

describe("parseItemLog", () => {
  it("splits a batch log into per-item results with their own output", () => {
    const log = [
      "__ubi_item_begin__ unit test/a.test.ts",
      "a output",
      "__ubi_item__ rc=0 ms=120 lane=unit file=test/a.test.ts",
      "__ubi_item_begin__ unit test/b.test.ts",
      "b failed",
      "__ubi_item__ rc=1 ms=45 lane=unit file=test/b.test.ts",
      "__ubi_item_begin__ unit test/c.test.ts",
      "connection lost mid-file",
    ].join("\n");
    expect(parseItemLog(log)).toEqual([
      { lane: "unit", file: "test/a.test.ts", rc: 0, ms: 120, output: "a output" },
      { lane: "unit", file: "test/b.test.ts", rc: 1, ms: 45, output: "b failed" },
    ]);
  });

  it("attaches the VM load sampled after an item to that item, never to its output or the next item", () => {
    const log = [
      "__ubi_item_begin__ e2e test/e2e/a.test.ts",
      "a output",
      "__ubi_item__ rc=0 ms=120 lane=e2e file=test/e2e/a.test.ts",
      "__ubi_load__ load1=18.40 vcpus=16",
      "__ubi_item_begin__ e2e test/e2e/b.test.ts",
      "b output",
      "__ubi_item__ rc=0 ms=45 lane=e2e file=test/e2e/b.test.ts",
    ].join("\n");
    expect(parseItemLog(log)).toEqual([
      { lane: "e2e", file: "test/e2e/a.test.ts", rc: 0, ms: 120, output: "a output", load: 1.15 },
      { lane: "e2e", file: "test/e2e/b.test.ts", rc: 0, ms: 45, output: "b output" },
    ]);
  });
});

describe("burst fleet sizing", () => {
  const fleet = { vmVcpus: 16, defaultVms: 4, maxVms: 8, ceilingVcpus: 448, workVms: 100 };

  it("reads the project total from the usage report", () => {
    const report = "OWNER           VMS  VCPUS\ngbra40            4     64\ngbra49            1     16\ntotal             5     80\n";
    expect(parseUsageTotal(report)).toBe(80);
    expect(parseUsageTotal("ubi-runner: request failed")).toBeNull();
  });

  it("bursts to the maximum when the quota is free", () => {
    expect(burstVms({ ...fleet, usedVcpus: 80 }).vms).toBe(8);
    expect(burstVms({ ...fleet, usedVcpus: 0 }).reason).toContain("burst maximum 8");
  });

  it("never pushes the project past the ceiling, and falls back to the default when busy", () => {
    expect(burstVms({ ...fleet, usedVcpus: 320 }).vms).toBe(8);
    expect(burstVms({ ...fleet, usedVcpus: 352 }).vms).toBe(6);
    expect(burstVms({ ...fleet, usedVcpus: 400 }).vms).toBe(4);
    expect(burstVms({ ...fleet, usedVcpus: 500 }).reason).toContain("quota busy, default 4");
  });

  it("uses the default when usage cannot be read, and never more VMs than the work fills", () => {
    expect(burstVms({ ...fleet, usedVcpus: null }).vms).toBe(4);
    expect(burstVms({ ...fleet, usedVcpus: 0, workVms: 1 })).toMatchObject({ vms: 1 });
    expect(burstVms({ ...fleet, usedVcpus: null, workVms: 2 }).vms).toBe(2);
  });
});

describe("readWeightTable", () => {
  it("scales and prefixes lane weight files, and treats a missing file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubi-weights-"));
    try {
      const path = join(dir, "w.json");
      writeFileSync(path, JSON.stringify({ "test/a.serial.test.ts": 3 }));
      expect([...readWeightTable(path, 1000, "serial:")]).toEqual([["serial:test/a.serial.test.ts", 3000]]);
      expect(readWeightTable(join(dir, "missing.json")).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("explicit-file seams in the ci:local wrappers", () => {
  const list = (script: string, ...args: string[]) =>
    execFileSync("bash", [join(REPO_ROOT, "scripts", script), ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, SHARD: "" },
    }).trim().split("\n").filter(Boolean);

  it("run-unit-shard.sh runs exactly the positional files", () => {
    expect(list("run-unit-shard.sh", "--dry-run-list", "test/x.test.ts", "test/y.test.ts")).toEqual(["test/x.test.ts", "test/y.test.ts"]);
  });

  it("run-slow-tests.sh lists discovery or the positional files", () => {
    expect(list("run-slow-tests.sh", "--dry-run-list").every((f) => f.endsWith(".slow.test.ts"))).toBe(true);
    expect(list("run-slow-tests.sh", "--dry-run-list", "test/x.slow.test.ts")).toEqual(["test/x.slow.test.ts"]);
  });

  it("run-slow-tests.sh exposes its exclusive subset of discovery", () => {
    const exclusive = list("run-slow-tests.sh", "--dry-run-list-exclusive");
    expect(exclusive).toContain("test/entity-card-perf.slow.test.ts");
    const all = list("run-slow-tests.sh", "--dry-run-list");
    for (const file of exclusive) expect(all).toContain(file);
    expect(list("run-slow-tests.sh", "--dry-run-list-exclusive", "test/x.slow.test.ts")).toEqual([]);
  });

  it("run-serial-tests.sh lists positional files and exposes its exclusive subset", () => {
    expect(list("run-serial-tests.sh", "--dry-run-list", "test/x.serial.test.ts")).toEqual(["test/x.serial.test.ts"]);
    const exclusive = list("run-serial-tests.sh", "--dry-run-list-exclusive");
    expect(exclusive.length).toBeGreaterThan(0);
    const all = list("run-serial-tests.sh", "--dry-run-list");
    for (const file of exclusive) expect(all).toContain(file);
  });
});

describe("gate location", () => {
  const run = (...args: string[]) => {
    const env = { ...process.env };
    delete env.UBICLOUD_API_KEY;
    delete env.UBICLOUD_API_TOKEN;
    const r = spawnSync("bun", [join(REPO_ROOT, "scripts/ci-ubicloud.ts"), ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
    return { status: r.status, stderr: r.stderr };
  };
  const credentialRefusal = "UBICLOUD_API_KEY (or UBICLOUD_API_TOKEN) is not set";

  it("refuses a full gate outside eu-central-h1 before asking for credentials or VMs", () => {
    for (const args of [["--location", "us-east-a2"], ["--location", "eu-north-h1", "--diff"]]) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("a full gate runs only in eu-central-h1");
      expect(r.stderr).toContain("is not gate evidence");
      expect(r.stderr).not.toContain(credentialRefusal);
    }
  });

  it("lets the default location and an explicit diagnostic subset elsewhere through to the credential check", () => {
    for (const args of [[], ["--location", "eu-central-h1"], ["--location", "us-east-a2", "--lanes", "gitleaks"]]) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(credentialRefusal);
      expect(r.stderr).not.toContain("a full gate runs only in");
    }
  });
});
