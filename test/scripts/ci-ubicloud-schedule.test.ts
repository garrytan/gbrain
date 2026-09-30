// ci-ubicloud-schedule.test.ts — the Ubicloud fan-out's work queue:
// weighting (trusted tables first, lane p75 fallback), heaviest-first
// same-lane batching with a draining batch target, marker-log parsing, and
// the explicit-file seams the ci:local wrappers expose for it.

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildItems,
  parseItemLog,
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

  it("run-serial-tests.sh lists positional files and exposes its exclusive subset", () => {
    expect(list("run-serial-tests.sh", "--dry-run-list", "test/x.serial.test.ts")).toEqual(["test/x.serial.test.ts"]);
    const exclusive = list("run-serial-tests.sh", "--dry-run-list-exclusive");
    expect(exclusive.length).toBeGreaterThan(0);
    const all = list("run-serial-tests.sh", "--dry-run-list");
    for (const file of exclusive) expect(all).toContain(file);
  });
});
