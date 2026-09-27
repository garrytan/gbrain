// mine-shard-weights.test.ts — pure-function tests for the log parser
// and weight extraction. The full pipeline (gh run view → write JSON)
// is integration-tested by actually running it once during T4.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  computeWeights,
  mineWeights,
  parseLog,
  serializeWeights,
} from "../../scripts/mine-shard-weights.ts";

const SAMPLE = `test (1)\tUNKNOWN STEP\t2026-05-25T11:26:40.000000Z ##[group]test/alpha.test.ts:
test (1)\tUNKNOWN STEP\t2026-05-25T11:26:41.000000Z (pass) some test [1.00ms]
test (1)\tUNKNOWN STEP\t2026-05-25T11:26:43.500000Z ##[group]test/beta.test.ts:
test (1)\tUNKNOWN STEP\t2026-05-25T11:26:45.000000Z (pass) another test
test (1)\tUNKNOWN STEP\t2026-05-25T11:26:48.000000Z ##[group]test/gamma.test.ts:
test (1)\tUNKNOWN STEP\t2026-05-25T11:26:50.000000Z ##[group]test/delta.test.ts:
test (2)\tUNKNOWN STEP\t2026-05-25T11:26:42.000000Z ##[group]test/epsilon.test.ts:
test (2)\tUNKNOWN STEP\t2026-05-25T11:26:55.000000Z ##[group]test/zeta.test.ts:
`;

describe("parseLog", () => {
  it("extracts file-start events with timestamps and jobs", () => {
    const events = parseLog(SAMPLE);
    expect(events.length).toBe(6);
    expect(events[0]).toMatchObject({
      job: "test (1)",
      file: "test/alpha.test.ts",
    });
    expect(events[5]).toMatchObject({
      job: "test (2)",
      file: "test/zeta.test.ts",
    });
  });

  it("preserves stream order", () => {
    const events = parseLog(SAMPLE);
    const files = events.map((e) => e.file);
    expect(files).toEqual([
      "test/alpha.test.ts",
      "test/beta.test.ts",
      "test/gamma.test.ts",
      "test/delta.test.ts",
      "test/epsilon.test.ts",
      "test/zeta.test.ts",
    ]);
  });

  it("ignores non-group lines", () => {
    // The sample has (pass) lines mixed in. They should not appear in the
    // event list; parseLog only emits ##[group]test/X.test.ts: matches.
    const events = parseLog(SAMPLE);
    expect(events.every((e) => e.file.startsWith("test/"))).toBe(true);
    expect(events.every((e) => e.file.endsWith(".test.ts"))).toBe(true);
  });

  it("handles empty input", () => {
    expect(parseLog("")).toEqual([]);
  });

  it("ignores malformed timestamps", () => {
    const bad = "test (1)\tUNKNOWN\tBAD-TS ##[group]test/x.test.ts:\n";
    expect(parseLog(bad)).toEqual([]);
  });

  it("rejects non-test-file groups (e.g. setup-bun action groups)", () => {
    const noise =
      "test (1)\tUNKNOWN\t2026-05-25T11:26:40.000Z ##[group]Run actions/checkout\n";
    expect(parseLog(noise)).toEqual([]);
  });
});

describe("computeWeights", () => {
  it("computes delta between consecutive file headers within a job", () => {
    const events = parseLog(SAMPLE);
    const weights = computeWeights(events);
    // job test (1): alpha → 3500ms (40s → 43.5s), beta → 4500ms (43.5s → 48s),
    // gamma → 2000ms (48s → 50s), delta dropped (no successor).
    expect(weights.get("test/alpha.test.ts")).toBe(3500);
    expect(weights.get("test/beta.test.ts")).toBe(4500);
    expect(weights.get("test/gamma.test.ts")).toBe(2000);
    expect(weights.get("test/delta.test.ts")).toBeUndefined();
    // job test (2): epsilon → 13000ms (42s → 55s), zeta dropped.
    expect(weights.get("test/epsilon.test.ts")).toBe(13000);
    expect(weights.get("test/zeta.test.ts")).toBeUndefined();
  });

  it("does not cross job boundaries", () => {
    // If we naively diffed across jobs we'd get bogus values when
    // alpha (test 1) was followed by epsilon (test 2) by clock skew.
    const events = parseLog(SAMPLE);
    const weights = computeWeights(events);
    // alpha → beta within same job: 3500ms. Not 2000ms (which would be
    // alpha's stamp to epsilon's stamp across jobs).
    expect(weights.get("test/alpha.test.ts")).toBe(3500);
  });

  it("takes the max when a file appears with multiple deltas", () => {
    const events = [
      { job: "test (1)", timestampMs: 1000, file: "test/x.test.ts" },
      { job: "test (1)", timestampMs: 2000, file: "test/y.test.ts" },
      { job: "test (2)", timestampMs: 3000, file: "test/x.test.ts" },
      { job: "test (2)", timestampMs: 8000, file: "test/y.test.ts" },
    ];
    const w = computeWeights(events);
    // x: 1000→2000 (1000ms in job 1), 3000→8000 (5000ms in job 2). Max = 5000.
    expect(w.get("test/x.test.ts")).toBe(5000);
  });

  it("skips out-of-order events defensively (negative delta)", () => {
    const events = [
      { job: "test (1)", timestampMs: 5000, file: "test/x.test.ts" },
      { job: "test (1)", timestampMs: 3000, file: "test/y.test.ts" },
    ];
    const w = computeWeights(events);
    // x → negative delta → skipped. y has no successor → not recorded.
    expect(w.size).toBe(0);
  });

  it("empty input → empty map", () => {
    expect(computeWeights([]).size).toBe(0);
  });
});

describe("serializeWeights", () => {
  it("sorts keys alphabetically for stable diffs", () => {
    const w = new Map([
      ["test/z.test.ts", 100],
      ["test/a.test.ts", 200],
      ["test/m.test.ts", 50],
    ]);
    const json = serializeWeights(w);
    const lines = json.split("\n").filter((l) => l.includes('"test/'));
    expect(lines[0]).toContain("a.test.ts");
    expect(lines[1]).toContain("m.test.ts");
    expect(lines[2]).toContain("z.test.ts");
  });

  it("ends with a trailing newline (POSIX-friendly diff)", () => {
    const w = new Map([["test/x.test.ts", 1]]);
    expect(serializeWeights(w).endsWith("\n")).toBe(true);
  });

  it("empty map → empty object JSON", () => {
    expect(serializeWeights(new Map())).toBe("{}\n");
  });

  it("round-trips: parse our own output", () => {
    const w = new Map([
      ["test/alpha.test.ts", 100],
      ["test/beta.test.ts", 250],
    ]);
    const json = serializeWeights(w);
    const parsed = JSON.parse(json);
    expect(parsed["test/alpha.test.ts"]).toBe(100);
    expect(parsed["test/beta.test.ts"]).toBe(250);
  });
});

describe('complete CI timing extraction', () => {
  const line = (job: string, seconds: number, message: string) => `${job}\tstep\t2026-05-25T11:26:${String(seconds).padStart(2, '0')}.000Z ${message}\n`;
  const header = (file: string) => `##[group]${file}:`;
  const unitLog = line('test (1)', 1, header('test/one.test.ts')) + line('test (1)', 3, header('evals/two.test.ts')) + line('test (1)', 4, ' 0 fail') + line('test (1)', 6, 'Ran 2 tests across 2 files. [5.00s]');
  it('includes evals and the final file, while excluding buffered/dedicated jobs', () => {
    const noise = line('serial-tests', 1, header('test/wrong.test.ts')) + line('slow-eval', 1, header('test/also-wrong.test.ts'));
    expect(Object.fromEntries(mineWeights(unitLog + noise, 'unit'))).toEqual({ 'test/one.test.ts': 2000, 'evals/two.test.ts': 3000 });
  });
  it('handles a one-file job', () => {
    const raw = line('test (2)', 1, header('test/one.test.ts')) + line('test (2)', 2, ' 0 fail') + line('test (2)', 4, 'Ran 1 test across 1 file. [3.00s]');
    expect(mineWeights(raw, 'unit').get('test/one.test.ts')).toBe(3000);
  });
  it('rejects truncated, failed, mismatched and out-of-order unit input', () => {
    for (const raw of [SAMPLE, unitLog.replace('0 fail', '1 fail'), unitLog.replace('across 2', 'across 3'), unitLog.replace('11:26:03', '11:26:00')]) expect(() => mineWeights(raw, 'unit')).toThrow();
  });
  it('refuses setup-only jobs and missing jobs promised by GitHub metadata', () => {
    expect(() => mineWeights(unitLog + line('test (2)', 1, 'snapshot setup started'), 'unit')).toThrow('incomplete Bun summary');
    expect(() => mineWeights(unitLog, 'unit', { expectedJobs: ['test (1)', 'test (2)'] })).toThrow('missing: test (2)');
    expect(() => mineWeights(unitLog, 'unit', { expectedJobs: ['test (2)'] })).toThrow('unexpected: test (1)');
    expect(mineWeights(unitLog, 'unit', { expectedJobs: ['test (1)'] }).size).toBe(2);
  });
  it('mines raw Bun group commands and requires the outer capture completion', () => {
    // Retained capture logs contain the original workflow command. Only the
    // rendered GitHub log rewrites ::group:: into ##[group].
    const captured = unitLog.replaceAll('\tstep\t', '\tcapture\t').replaceAll('##[group]', '::group::');
    const marker = (seconds: number, text: string) => line('test (1)', seconds, text).replace('\tstep\t', '\tcapture\t');
    const start = marker(0, '##[gbrain-capture-start]');
    const complete = marker(7, '##[gbrain-capture-complete] exit=0');
    expect(Object.fromEntries(mineWeights(start + captured + complete, 'unit'))).toEqual({ 'test/one.test.ts': 2000, 'evals/two.test.ts': 3000 });
    for (const raw of [captured, start + captured, captured + complete, start + captured + complete.replace('exit=0', 'exit=7'), start + captured + complete + start, start + start + captured + complete]) {
      expect(() => mineWeights(raw, 'unit')).toThrow('capture completion');
    }
    // Historical GitHub step logs remain supported with authoritative --run metadata.
    expect(mineWeights(unitLog, 'unit').size).toBe(2);
  });
  it('does not mix interleaved jobs', () => {
    const raw = line('test (1)', 1, header('test/a.test.ts')) + line('test (2)', 2, header('test/b.test.ts')) + line('test (1)', 3, ' 0 fail') + line('test (2)', 4, ' 0 fail') + line('test (2)', 5, 'Ran 1 test across 1 file. [3s]') + line('test (1)', 6, 'Ran 1 test across 1 file. [5s]');
    expect(Object.fromEntries(mineWeights(raw, 'unit'))).toEqual({ 'test/a.test.ts': 5000, 'test/b.test.ts': 3000 });
  });
  it('uses serial runner durations in seconds, not buffered timestamp deltas', () => {
    const raw = line('serial-tests (1)', 50, '[serial-tests] PASS 19s test/a.serial.test.ts (2pass)') + line('serial-tests (1)', 50, '[serial-tests] PASS 2s test/b.serial.test.ts (1pass)') + line('serial-tests (1)', 51, '[serial-tests] all 2 file(s) passed in 19s (pool=4)');
    expect(Object.fromEntries(mineWeights(raw, 'serial'))).toEqual({ 'test/a.serial.test.ts': 19, 'test/b.serial.test.ts': 2 });
    expect(() => mineWeights(raw.replace('all 2', 'all 3'), 'serial')).toThrow();
    expect(() => mineWeights(raw + line('serial-tests (2)', 1, 'snapshot setup started'), 'serial')).toThrow('incomplete serial execution');
    for (const bad of ['1..2', '9'.repeat(310)]) expect(() => mineWeights(raw.replace('PASS 19s', `PASS ${bad}s`), 'serial')).toThrow('invalid duration');
  });
  it('reads E2E summaries as milliseconds and requires the complete lane summary', () => {
    const job = 'Selected E2E (diff-relevant) 1';
    const raw = line(job, 1, '=== alpha.test.ts ===') + line(job, 2, ' 0 fail') + line(job, 3, 'Ran 4 tests across 1 file. [1.51s]') + line(job, 4, 'Files: 1 total, 1 passed, 0 failed');
    expect(mineWeights(raw, 'e2e').get('test/e2e/alpha.test.ts')).toBe(1510);
    expect(() => mineWeights(raw.replace('0 failed', '1 failed'), 'e2e')).toThrow();
    expect(() => mineWeights(raw.replace(' 0 fail', ' 1 fail'), 'e2e')).toThrow();
    expect(() => mineWeights(raw + line('Selected E2E (diff-relevant) 2', 1, 'snapshot setup started'), 'e2e')).toThrow('incomplete e2e execution');
    expect(mineWeights(raw + line('Selected E2E (diff-relevant) 2', 1, 'selected E2E: explicit empty selection; no tests launched'), 'e2e').size).toBe(1);
    for (const bad of ['1..2', '9'.repeat(310)]) expect(() => mineWeights(raw.replace('[1.51s]', `[${bad}s]`), 'e2e')).toThrow('invalid duration');
  });
  it('never serializes non-finite or negative weights into a poisoned map', () => {
    for (const value of [NaN, Infinity, -1]) expect(() => serializeWeights(new Map([['test/bad.test.ts', value]]))).toThrow('invalid weight');
  });
});

it('a failed CLI refresh leaves the existing output untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-mine-failure-'));
  try {
    const out = join(dir, 'weights');
    const input = join(dir, 'truncated.log');
    writeFileSync(out, '{"keep":123}\n');
    writeFileSync(input, SAMPLE);
    const failed = spawnSync(process.execPath, [join(import.meta.dir, '../../scripts/mine-shard-weights.ts'), '--from-file', input, '--out', out], { encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('{"keep":123}\n');
    writeFileSync(input, SAMPLE + 'test (1)\tstep\t2026-05-25T11:26:56.000Z 0 fail\ntest (1)\tstep\t2026-05-25T11:26:57.000Z Ran 4 tests across 4 files. [17s]\ntest (2)\tstep\t2026-05-25T11:26:56.000Z 0 fail\ntest (2)\tstep\t2026-05-25T11:26:58.000Z Ran 2 tests across 2 files. [16s]\n');
    const passed = spawnSync(process.execPath, [join(import.meta.dir, '../../scripts/mine-shard-weights.ts'), '--from-file', input, '--out', out], { encoding: 'utf8' });
    expect(passed.status, passed.stderr).toBe(0);
    const weights = JSON.parse(readFileSync(out, 'utf8'));
    expect(weights['test/delta.test.ts']).toBe(7000);
    expect(weights.keep).toBe(123);
    expect(JSON.parse(readFileSync(out + '.metadata.json', 'utf8'))).toMatchObject({ measuredFiles: 6, totalFiles: 7, mergeExisting: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('partial serial artifacts preserve unobserved files; malformed durations cannot replace either output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-mine-serial-'));
  try {
    const out = join(dir, 'weights.json');
    const meta = join(dir, 'weights.metadata.json');
    const input = join(dir, 'serial.log');
    const line = (text: string) => `serial-tests (1)\tstep\t2026-05-25T11:26:50.000Z ${text}\n`;
    const raw = line('[serial-tests] PASS 7s test/a.serial.test.ts (1pass)') + line('[serial-tests] all 1 file(s) passed in 7s (pool=4)');
    writeFileSync(out, '{"test/unobserved.serial.test.ts":42}\n');
    writeFileSync(input, raw);
    const args = [join(import.meta.dir, '../../scripts/mine-shard-weights.ts'), '--lane', 'serial', '--from-file', input, '--out', out];
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ 'test/a.serial.test.ts': 7, 'test/unobserved.serial.test.ts': 42 });
    expect(JSON.parse(readFileSync(meta, 'utf8'))).toMatchObject({ measuredFiles: 1, totalFiles: 2, mergeExisting: true });
    const saved = [readFileSync(out, 'utf8'), readFileSync(meta, 'utf8')];
    writeFileSync(input, raw.replace('PASS 7s', 'PASS 1..2s'));
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).not.toBe(0);
    expect([readFileSync(out, 'utf8'), readFileSync(meta, 'utf8')]).toEqual(saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('GitHub refresh verifies every eligible job before replacing the complete lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-mine-github-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fakeGh = join(bin, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\ncase "$*" in\n  "run view 123 --json conclusion,headSha,jobs") cat "$FIXTURE_GH_INFO" ;;\n  "run view 123 --log") cat "$FIXTURE_GH_LOG" ;;\n  *) exit 2 ;;\nesac\n');
    chmodSync(fakeGh, 0o755);
    const info = join(dir, 'run.json');
    const input = join(dir, 'unit.log');
    const out = join(dir, 'weights.json');
    const meta = join(dir, 'weights.metadata.json');
    const line = (job: string, text: string) => `${job}\tRun test shard\t2026-05-25T11:26:50.000Z ${text}\n`;
    const complete = (job: string, file: string) => line(job, `##[group]${file}:`) + line(job, '0 fail') + line(job, 'Ran 1 test across 1 file. [1ms]');
    const one = complete('test (1)', 'test/one.test.ts');
    writeFileSync(info, JSON.stringify({ conclusion: 'success', headSha: 'fixture-commit', jobs: [{ name: 'test (1)', conclusion: 'success' }, { name: 'test (2)', conclusion: 'success' }, { name: 'verify', conclusion: 'success' }] }));
    writeFileSync(out, '{"test/old.test.ts":42}\n');
    writeFileSync(meta, '{"existing":true}\n');
    const args = [join(import.meta.dir, '../../scripts/mine-shard-weights.ts'), '--run', '123', '--out', out];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_GH_INFO: info, FIXTURE_GH_LOG: input };
    for (const partial of [one, one + line('test (2)', 'snapshot setup started')]) {
      writeFileSync(input, partial);
      expect(spawnSync(process.execPath, args, { env, encoding: 'utf8' }).status).not.toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('{"test/old.test.ts":42}\n');
      expect(readFileSync(meta, 'utf8')).toBe('{"existing":true}\n');
    }
    writeFileSync(input, one + complete('test (2)', 'test/two.test.ts'));
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ 'test/one.test.ts': 0, 'test/two.test.ts': 0 });
    expect(JSON.parse(readFileSync(meta, 'utf8'))).toMatchObject({ commit: 'fixture-commit', measuredFiles: 2, totalFiles: 2, mergeExisting: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
