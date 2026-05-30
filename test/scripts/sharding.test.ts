// sharding.test.ts — pure unit tests for the LPT bin-packer.
//
// Covers: happy path, fallback semantics, full coverage, determinism,
// balance ratio, N=1 trivial, weight-equal-to-zero handling, malformed
// weights, missing weights file fail-soft.

import { describe, expect, it } from "bun:test";
import {
  computeMedian,
  imbalanceRatio,
  loadWeights,
  partition,
  WeightsLoadError,
  type WeightMap,
} from "../../scripts/sharding.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempJson(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "weights-test-"));
  const path = join(dir, "weights.json");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("computeMedian", () => {
  it("returns 0 on empty input", () => {
    expect(computeMedian([])).toBe(0);
  });
  it("single value is itself", () => {
    expect(computeMedian([42])).toBe(42);
  });
  it("odd count: middle value", () => {
    expect(computeMedian([1, 5, 3])).toBe(3);
  });
  it("even count: mean of middle two", () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("partition — happy path", () => {
  it("balances 4 known-weight files across 2 shards", () => {
    const weights: WeightMap = new Map([
      ["a.test.ts", 100],
      ["b.test.ts", 100],
      ["c.test.ts", 50],
      ["d.test.ts", 50],
    ]);
    const out = partition(
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
      weights,
      2,
    );
    expect(out.length).toBe(2);
    // LPT assigns 100→s0, 100→s1, 50→s0 (now 150), 50→s1 (now 150).
    // Wait: 100→s0 (s0=100), 100→s1 (s1=100), tie → s0 gets 50 (s0=150),
    // then s1 gets 50 (s1=150). Balanced.
    const totals = out.map((s) =>
      s.reduce((acc, f) => acc + (weights.get(f) ?? 0), 0),
    );
    expect(totals[0]).toBe(150);
    expect(totals[1]).toBe(150);
  });

  it("LPT prefers heavy-first assignment", () => {
    // 3 files: 100, 10, 10. 2 shards. Naive assignment (alpha) would put
    // 100 + 10 = 110 in s0 and 10 in s1 (imbalance 11x). LPT puts 100 in
    // s0, then 10 + 10 in s1 (totals 100 + 20 = imbalance 5x).
    const weights: WeightMap = new Map([
      ["big.test.ts", 100],
      ["small1.test.ts", 10],
      ["small2.test.ts", 10],
    ]);
    const out = partition(
      ["big.test.ts", "small1.test.ts", "small2.test.ts"],
      weights,
      2,
    );
    expect(out[0]).toEqual(["big.test.ts"]);
    expect(out[1]?.sort()).toEqual(["small1.test.ts", "small2.test.ts"]);
  });
});

describe("partition — fallback semantics", () => {
  it("missing weights default to corpus median", () => {
    // weights = {a:100, b:50}, median = 75. Files c + d are unknown → 75 each.
    const weights: WeightMap = new Map([
      ["a", 100],
      ["b", 50],
    ]);
    const out = partition(["a", "b", "c", "d"], weights, 2);
    // Effective weights: a=100, b=50, c=75, d=75. LPT: 100→s0, 75→s1 (c),
    // 75→s1 (d, ties broken alpha)... actually: 100→s0=100, 75→s1=75,
    // 75→s1 vs s0 → s1=150, 50→s0=150. Balanced 150/150.
    const totalsEffective = out.map((s) =>
      s.reduce((acc, f) => acc + (weights.get(f) ?? 75), 0),
    );
    expect(totalsEffective[0]).toBe(totalsEffective[1]);
  });

  it("explicit fallback override beats median", () => {
    const weights: WeightMap = new Map([["a", 100]]);
    const out = partition(["a", "unknown"], weights, 2, { fallbackWeight: 500 });
    // a=100 to s0, unknown=500 to s1 (heavier goes first actually — sort
    // desc puts unknown=500 first). Wait, LPT sorts desc, so unknown
    // (500) goes to s0 first, then a (100) goes to s1.
    expect(out[0]).toEqual(["unknown"]);
    expect(out[1]).toEqual(["a"]);
  });

  it("zero-weight files are valid (just always go to current min shard)", () => {
    const weights: WeightMap = new Map([
      ["zero1", 0],
      ["zero2", 0],
      ["big", 100],
    ]);
    const out = partition(["zero1", "zero2", "big"], weights, 2);
    // 100→s0=100, 0→s1=0, 0→s1=0. Both zeroes go to s1.
    expect(out[0]).toEqual(["big"]);
    expect(out[1]?.sort()).toEqual(["zero1", "zero2"]);
  });
});

describe("partition — invariants", () => {
  it("every input file lands in exactly one shard (full coverage)", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.test.ts`);
    const weights: WeightMap = new Map(
      files.map((f, i) => [f, (i % 5) * 10 + 5]),
    );
    const out = partition(files, weights, 4);
    const seen: string[] = [];
    for (const shard of out) seen.push(...shard);
    expect(seen.sort()).toEqual([...files].sort());
    expect(new Set(seen).size).toBe(files.length);
  });

  it("deterministic — same input always produces same output", () => {
    const files = ["d.test.ts", "a.test.ts", "c.test.ts", "b.test.ts"];
    const weights: WeightMap = new Map([
      ["a.test.ts", 30],
      ["b.test.ts", 30],
      ["c.test.ts", 30],
      ["d.test.ts", 30],
    ]);
    const r1 = partition(files, weights, 2);
    const r2 = partition([...files].reverse(), weights, 2);
    const r3 = partition(files, weights, 2);
    // Same input → identical output
    expect(r3).toEqual(r1);
    // Input order shuffled but contents identical → identical output
    // (ties broken by path asc so order is canonical regardless of input)
    expect(r2).toEqual(r1);
  });

  it("N=1 trivial: everything in one shard", () => {
    const out = partition(["x.test.ts", "y.test.ts"], new Map(), 1);
    expect(out.length).toBe(1);
    expect(out[0]?.sort()).toEqual(["x.test.ts", "y.test.ts"]);
  });

  it("empty file list returns N empty shards", () => {
    const out = partition([], new Map(), 3);
    expect(out).toEqual([[], [], []]);
  });

  it("invalid shard count throws RangeError", () => {
    expect(() => partition(["a"], new Map(), 0)).toThrow(RangeError);
    expect(() => partition(["a"], new Map(), -1)).toThrow(RangeError);
    expect(() => partition(["a"], new Map(), 1.5)).toThrow(RangeError);
  });

  it("invalid fallbackWeight throws RangeError", () => {
    expect(() =>
      partition(["a"], new Map(), 2, { fallbackWeight: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      partition(["a"], new Map(), 2, { fallbackWeight: NaN }),
    ).toThrow(RangeError);
  });
});

describe("partition — balance quality", () => {
  it("synthetic skewed corpus produces imbalance ratio ≤ 1.5", () => {
    // 100 files, weights drawn from a Zipf-ish distribution (a few heavy,
    // many light). This is the shape that broke FNV-1a hash sharding.
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.test.ts`);
    const weights: WeightMap = new Map();
    for (let i = 0; i < files.length; i++) {
      // Heavy tail: file 0 = 1000ms, file 1 = 500, file 2 = 333, ...
      // Average about 50ms; max about 1000ms.
      const w = Math.max(10, Math.floor(1000 / (i + 1)));
      weights.set(files[i]!, w);
    }
    const out = partition(files, weights, 6);
    const ratio = imbalanceRatio(out, weights, 0);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it("imbalance ratio of 1.0 when weights are perfectly divisible", () => {
    const files = ["a", "b", "c", "d"];
    const weights: WeightMap = new Map([
      ["a", 50],
      ["b", 50],
      ["c", 50],
      ["d", 50],
    ]);
    const out = partition(files, weights, 2);
    expect(imbalanceRatio(out, weights, 0)).toBe(1.0);
  });
});

describe("loadWeights", () => {
  it("missing file → empty map (fail-soft)", () => {
    const w = loadWeights("/tmp/definitely-does-not-exist-weights.json");
    expect(w.size).toBe(0);
  });

  it("malformed JSON → throws WeightsLoadError", () => {
    const p = tempJson("not json {");
    try {
      expect(() => loadWeights(p)).toThrow(WeightsLoadError);
    } finally {
      rmSync(p.replace(/\/weights\.json$/, ""), { recursive: true, force: true });
    }
  });

  it("array JSON → throws (wrong shape)", () => {
    const p = tempJson("[1,2,3]");
    try {
      expect(() => loadWeights(p)).toThrow(/expected top-level object/);
    } finally {
      rmSync(p.replace(/\/weights\.json$/, ""), { recursive: true, force: true });
    }
  });

  it("negative weight → throws (semantic invalid)", () => {
    const p = tempJson('{"foo.test.ts": -5}');
    try {
      expect(() => loadWeights(p)).toThrow(/non-negative finite/);
    } finally {
      rmSync(p.replace(/\/weights\.json$/, ""), { recursive: true, force: true });
    }
  });

  it("non-number weight → throws (semantic invalid)", () => {
    const p = tempJson('{"foo.test.ts": "100ms"}');
    try {
      expect(() => loadWeights(p)).toThrow(/non-negative finite/);
    } finally {
      rmSync(p.replace(/\/weights\.json$/, ""), { recursive: true, force: true });
    }
  });

  it("valid weights JSON round-trips", () => {
    const p = tempJson('{"a.test.ts": 100, "b.test.ts": 250}');
    try {
      const w = loadWeights(p);
      expect(w.size).toBe(2);
      expect(w.get("a.test.ts")).toBe(100);
      expect(w.get("b.test.ts")).toBe(250);
    } finally {
      rmSync(p.replace(/\/weights\.json$/, ""), { recursive: true, force: true });
    }
  });
});
