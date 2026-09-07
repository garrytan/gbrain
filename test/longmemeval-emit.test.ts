/**
 * emit.ts — the JSONL emitter's file modes (truncate / append), the atomic
 * by_type_summary rewrite and the resume-file compaction. The same-file
 * --resume-from path (judge backfill included) APPENDS and compacts, so the
 * resume file (paid reader rows) is never truncated while a run is in flight;
 * the summary writer and the compactor rename a temp file over the original.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEmitter, emitByTypeSummary, compactJsonlByQuestionId } from '../src/eval/longmemeval/emit.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lme-emit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('makeEmitter', () => {
  test('truncate mode (default) replaces the file', () => {
    const p = join(dir, 'out.ndjson');
    writeFileSync(p, JSON.stringify({ question_id: 'old' }) + '\n');
    const em = makeEmitter(p, false);
    em.emit({ question_id: 'new' });
    em.close();
    expect(lines(p).map((r) => r.question_id)).toEqual(['new']);
  });

  test('append mode keeps prior rows', () => {
    const p = join(dir, 'out.ndjson');
    writeFileSync(p, JSON.stringify({ question_id: 'old' }) + '\n');
    const em = makeEmitter(p, true);
    em.emit({ question_id: 'new' });
    em.close();
    expect(lines(p).map((r) => r.question_id)).toEqual(['old', 'new']);
  });

  test('the summary writer replaces a stale summary line and lands as the final line', () => {
    const p = join(dir, 'run.ndjson');
    writeFileSync(p, JSON.stringify({ question_id: 'q1' }) + '\n' + JSON.stringify({ kind: 'by_type_summary', stale: true }) + '\n');
    const em = makeEmitter(p, true);
    em.emit({ question_id: 'q1', judge_correct: false });
    em.close();
    emitByTypeSummary(p, { kind: 'by_type_summary', k: 5 } as never);
    const rows = lines(p);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ question_id: 'q1' });
    expect(rows[1]).toEqual({ question_id: 'q1', judge_correct: false });
    expect(rows[2].kind).toBe('by_type_summary');
    expect(rows[2].stale).toBeUndefined();
  });
});

describe('emitByTypeSummary is atomic', () => {
  test('writes <path>.summary.tmp then renames: the temp file is gone and the content is complete', () => {
    const p = join(dir, 'run.ndjson');
    writeFileSync(p, [
      JSON.stringify({ question_id: 'q1', hypothesis: 'paid answer' }),
      JSON.stringify({ kind: 'by_type_summary', stale: true }),
      '{"question_id":"q2","hypo', // corrupt tail is kept as-is (the resume loader skips it)
    ].join('\n') + '\n');
    emitByTypeSummary(p, { kind: 'by_type_summary', k: 5, recall_by_type: {} } as never);
    expect(existsSync(`${p}.summary.tmp`)).toBe(false);
    const raw = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[0])).toEqual({ question_id: 'q1', hypothesis: 'paid answer' });
    expect(raw[1]).toBe('{"question_id":"q2","hypo');
    const summary = JSON.parse(raw[2]);
    expect(summary.kind).toBe('by_type_summary');
    expect(summary.stale).toBeUndefined();
    expect(summary._meta.metric_glossary['recall_all@5']).toBeDefined();
  });

  test('a missing output file is created (no prior rows)', () => {
    const p = join(dir, 'fresh.ndjson');
    emitByTypeSummary(p, { kind: 'by_type_summary', k: 3 } as never);
    expect(existsSync(`${p}.summary.tmp`)).toBe(false);
    expect(lines(p).map((r) => r.kind)).toEqual(['by_type_summary']);
  });
});

describe('compactJsonlByQuestionId (append-as-you-go resume files)', () => {
  test('keeps the LAST row per question_id in first-seen order, drops summary lines and a corrupt tail, and is atomic', () => {
    const p = join(dir, 'run.ndjson');
    writeFileSync(p, [
      JSON.stringify({ question_id: 'q1', hypothesis: 'v1' }),
      JSON.stringify({ question_id: 'q2', error: 'reader failed', hypothesis: '' }),
      JSON.stringify({ kind: 'by_type_summary', stale: true }),
      JSON.stringify({ question_id: 'q1', hypothesis: 'v1', judge_correct: true }),   // judged backfill duplicate
      JSON.stringify({ question_id: 'q2', hypothesis: 'retry answer' }),            // retry supersedes the error row
      JSON.stringify({ question_id: 'q3', hypothesis: 'v3' }),
      '{"question_id":"q4","hypo',                                                  // SIGKILL tail
    ].join('\n') + '\n');
    const c = compactJsonlByQuestionId(p);
    expect(c).toEqual({ rows: 3, superseded: 2, summaries_dropped: 1 });
    expect(lines(p)).toEqual([
      { question_id: 'q1', hypothesis: 'v1', judge_correct: true },
      { question_id: 'q2', hypothesis: 'retry answer' },
      { question_id: 'q3', hypothesis: 'v3' },
    ]);
    expect(existsSync(`${p}.compact.tmp`)).toBe(false);
    // Idempotent.
    expect(compactJsonlByQuestionId(p)).toEqual({ rows: 3, superseded: 0, summaries_dropped: 0 });
  });

  test('a missing file is a no-op', () => {
    expect(compactJsonlByQuestionId(join(dir, 'nope.ndjson'))).toEqual({ rows: 0, superseded: 0, summaries_dropped: 0 });
  });
});
