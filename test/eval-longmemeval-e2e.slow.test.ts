/**
 * v0.41.10 split — end-to-end half of the LongMemEval test surface.
 *
 * Contains every describe that invokes `runEvalLongMemEval(...)`.
 *
 * v0.41.10 engine-sharing optimization: one PGLite brain is created via
 * `createBenchmarkBrain()` in beforeAll and threaded through every
 * runEvalLongMemEval call via `runOpts.engine`. Each call still calls
 * `resetTables()` per-question internally (runOneQuestion's first line),
 * so per-test isolation is preserved. This amortizes the ~1-3s cold-create
 * cost across all 13 invocations in this file, dropping local wallclock
 * from ~15s to ~3-5s.
 *
 * The pure / harness-shared half lives in test/eval-longmemeval.slow.test.ts.
 * Both files run as separate .slow.test.ts entries.
 *
 * Stub MessagesClient lives in test/helpers/longmemeval-stub.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeStubClient } from './helpers/longmemeval-stub.ts';

/** Run with process.exit + stderr captured (the harness exits non-zero on gates). */
async function runCapturing(args: string[], runOpts: Parameters<typeof runEvalLongMemEval>[1]): Promise<{ code: number | null; stderr: string }> {
  let code: number | null = null;
  let stderr = '';
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  // @ts-ignore runtime override for the test
  process.exit = ((c: number) => { code = c; throw new Error('__exit__'); }) as any;
  // @ts-ignore runtime override for the test
  process.stderr.write = ((chunk: any) => { stderr += String(chunk); return true; }) as any;
  try {
    await runEvalLongMemEval(args, runOpts);
  } catch (e) {
    if (!String(e).includes('__exit__')) throw e;
  } finally {
    // @ts-ignore runtime restore
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
  return { code, stderr };
}

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

// One shared brain across the whole file, threaded into every
// runEvalLongMemEval call via runOpts.engine. resetTables is called
// per-question inside runOneQuestion so tests stay isolated.
let sharedEngine: PGLiteEngine;

beforeAll(async () => {
  sharedEngine = await createBenchmarkBrain();
});

afterAll(async () => {
  if (sharedEngine) await sharedEngine.disconnect();
});

// ---------------------------------------------------------------------------
// 8. end-to-end with stubbed LLM
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval: end-to-end with stubbed LLM', () => {
  test('5-question fixture produces 5 valid JSONL lines via --output', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const { client, calls } = makeStubClient('canned-answer-stub');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5', '--output', outPath, '--top-k', '3'],
        { client, engine: sharedEngine },
      );
      expect(existsSync(outPath)).toBe(true);
      const raw = readFileSync(outPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(typeof obj.question_id).toBe('string');
        expect(typeof obj.hypothesis).toBe('string');
        expect(obj.hypothesis).toContain('canned-answer-stub');
      }
      // Stub was called for every question with the right system + user shape.
      // Retrieval may legitimately miss on --keyword-only (websearch AND requires
      // every term to appear in one chunk); the harness wiring is what we're
      // pinning here, not retrieval recall. We assert at least one call had a
      // non-empty <chat_session> block to prove the sanitize + render path
      // executed end-to-end.
      expect(calls.length).toBe(5);
      let withSessionsCount = 0;
      for (const c of calls) {
        expect(c.system).toContain('UNTRUSTED');
        expect(c.userText).toContain('Question:');
        expect(c.userText).toContain('Retrieved sessions:');
        if (c.userText.includes('<chat_session')) withSessionsCount++;
      }
      expect(withSessionsCount).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. end-to-end retrieval-only (no LLM)
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval: --retrieval-only path', () => {
  test('5-question fixture produces 5 lines without an LLM client', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      // No client passed: retrieval-only never calls the client, so this works.
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--retrieval-only',
         '--limit', '5', '--output', outPath, '--top-k', '3'],
        { engine: sharedEngine },
      );
      const raw = readFileSync(outPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(typeof obj.question_id).toBe('string');
        expect(typeof obj.hypothesis).toBe('string');
        // retrieval-only hypotheses include rendered session text
        // (or empty when retrieval missed everything — both are valid).
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 10. JSONL format guard (LF + UTF-8)
// ---------------------------------------------------------------------------

describe('JSONL format guard', () => {
  test('each line ends with \\n, no \\r anywhere, UTF-8 round-trip is byte-equal', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const { client } = makeStubClient('format-stub');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', outPath],
        { client, engine: sharedEngine },
      );
      const buf = readFileSync(outPath);
      // No CR bytes anywhere.
      for (let i = 0; i < buf.length; i++) {
        expect(buf[i]).not.toBe(0x0d);
      }
      // File ends with a single LF.
      expect(buf[buf.length - 1]).toBe(0x0a);
      const text = buf.toString('utf8');
      // UTF-8 round-trip is byte-equal.
      expect(Buffer.from(text, 'utf8').equals(buf)).toBe(true);
      // Each non-empty line is valid JSON.
      const lines = text.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(obj.question_id).toBeDefined();
        expect(obj.hypothesis).toBeDefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 11. JSONL key contract (additive, never replace)
// ---------------------------------------------------------------------------

describe('JSONL key contract', () => {
  test('every line carries question_id + hypothesis at minimum', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--retrieval-only',
         '--limit', '3', '--output', outPath],
        { engine: sharedEngine },
      );
      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(Object.keys(obj)).toContain('question_id');
        expect(Object.keys(obj)).toContain('hypothesis');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 12. per-question failure handling
// ---------------------------------------------------------------------------

describe('per-question failure handling', () => {
  test('one broken question does not kill the run; emits error JSONL line', async () => {
    // Build an in-memory fixture with one malformed entry: missing
    // haystack_sessions array entirely. haystackToPages reads that field,
    // so the per-question try/catch must catch the resulting error.
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const fixturePath = join(tmp, 'broken.jsonl');
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const valid: LongMemEvalQuestion = {
        question_id: 'lme-ok-1',
        question_type: 'single-session-user',
        question: 'apple keyword',
        answer: 'a',
        haystack_dates: ['2025-01-01'],
        answer_session_ids: ['ok-sess'],
        haystack_sessions: [
          { session_id: 'ok-sess', turns: [{ role: 'user', content: 'apple in a session' }] },
        ],
      };
      const broken = {
        question_id: 'lme-broken-1',
        question_type: 'single-session-user',
        question: 'will fail',
        answer: 'a',
        // missing haystack_sessions on purpose
      };
      // Distinct id for the trailing question: the harness dedupes repeated
      // question_ids (WARN + keep-first, plan D12), so a literal repeat of
      // `valid` would be dropped instead of proving the run continued.
      const valid2: LongMemEvalQuestion = { ...valid, question_id: 'lme-ok-2' };
      const { writeFileSync } = await import('fs');
      writeFileSync(
        fixturePath,
        JSON.stringify(valid) + '\n' + JSON.stringify(broken) + '\n' + JSON.stringify(valid2) + '\n',
        'utf8',
      );
      await runEvalLongMemEval(
        [fixturePath, '--keyword-only', '--retrieval-only', '--output', outPath],
        { engine: sharedEngine },
      );
      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      expect(lines.length).toBe(3);
      expect(lines[0].question_id).toBe('lme-ok-1');
      expect(typeof lines[0].hypothesis).toBe('string');
      expect(lines[1].question_id).toBe('lme-broken-1');
      expect(lines[1].hypothesis).toBe('');
      expect(typeof lines[1].error).toBe('string');
      expect(lines[1].error.length).toBeGreaterThan(0);
      expect(lines[2].question_id).toBe('lme-ok-2');
      expect(typeof lines[2].hypothesis).toBe('string');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 13. v0.35.1.0: --resume-from
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval --resume-from (v0.35.1.0)', () => {
  test('skips already-answered questions and appends to the same output file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      // Simulate prior run: 2 questions already answered, written to the file
      // with hypothesis set. The fixture has 5 questions total.
      const { writeFileSync } = await import('fs');
      const fixture = readFileSync(FIXTURE_PATH, 'utf8')
        .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      writeFileSync(
        outPath,
        [
          JSON.stringify({ question_id: fixture[0].question_id, hypothesis: 'prior-1' }),
          JSON.stringify({ question_id: fixture[1].question_id, hypothesis: 'prior-2' }),
        ].join('\n') + '\n',
        'utf8',
      );

      const { client } = makeStubClient('resumed-answer');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5', '--top-k', '3',
         '--output', outPath, '--resume-from', outPath],
        { client, engine: sharedEngine },
      );

      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      // 2 prior rows + 3 new rows = 5 total
      expect(lines.length).toBe(5);
      // First two preserve their prior hypothesis (proves append, not truncate).
      expect(lines[0].hypothesis).toBe('prior-1');
      expect(lines[1].hypothesis).toBe('prior-2');
      // Newly-answered three carry the canned stub.
      for (let i = 2; i < 5; i++) {
        expect(lines[i].hypothesis).toContain('resumed-answer');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('all questions already done -> early return, no client calls', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const outPath = join(tmp, 'all-done.jsonl');
    try {
      const { writeFileSync } = await import('fs');
      const fixture = readFileSync(FIXTURE_PATH, 'utf8')
        .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).slice(0, 5);
      writeFileSync(
        outPath,
        fixture.map(q => JSON.stringify({ question_id: q.question_id, hypothesis: 'done' })).join('\n') + '\n',
        'utf8',
      );
      const { client, calls } = makeStubClient('should-not-be-called');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5',
         '--output', outPath, '--resume-from', outPath],
        { client, engine: sharedEngine },
      );
      // The client must not have been invoked at all — every question was skipped.
      expect(calls.length).toBe(0);
      // The output file is untouched (no new lines appended).
      const lines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 12. v0.40.1.0 (Track D / T1 + T2): question field on every row + --by-type
// summary emission with resume-replace semantics + --by-type-floor exit gate
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval --by-type (v0.40.1.0 Track D / T1+T2)', () => {
  test('per-row JSONL includes the question text (T1, per D9)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const { client } = makeStubClient('canned');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', outPath],
        { client, engine: sharedEngine },
      );
      const lines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const row = JSON.parse(line);
        expect(typeof row.question).toBe('string');
        expect(row.question.length).toBeGreaterThan(0);
        expect(typeof row.question_id).toBe('string');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('--by-type emits a final by_type_summary line; absent when flag not set', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const withFlag = join(tmp, 'with-by-type.jsonl');
    const withoutFlag = join(tmp, 'without-by-type.jsonl');
    try {
      const { client } = makeStubClient('canned');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', withFlag, '--by-type'],
        { client, engine: sharedEngine },
      );
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', withoutFlag],
        { client, engine: sharedEngine },
      );

      // With flag: last line is the summary.
      const withLines = readFileSync(withFlag, 'utf8').split('\n').filter(l => l.length > 0);
      const lastWith = JSON.parse(withLines[withLines.length - 1]);
      expect(lastWith.kind).toBe('by_type_summary');
      // Schema v2 (ranker wave): strict + lenient recall per type, run_config receipt.
      expect(lastWith.schema_version).toBe(2);
      expect(lastWith.metric).toBe('recall_all@k');
      expect(typeof lastWith.recall_by_type).toBe('object');
      expect(typeof lastWith.aggregate.all_hit).toBe('number');
      expect(typeof lastWith.aggregate.any_hit).toBe('number');
      expect(typeof lastWith.aggregate.total).toBe('number');
      expect(typeof lastWith.run_config).toBe('object');
      expect(typeof lastWith.run_config.retrieval_config_hash).toBe('string');
      expect(typeof lastWith._meta.metric_glossary[`recall_all@${lastWith.k}`]).toBe('string');
      // Per-question rows must NOT have kind:by_type_summary.
      for (let i = 0; i < withLines.length - 1; i++) {
        const row = JSON.parse(withLines[i]);
        expect(row.kind).toBeUndefined();
      }

      // Without flag: no summary anywhere.
      const withoutLines = readFileSync(withoutFlag, 'utf8').split('\n').filter(l => l.length > 0);
      for (const line of withoutLines) {
        const row = JSON.parse(line);
        expect(row.kind).toBeUndefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('resume-replace: prior by_type_summary at the tail is REPLACED, not appended', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'resume.jsonl');
    try {
      const { client } = makeStubClient('canned');
      // First run: --limit 3 produces 3 rows + 1 summary = 4 lines.
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', outPath, '--by-type'],
        { client, engine: sharedEngine },
      );
      const firstLines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      const firstSummaryCount = firstLines.filter(l => {
        try { return JSON.parse(l).kind === 'by_type_summary'; } catch { return false; }
      }).length;
      expect(firstSummaryCount).toBe(1);
      expect(firstLines.length).toBe(4);

      // Re-run with --limit 5 + --resume-from same path: 2 NEW questions get
      // processed, by-type fires again, prior summary must be replaced (not
      // duplicated). Exercises the full resume-replace code path.
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5', '--output', outPath,
         '--resume-from', outPath, '--by-type'],
        { client, engine: sharedEngine },
      );
      const secondLines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      const secondSummaryCount = secondLines.filter(l => {
        try { return JSON.parse(l).kind === 'by_type_summary'; } catch { return false; }
      }).length;
      expect(secondSummaryCount).toBe(1);
      // 5 rows + 1 summary = 6 lines (original summary was stripped, new one
      // appended).
      expect(secondLines.length).toBe(6);
      const last = JSON.parse(secondLines[secondLines.length - 1]);
      expect(last.kind).toBe('by_type_summary');
      // Summary aggregates across ALL 5 rows (not just the 2 newly processed).
      // The fixture has ground truth on every row, so total == 5.
      expect(last.aggregate.total).toBe(5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 13. Codex CDX-3 — resume + --by-type-floor must enforce the floor even on
// a no-op resume (where all questions already done). Pre-CDX-3 the early
// return bypassed the floor gate entirely.
// ---------------------------------------------------------------------------

describe('codex CDX-3 — resume + --by-type-floor enforcement on no-op resume', () => {
  test('all-done resume still runs --by-type emission AND --by-type-floor gate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const outPath = join(tmp, 'all-done.jsonl');
    try {
      // Pre-seed the output file with all-failed rows: retrieved_session_ids
      // is EMPTY, so the resume re-scoring (recall is recomputed from the
      // row's retrieved ids + the dataset gold, never trusted from the row)
      // yields recall_all_hit=false / recall_any_hit=false for every row.
      // The stale `recall_hit: false` is ignored. This represents a prior run
      // that completed every question with zero recall — the floor gate
      // should fire even though no questions are processed THIS run.
      const fixture = readFileSync(FIXTURE_PATH, 'utf8')
        .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).slice(0, 5);
      const { writeFileSync } = await import('fs');
      writeFileSync(
        outPath,
        fixture.map(q => JSON.stringify({
          question_id: q.question_id,
          question: q.question,
          question_type: q.question_type,
          hypothesis: 'done',
          retrieved_session_ids: [], // every prior question missed (recomputed on resume)
          recall_hit: false, // deprecated alias; ignored by the v2 seed
        })).join('\n') + '\n',
        'utf8',
      );

      const { client } = makeStubClient('should-not-be-called');
      // Wrap to catch process.exit thrown from inside.
      const exitCapture: { code: number | null } = { code: null };
      const originalExit = process.exit;
      // @ts-ignore — runtime override for test
      process.exit = ((code: number) => {
        exitCapture.code = code;
        throw new Error('__exit__');
      }) as any;
      try {
        await runEvalLongMemEval(
          [FIXTURE_PATH, '--keyword-only', '--limit', '5',
           '--output', outPath, '--resume-from', outPath,
           '--by-type', '--by-type-floor', '0.5'],
          { client, engine: sharedEngine },
        );
      } catch (e) {
        // Expected: --by-type-floor breach → exit(1) → our test throw
        if (!String(e).includes('__exit__')) throw e;
      } finally {
        // @ts-ignore — runtime restore
        process.exit = originalExit;
      }

      // CDX-3: floor gate fired despite no-op resume → exit code 1.
      expect(exitCapture.code).toBe(1);

      // AND a by_type_summary was emitted at the file tail (CDX-3 also says
      // resume must run summary emission even on no-op).
      const lines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      const summaries = lines.filter(l => {
        try { return JSON.parse(l).kind === 'by_type_summary'; } catch { return false; }
      });
      expect(summaries.length).toBe(1);
      const summary = JSON.parse(summaries[0]);
      // Every row re-scored false → aggregate.all_rate is 0 → below 0.5 floor.
      expect(summary.schema_version).toBe(2);
      expect(summary.aggregate.total).toBe(5);
      expect(summary.aggregate.all_rate).toBeLessThan(0.5);
      expect(summary.aggregate.any_rate).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 14. every question errored → exit 1 (never a "completed" run with no scored row)
// ---------------------------------------------------------------------------

describe('a run where EVERY question errored exits 1', () => {
  test('two broken questions → two error rows, FAIL line, exit 1; --record status failed; one broken of two → exit 0', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-all-errored-'));
    try {
      const { writeFileSync } = await import('fs');
      const broken = (id: string) => ({ question_id: id, question_type: 'single-session-user', question: 'will fail', answer: 'a' /* no haystack_sessions */ });
      const valid: LongMemEvalQuestion = {
        question_id: 'lme-ok-1', question_type: 'single-session-user', question: 'apple keyword', answer: 'a',
        haystack_dates: ['2025-01-01'], answer_session_ids: ['ok-sess'],
        haystack_sessions: [{ session_id: 'ok-sess', turns: [{ role: 'user', content: 'apple in a session' }] }],
      };
      const allBroken = join(tmp, 'all-broken.jsonl');
      writeFileSync(allBroken, [broken('b-1'), broken('b-2')].map(q => JSON.stringify(q)).join('\n') + '\n', 'utf8');
      const out = join(tmp, 'all-broken-out.jsonl');
      const recordDir = join(tmp, 'ledger');
      const r = await runCapturing([allBroken, '--keyword-only', '--retrieval-only', '--by-type', '--by-type-floor', '0.5', '--record', '--output', out], { engine: sharedEngine, recordDir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('FAIL every question errored (2/2)');
      const rows = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      expect(rows.filter(x => x.kind !== 'by_type_summary').map(x => x.question_id)).toEqual(['b-1', 'b-2']);
      for (const row of rows.filter(x => x.kind !== 'by_type_summary')) expect(typeof row.error).toBe('string');
      // Empty buckets made every rate null, so the floor alone would have passed.
      expect(r.stderr).not.toContain('FAIL --by-type-floor');
      const ledger = readFileSync(join(recordDir, 'eval-results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      expect(ledger[0].status).toBe('failed');
      expect(ledger[0].params.errors).toBe(2);

      // A partially-errored run is still a completed run (the per-question rows carry the errors).
      const mixed = join(tmp, 'mixed.jsonl');
      writeFileSync(mixed, [JSON.stringify(broken('b-1')), JSON.stringify(valid)].join('\n') + '\n', 'utf8');
      const out2 = join(tmp, 'mixed-out.jsonl');
      const r2 = await runCapturing([mixed, '--keyword-only', '--retrieval-only', '--output', out2], { engine: sharedEngine });
      expect(r2.code).toBeNull();
      expect(r2.stderr).not.toContain('every question errored');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 15. duplicate question_id in the dataset (plan D12): WARN + first wins
// ---------------------------------------------------------------------------

describe('duplicate question_id in the dataset (plan D12)', () => {
  test('WARN on stderr, the FIRST occurrence wins, one row per id, dataset_questions counts the raw lines', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-dup-'));
    try {
      const { writeFileSync } = await import('fs');
      const q = (id: string, question: string): LongMemEvalQuestion => ({
        question_id: id, question_type: 'single-session-user', question, answer: 'a',
        haystack_dates: ['2025-01-01'], answer_session_ids: ['ok-sess'],
        haystack_sessions: [{ session_id: 'ok-sess', turns: [{ role: 'user', content: `${question} in a session` }] }],
      });
      const fixture = join(tmp, 'dup.jsonl');
      writeFileSync(fixture, [q('dup-1', 'apple first'), q('dup-2', 'pear'), q('dup-1', 'apple SECOND')].map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      const out = join(tmp, 'dup-out.jsonl');
      const r = await runCapturing([fixture, '--keyword-only', '--retrieval-only', '--by-type', '--output', out], { engine: sharedEngine });
      expect(r.code).toBeNull();
      expect(r.stderr).toContain('WARN duplicate question_id dup-1 — keeping the first');
      const all = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const rows = all.filter(x => x.kind !== 'by_type_summary');
      expect(rows.map(x => x.question_id)).toEqual(['dup-1', 'dup-2']);
      expect(rows[0].question).toBe('apple first');
      const summary = all.find(x => x.kind === 'by_type_summary');
      expect(summary.run_config.dataset_questions).toBe(3);
      expect(summary.aggregate.total).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
