/**
 * SkillOpt benchmark loader + splitter unit tests.
 *
 * Uses tempdir + withEnv for hermeticity. No engine; no LLM.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StructuredAgentError } from '../../src/core/errors.ts';
import {
  computeBenchmarkSha8,
  loadBenchmark,
  parseSplit,
  splitBench,
} from '../../src/core/skillopt/benchmark.ts';
import { BOOTSTRAP_PENDING_REVIEW } from '../../src/core/skillopt/types.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-bench-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeBench(filename: string, lines: string[]): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

describe('loadBenchmark', () => {
  test('parses well-formed JSONL with rule judge', () => {
    const p = writeBench('b.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'do X', judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 4000 }] } }),
      JSON.stringify({ task_id: 't2', task: 'do Y', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'foo' }] } }),
    ]);
    const b = loadBenchmark(p);
    expect(b.tasks).toHaveLength(2);
    expect(b.tasks[0]!.task_id).toBe('t1');
    expect(b.benchmark_sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  test('rejects file-not-found with paste-ready hint', () => {
    expect(() => loadBenchmark(path.join(tmpDir, 'nope.jsonl'))).toThrow(StructuredAgentError);
  });

  test('rejects empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.jsonl'), '', 'utf8');
    expect(() => loadBenchmark(path.join(tmpDir, 'empty.jsonl'))).toThrow(StructuredAgentError);
  });

  test('rejects duplicate task_id', () => {
    const p = writeBench('dup.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 100 }] } }),
      JSON.stringify({ task_id: 't1', task: 'b', judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 100 }] } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/Duplicate task_id/);
  });

  test('rejects unknown judge.kind', () => {
    const p = writeBench('badjudge.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'magic' } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/not one of rule\|llm\|qrels/);
  });

  test('rejects rule judge with empty checks array', () => {
    const p = writeBench('emptychecks.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'rule', checks: [] } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/non-empty checks array/);
  });

  test('rejects rule check with unknown op', () => {
    const p = writeBench('badop.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'rule', checks: [{ op: 'frob', arg: 1 }] } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/unknown op/);
  });

  test('rejects llm judge with no rubric', () => {
    const p = writeBench('norubric.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'llm', rubric: '   ' } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/non-empty rubric/);
  });

  test('rejects qrels judge with empty expected_slugs', () => {
    const p = writeBench('noslugs.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'qrels', expected_slugs: [], k: 10 } }),
    ]);
    expect(() => loadBenchmark(p)).toThrow(/expected_slugs/);
  });

  test('rejects sentinel file without --bootstrap-reviewed', () => {
    const p = writeBench('boot.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 100 }] } }),
      BOOTSTRAP_PENDING_REVIEW,
    ]);
    expect(() => loadBenchmark(p)).toThrow(/awaiting human review/);
  });

  test('accepts sentinel file with --bootstrap-reviewed', () => {
    const p = writeBench('boot.jsonl', [
      JSON.stringify({ task_id: 't1', task: 'a', judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 100 }] } }),
      BOOTSTRAP_PENDING_REVIEW,
    ]);
    const b = loadBenchmark(p, { bootstrapReviewed: true });
    expect(b.tasks).toHaveLength(1);
  });
});

describe('splitBench', () => {
  function makeBench(n: number) {
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push({
        task_id: `t${String(i).padStart(3, '0')}`,
        task: `task ${i}`,
        judge: { kind: 'rule' as const, checks: [{ op: 'max_chars' as const, arg: 4000 }] },
      });
    }
    return { source_path: '/tmp/x.jsonl', tasks, benchmark_sha8: 'abcd1234' };
  }

  test('splits 50 tasks at 4:1:5 into 20/5/25', () => {
    const split = splitBench(makeBench(50), [4, 1, 5]);
    expect(split.train.length + split.sel.length + split.test.length).toBe(50);
    expect(split.train.length).toBe(20);
    expect(split.sel.length).toBe(5);
    expect(split.test.length).toBe(25);
  });

  test('D17: refuses when D_sel < 5 without override', () => {
    // 8 tasks split 4:1:5 → sel = max(1, floor(8/10)) = 1 < 5 → refuses
    expect(() => splitBench(makeBench(8), [4, 1, 5])).toThrow(/D_sel/);
  });

  test('D17: allows D_sel < 5 with allowSmallSel override', () => {
    const split = splitBench(makeBench(8), [4, 1, 5], { allowSmallSel: true });
    expect(split.sel.length).toBeGreaterThanOrEqual(1);
  });

  test('rejects bad ratio (zero segment)', () => {
    expect(() => splitBench(makeBench(20), [4, 0, 5])).toThrow(/zero or negative/);
  });

  test('deterministic split — same input produces same output', () => {
    const b = makeBench(50);
    const a = splitBench(b, [4, 1, 5]);
    const c = splitBench(b, [4, 1, 5]);
    expect(a.train.map((t) => t.task_id)).toEqual(c.train.map((t) => t.task_id));
    expect(a.sel.map((t) => t.task_id)).toEqual(c.sel.map((t) => t.task_id));
  });
});

describe('parseSplit', () => {
  test('parses "4:1:5" correctly', () => {
    expect(parseSplit('4:1:5')).toEqual([4, 1, 5]);
  });

  test('rejects malformed input', () => {
    expect(() => parseSplit('4-1-5')).toThrow();
    expect(() => parseSplit('4:abc:5')).toThrow();
    expect(() => parseSplit('4:0:5')).toThrow();
  });
});

describe('computeBenchmarkSha8', () => {
  test('produces stable 8-hex hash', () => {
    const tasks = [
      { task_id: 't1', task: 'a', judge: { kind: 'rule' as const, checks: [{ op: 'max_chars' as const, arg: 100 }] } },
    ];
    const h = computeBenchmarkSha8(tasks);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test('reordering tasks produces same hash (sort-stable)', () => {
    const t1 = { task_id: 't1', task: 'a', judge: { kind: 'rule' as const, checks: [{ op: 'max_chars' as const, arg: 100 }] } };
    const t2 = { task_id: 't2', task: 'b', judge: { kind: 'rule' as const, checks: [{ op: 'max_chars' as const, arg: 200 }] } };
    expect(computeBenchmarkSha8([t1, t2])).toBe(computeBenchmarkSha8([t2, t1]));
  });
});
