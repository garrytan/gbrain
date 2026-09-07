/**
 * resume.ts — re-scoring prior rows (pure, no engine).
 *
 *   - seedBucketsFromRows: `goldMissing` / `collisions` count EVERY question
 *     row (abstention-excluded, no-gold, not-in-dataset and error rows
 *     included) — the same set the live harness counts — so
 *     `run_config.gold_missing_from_haystack` / `slug_collisions` are
 *     identical for a fresh run and a resume of the same file; only
 *     SCORED rows feed the buckets.
 *   - legacy (pre-stamp) rows carry slug-normalized ids (lowercased, `_`/`.`
 *     → `-`); with `haystackByQid` they are mapped back to the RAW id and
 *     re-score as hits; without it (or on an ambiguous collision) they stay
 *     misses — never false hits.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedBucketsFromRows, readJsonlRows, loadResumeSet, rawifyRetrievedIds } from '../src/eval/longmemeval/resume.ts';
import type { RecallBucket } from '../src/eval/longmemeval/metrics.ts';

describe('seedBucketsFromRows — gold_missing / slug_collisions row set', () => {
  const goldByQid = new Map<string, readonly string[]>([
    ['scored', ['s1']],
    ['abs_abs', ['s9']],
    ['nogold', []],
    ['aborted', ['s3']],
  ]);
  const rows = [
    { question_id: 'scored', question_type: 'single-session-user', hypothesis: 'h', retrieved_session_ids: ['s1'], gold_missing_from_haystack: ['s1'], slug_collision: 1 },
    { question_id: 'abs_abs', question_type: 'single-session-user', hypothesis: 'h', retrieved_session_ids: [], gold_missing_from_haystack: ['s9'], slug_collision: 0 },
    { question_id: 'nogold', question_type: 'multi-session', hypothesis: 'h', retrieved_session_ids: [], gold_missing_from_haystack: [], slug_collision: 2 },
    { question_id: 'not-in-dataset', question_type: 'multi-session', hypothesis: 'h', retrieved_session_ids: [], gold_missing_from_haystack: ['x'], slug_collision: 0 },
    { question_id: 'aborted', question_type: 'multi-session', hypothesis: '', error: 'slug_collision touches a gold session id', slug_collision: 1, slug_collision_gold: ['chat/a-b'] },
    { kind: 'by_type_summary', slug_collision: 5, gold_missing_from_haystack: ['ignored'] },
  ];

  test('counts over every question row; buckets only over scored rows; summary lines ignored', () => {
    const buckets: Record<string, RecallBucket> = {};
    const res = seedBucketsFromRows(rows, buckets, { goldByQid, k: 5, includeAbstention: false });
    // scored + abs_abs + not-in-dataset carry gold_missing; the summary line does not count.
    expect(res.goldMissing).toBe(3);
    // scored + nogold + the collision-abort error row.
    expect(res.collisions).toBe(3);
    expect(res.seeded).toBe(1);
    expect(res.excludedAbstention).toBe(1);
    expect(Object.keys(buckets)).toEqual(['single-session-user']);
    expect(buckets['single-session-user'].total).toBe(1);
    expect(buckets['single-session-user'].all_hit).toBe(1);
  });

  test('--include-abstention changes the buckets, not the integrity counters', () => {
    const buckets: Record<string, RecallBucket> = {};
    const res = seedBucketsFromRows(rows, buckets, { goldByQid, k: 5, includeAbstention: true });
    expect(res.goldMissing).toBe(3);
    expect(res.collisions).toBe(3);
    expect(res.seeded).toBe(2);
    expect(res.excludedAbstention).toBe(0);
  });
});

describe('appended resume files: last row per question_id wins', () => {
  const write = (rows: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const p = join(dir, 'run.ndjson');
    writeFileSync(p, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
    return { p, dir };
  };

  test('readJsonlRows dedupes question rows last-wins at the first-seen position; summary rows pass through', () => {
    const { p, dir } = write([
      { question_id: 'q1', hypothesis: 'old' },
      { kind: 'by_type_summary' },
      { question_id: 'q2', hypothesis: 'x' },
      { question_id: 'q1', hypothesis: 'new', judge_correct: false },
    ]);
    try {
      const rows = readJsonlRows(p);
      expect(rows.map((r) => r.question_id ?? r.kind)).toEqual(['q1', 'by_type_summary', 'q2']);
      expect(rows[0]).toEqual({ question_id: 'q1', hypothesis: 'new', judge_correct: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('loadResumeSet: an appended retry supersedes an earlier error row (done), and a later error row re-opens a question', () => {
    const { p, dir } = write([
      { question_id: 'q1', error: 'boom', hypothesis: '' },
      { question_id: 'q1', hypothesis: 'answered on retry' },
      { question_id: 'q2', hypothesis: 'fine' },
      { question_id: 'q2', error: 'later failure', hypothesis: '' },
      { question_id: 'q3', error: 'boom', hypothesis: '' },
    ]);
    try {
      const done = loadResumeSet(p);
      expect([...done].sort()).toEqual(['q1']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('legacy normalized ids re-score against RAW gold through haystackByQid', () => {
  const goldByQid = new Map<string, readonly string[]>([
    ['mc-1', ['sharegpt_yywfIrx_0']],
    ['mc-2', ['Sess_MULTI_a', 'Sess_MULTI_b']],
    ['col', ['alpha_b']],
  ]);
  const haystackByQid = new Map<string, readonly string[]>([
    ['mc-1', ['sharegpt_yywfIrx_0', 'sharegpt_AbC_1', 'sharegpt_Qz.9_2']],
    ['mc-2', ['Sess_MULTI_a', 'Sess_MULTI_b', 'Sess_DECOY_c']],
    ['col', ['alpha_b', 'alpha-b', 'Other_1']], // alpha_b and alpha-b collide on the slug
  ]);
  const legacyRows = [
    { question_id: 'mc-1', question_type: 'single-session-user', hypothesis: 'h', retrieved_session_ids: ['sharegpt-yywfirx-0', 'sharegpt-abc-1'] },
    { question_id: 'mc-2', question_type: 'multi-session', hypothesis: 'h', retrieved_session_ids: ['sess-multi-a', 'sess-multi-b'] },
  ];

  test('rawifyRetrievedIds: raw ids pass through, normalized ids map to the unique raw id, collisions and unknowns stay as-is', () => {
    expect(rawifyRetrievedIds(['sharegpt-yywfirx-0', 'sharegpt_AbC_1', 'unknown-x'], haystackByQid.get('mc-1'))).toEqual(['sharegpt_yywfIrx_0', 'sharegpt_AbC_1', 'unknown-x']);
    expect(rawifyRetrievedIds(['alpha-b', 'other-1'], haystackByQid.get('col'))).toEqual(['alpha-b', 'Other_1']);
    // A raw AND its normalized twin collapse to one distinct session.
    expect(rawifyRetrievedIds(['sharegpt_yywfIrx_0', 'sharegpt-yywfirx-0'], haystackByQid.get('mc-1'))).toEqual(['sharegpt_yywfIrx_0']);
    expect(rawifyRetrievedIds(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  test('without the map every legacy row is a miss (pre-fix behavior, still never a false hit)', () => {
    const buckets: Record<string, RecallBucket> = {};
    seedBucketsFromRows(legacyRows, buckets, { goldByQid, k: 5, includeAbstention: false });
    expect(buckets['single-session-user']).toMatchObject({ total: 1, all_hit: 0, any_hit: 0 });
    expect(buckets['multi-session']).toMatchObject({ total: 1, all_hit: 0, any_hit: 0 });
  });

  test('with the map the legacy rows re-score as hits', () => {
    const buckets: Record<string, RecallBucket> = {};
    const res = seedBucketsFromRows(legacyRows, buckets, { goldByQid, haystackByQid, k: 5, includeAbstention: false });
    expect(res.seeded).toBe(2);
    expect(buckets['single-session-user']).toMatchObject({ total: 1, all_hit: 1, any_hit: 1 });
    expect(buckets['multi-session']).toMatchObject({ total: 1, all_hit: 1, any_hit: 1 });
    expect(res.distinct).toEqual([2, 2]);
  });

  test('an ambiguous (colliding) normalized id is not resolved to gold', () => {
    const buckets: Record<string, RecallBucket> = {};
    seedBucketsFromRows(
      [{ question_id: 'col', question_type: 'single-session-user', hypothesis: 'h', retrieved_session_ids: ['alpha-b'] }],
      buckets, { goldByQid, haystackByQid, k: 5, includeAbstention: false },
    );
    expect(buckets['single-session-user']).toMatchObject({ total: 1, all_hit: 0, any_hit: 0 });
  });
});
