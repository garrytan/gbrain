/**
 * src/eval/shared/autocut-replay.ts (+ scripts/replay-autocut-floor.ts CLI) —
 * pure pins on synthetic pools. No engine, no network.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFloors,
  parseReplayNdjson,
  normalizePoolRow,
  replayRow,
  sweepFloors,
  validateLive,
  splitHalf,
  topScoreHistogram,
  pairedDelta,
  type LiveAutocut,
  type PoolRow,
  type ReplayRow,
} from '../src/eval/shared/autocut-replay.ts';

function pool(scores: number[], sessions?: string[], extra: Partial<PoolRow>[] = []): PoolRow[] {
  return scores.map((s, i) => ({
    slug: `chat/s${sessions ? sessions[i] : i}`,
    chunk_id: i,
    session_id: sessions ? sessions[i] : `S${i}`,
    rrf_rank: i,
    rerank_score: s,
    est_tokens: 100,
    ...(extra[i] ?? {}),
  }));
}

/**
 * The LIVE decisions the shipped default (jump 0.2, minKeep 1, floor 0.35)
 * makes on the four fixture pools — HARDCODED literals, worked by hand, NOT
 * computed through applyAutocut. validateLive compares the replay against
 * these, so the pin breaks if EITHER applyAutocut or the replay drifts (a
 * fixture built by calling applyAutocut would agree with itself trivially).
 *
 *   q1 [0.9 0.85 0.3 0.28 0.27]  normalized by 0.9: gaps .056 .611 .022 .011
 *      → cliff after rank 2, gapRatio (0.85-0.3)/0.9, keep 2 of 5
 *   q2 [0.95 … 0.89 0.2] (8)      → cliff after rank 7, gapRatio (0.89-0.2)/0.95, keep 7 of 8
 *   q3 [0.3 0.1 0.05]             → top 0.3 < floor 0.35: no-op, keep 3 of 3, gapRatio 0
 *   q4 [0.6 0.59 0.1]             → cliff after rank 2, gapRatio (0.59-0.1)/0.6, keep 2 of 3
 */
const LIVE: Record<string, { pool: number[]; autocut: LiveAutocut; kept_keys: string[] }> = {
  q1: {
    pool: [0.9, 0.85, 0.3, 0.28, 0.27],
    autocut: { applied: true, kept: 2, total: 5, gapRatio: 0.6111111111111112 },
    kept_keys: ['chat/s0#0', 'chat/s1#1'],
  },
  q2: {
    pool: [0.95, 0.94, 0.93, 0.92, 0.91, 0.9, 0.89, 0.2],
    autocut: { applied: true, kept: 7, total: 8, gapRatio: 0.7263157894736842 },
    kept_keys: ['chat/s0#0', 'chat/s1#1', 'chat/s2#2', 'chat/s3#3', 'chat/s4#4', 'chat/s5#5', 'chat/s6#6'],
  },
  q3: {
    pool: [0.3, 0.1, 0.05],
    autocut: { applied: false, kept: 3, total: 3, gapRatio: 0 },
    kept_keys: ['chat/s0#0', 'chat/s1#1', 'chat/s2#2'],
  },
  q4: {
    pool: [0.6, 0.59, 0.1],
    autocut: { applied: true, kept: 2, total: 3, gapRatio: 0.8166666666666667 },
    kept_keys: ['chat/s0#0', 'chat/s1#1'],
  },
};

/** Build a fixture row from the hardcoded LIVE table (the pool's scores come from the table too). */
function liveRow(question_id: keyof typeof LIVE, gold: string[], question_type = 'single-session-user'): ReplayRow {
  const fx = LIVE[question_id];
  return {
    question_id,
    question_type,
    rerank_pool: pool(fx.pool),
    autocut: { ...fx.autocut },
    autocut_kept_keys: [...fx.kept_keys],
    answer_session_ids: gold,
  };
}

describe('parseFloors', () => {
  test('parses off + numeric floors, rejects junk', () => {
    expect(parseFloors('off,0.10,0.35')).toEqual(['off', 0.1, 0.35]);
    expect(parseFloors(' OFF , 1 ')).toEqual(['off', 1]);
    expect(() => parseFloors('1.5')).toThrow(/invalid autocut floor/);
    expect(() => parseFloors('abc')).toThrow(/invalid autocut floor/);
    expect(() => parseFloors('')).toThrow(/no floors/);
  });
});

describe('replayRow', () => {
  test('OFF replay equals the pool (no trim), returned window is the first k', () => {
    const p = pool([0.9, 0.2, 0.1, 0.05, 0.04, 0.03, 0.02]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S1'] };
    const r = replayRow(row, 'off', 5);
    expect(r.kept).toEqual(p);
    expect(r.decision.applied).toBe(false);
    expect(r.returned.length).toBe(5);
    expect(r.distinct_sessions).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
    expect(r.recall_all_hit).toBe(true);
    expect(r.returned_est_tokens).toBe(500);
  });

  test('reproduces a known applyAutocut decision at floor 0.35 (cliff after rank 2 → keeps 2)', () => {
    const p = pool([0.9, 0.85, 0.3, 0.28, 0.27]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S2'] };
    const r = replayRow(row, 0.35, 5);
    expect(r.decision.applied).toBe(true);
    expect(r.decision.kept).toBe(2);
    expect(r.kept.map((x) => x.session_id)).toEqual(['S0', 'S1']);
    expect(r.recall_all_hit).toBe(false); // S2 was cut
    expect(r.recall_any_hit).toBe(true);
    expect(r.returned_count).toBe(2);
    expect(r.returned_est_tokens).toBe(200);
    // Same pool replayed OFF keeps S2 in the top 5.
    expect(replayRow(row, 'off', 5).recall_all_hit).toBe(true);
  });

  test('a pool whose largest gap sits at position 7 does not change the k=5 window', () => {
    const p = pool([0.95, 0.94, 0.93, 0.92, 0.91, 0.9, 0.89, 0.2, 0.19, 0.18]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S4'] };
    const cut = replayRow(row, 0.35, 5);
    const off = replayRow(row, 'off', 5);
    expect(cut.decision.applied).toBe(true);
    expect(cut.decision.kept).toBe(7); // the cliff IS found at 7 on the full pool…
    expect(cut.returned).toEqual(off.returned); // …but the returned k=5 window is identical
    expect(cut.recall_all_hit).toBe(true);
    expect(cut.returned_est_tokens).toBe(off.returned_est_tokens);
  });

  test('weak top below the floor → no-op; floor sweep is monotone (recall never rises as the floor drops)', () => {
    // top 0.5, cliff after rank 1; gold sits at ranks 0 and 1.
    const p = pool([0.5, 0.1, 0.09, 0.08, 0.07]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S1'] };
    const high = replayRow(row, 0.65, 5); // 0.5 < 0.65 → autocut no-ops
    expect(high.decision.applied).toBe(false);
    expect(high.recall_all_hit).toBe(true);
    const low = replayRow(row, 0.35, 5); // 0.5 >= 0.35 → cut fires → S1 lost
    expect(low.decision.applied).toBe(true);
    expect(low.decision.kept).toBe(1);
    expect(low.recall_all_hit).toBe(false);
    const floors: Array<number | 'off'> = ['off', 0.8, 0.65, 0.5, 0.35, 0.2, 0.1];
    const hits = floors.map((f) => Number(replayRow(row, f, 5).recall_all_hit));
    for (let i = 1; i < hits.length; i++) expect(hits[i]).toBeLessThanOrEqual(hits[i - 1]);
  });

  test('alias_hit rows survive the cut (preserve predicate), matching hybrid.ts', () => {
    const p = pool([0.9, 0.85, 0.3, 0.28], undefined, [{}, {}, {}, { alias_hit: true, rerank_score: null }]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S3'] };
    const r = replayRow(row, 0.35, 5);
    expect(r.kept.map((x) => x.session_id)).toEqual(['S0', 'S1', 'S3']);
    expect(r.recall_all_hit).toBe(true);
  });

  test('relational_pinned rows survive the cut AND sit outside the cliff math, matching hybrid.ts', () => {
    // Scored cliff: 0.9, 0.88 | 0.5, 0.48 (gap 0.42 after rank 2). A pinned row
    // scored 0.05 sits last: if its score entered the cliff math the largest
    // gap would move to AFTER 0.48 (0.53 -> 0.06 = 0.48) and, with the pin
    // preserved anyway, nothing would be cut. Live hybrid.ts excludes it, so
    // the cliff stays after rank 2 and the pin rides through the cut.
    const p = pool([0.9, 0.88, 0.5, 0.48, 0.05], undefined, [{}, {}, {}, {}, { relational_pinned: true }]);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['S0', 'S4'] };
    const r = replayRow(row, 0.35, 5);
    expect(r.decision.applied).toBe(true);
    expect(r.decision.total).toBe(5);
    expect(r.decision.kept).toBe(3);
    expect(r.kept.map((x) => x.session_id)).toEqual(['S0', 'S1', 'S4']);
    expect(r.recall_all_hit).toBe(true);
    // Control: the SAME pool with the pin flag dropped lets 0.05 enter the
    // cliff math — the largest gap moves to the tail, so 4 rows are kept and
    // the 0.05 row (no longer preserved) is the one cut.
    const unpinned = { ...row, rerank_pool: pool([0.9, 0.88, 0.5, 0.48, 0.05]) };
    const c = replayRow(unpinned, 0.35, 5);
    expect(c.decision.kept).toBe(4);
    expect(c.kept.map((x) => x.session_id)).toEqual(['S0', 'S1', 'S2', 'S3']);
    // A pinned row that is also unscored (no rerank_score) still survives.
    const unscoredPin = pool([0.9, 0.88, 0.5, 0.48, 0], undefined, [{}, {}, {}, {}, { relational_pinned: true, rerank_score: null }]);
    expect(replayRow({ ...row, rerank_pool: unscoredPin }, 0.35, 5).kept.map((x) => x.session_id)).toEqual(['S0', 'S1', 'S4']);
    // The weak-top histogram reads the same scoreOf view: a pin can never be the top.
    const pinOnlyTop = pool([0.3, 0.95], undefined, [{}, { relational_pinned: true }]);
    const hist = topScoreHistogram([{ question_id: 'h', rerank_pool: pinOnlyTop, answer_session_ids: [] }]);
    expect(hist.find((b) => b.bin_start === 0.3)?.count).toBe(1);
    expect(hist.find((b) => b.bin_start === 0.9)?.count).toBe(0);
  });

  test('distinct sessions count each session once; empty gold is never a recall_all hit', () => {
    const p = pool([0.9, 0.89, 0.88, 0.87, 0.86, 0.85], ['A', 'A', 'B', 'B', 'C', 'D']);
    const row: ReplayRow = { question_id: 'q', rerank_pool: p, answer_session_ids: ['A', 'B', 'C'] };
    const r = replayRow(row, 'off', 5);
    expect(r.distinct_sessions).toEqual(['A', 'B', 'C']);
    expect(r.recall_all_hit).toBe(true);
    expect(replayRow({ ...row, answer_session_ids: ['A', 'D'] }, 'off', 5).recall_all_hit).toBe(false);
    expect(replayRow({ ...row, answer_session_ids: [] }, 'off', 5).recall_all_hit).toBe(false);
    expect(replayRow({ ...row, answer_session_ids: [] }, 'off', 5).recall_any_hit).toBe(false);
  });
});

describe('validateLive', () => {
  test('passes on a self-consistent fixture, fails on a tampered one naming the row', () => {
    const rows: ReplayRow[] = [
      liveRow('q1', ['S0']),
      liveRow('q2', ['S0', 'S4']),
      liveRow('q3', ['S0']), // weak top: live no-op
    ];
    expect(validateLive(rows, 0.35)).toEqual([]);

    const tampered: ReplayRow[] = [rows[0], { ...rows[1], autocut: { ...rows[1].autocut!, kept: rows[1].autocut!.kept + 1 } }, rows[2]];
    const mism = validateLive(tampered, 0.35);
    expect(mism.length).toBe(1);
    expect(mism[0].question_id).toBe('q2');
    expect(mism[0].reason).toContain('kept live=');

    // tampered kept set (same count) is also caught via autocut_kept_keys
    const keys = [...rows[0].autocut_kept_keys!];
    keys[0] = 'chat/other#99';
    const mism2 = validateLive([{ ...rows[0], autocut_kept_keys: keys }], 0.35);
    expect(mism2.length).toBe(1);
    expect(mism2[0].reason).toContain('kept set differs');

    // validating at a different floor than the capture ran at is a mismatch (that is the point)
    expect(validateLive(rows, 'off').length).toBeGreaterThan(0);
    // a row with no recorded decision cannot be validated
    expect(validateLive([{ ...rows[0], autocut: null }], 0.35)[0].reason).toContain('no live autocut decision');
  });

  test('the OK path is pinned to hand-worked literals: a drift in applied/kept/total/gapRatio or the kept set fails', () => {
    // Each of these is the literal the live path recorded; flipping ANY field
    // (as an applyAutocut or replay regression would) must surface.
    const q1 = liveRow('q1', ['S0']);
    expect(q1.autocut).toEqual({ applied: true, kept: 2, total: 5, gapRatio: 0.6111111111111112 });
    expect(validateLive([q1], 0.35)).toEqual([]);
    expect(validateLive([{ ...q1, autocut: { ...q1.autocut!, gapRatio: 0.61 } }], 0.35)[0].reason).toContain('gapRatio live=0.61');
    expect(validateLive([{ ...q1, autocut: { ...q1.autocut!, applied: false } }], 0.35)[0].reason).toContain('applied live=false');
    expect(validateLive([{ ...q1, autocut_kept_keys: ['chat/s0#0', 'chat/s2#2'] }], 0.35)[0].reason).toContain('kept set differs');
    // …and the replayed decision reported back is the same literal object.
    const rep = replayRow(q1, 0.35, 5).decision;
    expect(rep).toEqual({ applied: true, signal: 'rerank', cut: 2, kept: 2, total: 5, gapRatio: 0.6111111111111112 });
    expect(replayRow(liveRow('q3', ['S0']), 0.35, 5).decision).toEqual({ applied: false, signal: 'none', cut: 3, kept: 3, total: 3, gapRatio: 0 });
  });

  test('a capture that omitted rows the live pool held is named as such (not an opaque kept mismatch)', () => {
    // Live saw 7 rows (5 scored + 2 unscored alias injections) and kept 4; the
    // capture only carried the 5 scored rows.
    const row: ReplayRow = {
      question_id: 'q-omitted',
      rerank_pool: pool([0.9, 0.85, 0.3, 0.28, 0.27]),
      autocut: { applied: true, kept: 4, total: 7, gapRatio: 0.6111111111111112 },
      answer_session_ids: ['S0'],
    };
    const mism = validateLive([row], 0.35);
    expect(mism.length).toBe(1);
    expect(mism[0].reason).toContain('live pool held 2 row(s) the capture omitted (live total=7, captured pool=5)');
    // The reverse direction is named too.
    const extra: ReplayRow = { ...row, autocut: { applied: true, kept: 2, total: 4, gapRatio: 0.6111111111111112 } };
    expect(validateLive([extra], 0.35)[0].reason).toContain('captured pool has 1 row(s) the live pool lacked');
    // And a capture that DOES carry the unscored alias rows validates cleanly.
    const full: ReplayRow = {
      ...row,
      rerank_pool: [
        ...pool([0.9, 0.85, 0.3, 0.28, 0.27]),
        { slug: 'people/alias-a', chunk_id: null, session_id: 'A', alias_hit: true },
        { slug: 'people/exact-b', chunk_id: null, session_id: 'B', exact_lookup: true },
      ],
      autocut_kept_keys: ['chat/s0#0', 'chat/s1#1', 'people/alias-a#', 'people/exact-b#'],
    };
    expect(validateLive([full], 0.35)).toEqual([]);
  });
});

describe('sweepFloors + paired + split-half', () => {
  const rows: ReplayRow[] = [
    liveRow('q1', ['S0', 'S2'], 'temporal-reasoning'),
    liveRow('q2', ['S0', 'S4'], 'multi-session'),
    liveRow('q3', ['S0'], 'single-session-user'),
    liveRow('q4', ['S0', 'S1'], 'temporal-reasoning'),
  ];

  test('summaries per floor carry counts, per-type breakdown and the benefit metrics', () => {
    const sweep = sweepFloors(rows, ['off', 0.35], 5);
    expect(sweep.floors).toEqual(['off', '0.35']);
    const off = sweep.summaries[0];
    const cut = sweep.summaries[1];
    expect(off.n).toBe(4);
    expect(off.recall_all_hit).toBe(4);
    expect(off.autocut_applied).toBe(0);
    expect(cut.recall_all_hit).toBe(3); // q1 loses S2
    expect(cut.autocut_applied).toBe(3); // q1, q2, q4 fire; q3 weak-top no-op
    expect(cut.by_type['temporal-reasoning']).toEqual({ n: 2, all_hit: 1, any_hit: 2 });
    expect(cut.mean_returned_results).toBeLessThan(off.mean_returned_results);
    expect(cut.mean_returned_est_tokens).toBeLessThan(off.mean_returned_est_tokens);
    // paired vs the first floor (off)
    expect(sweep.paired[1].losses).toBe(1);
    expect(sweep.paired[1].lost_question_ids).toEqual(['q1']);
    expect(sweep.paired[1].by_type_net['temporal-reasoning']).toBe(-1);
    expect(sweep.paired[0].net).toBe(0);
  });

  test('pairedDelta wins/losses are per question', () => {
    const a = rows.map((r) => replayRow(r, 'off', 5));
    const b = rows.map((r) => replayRow(r, 0.35, 5));
    const d = pairedDelta(a, b); // off vs 0.35 → off wins q1 back
    expect(d.wins).toBe(1);
    expect(d.losses).toBe(0);
    expect(d.floor).toBe('off');
    expect(d.baseline_floor).toBe('0.35');
  });

  test('split-half is deterministic per seed, partitions the rows, and is order-independent', () => {
    const s1 = splitHalf(rows, 'seed42');
    const s2 = splitHalf([...rows].reverse(), 'seed42');
    expect(s1.a.map((r) => r.question_id)).toEqual(s2.a.map((r) => r.question_id));
    expect(s1.a.length + s1.b.length).toBe(rows.length);
    expect(s1.a.length).toBe(2);
    const ids = [...s1.a, ...s1.b].map((r) => r.question_id).sort();
    expect(ids).toEqual(['q1', 'q2', 'q3', 'q4']);
    const s3 = splitHalf(rows, 'seed43');
    // different seed → (almost surely) different split on 4 rows; at minimum both are valid partitions
    expect(s3.a.length + s3.b.length).toBe(4);
    const sweep = sweepFloors(rows, ['off', 0.35], 5, { splitSeed: 'seed42' });
    expect(sweep.split?.seed).toBe('seed42');
    expect(sweep.split?.a[0].n).toBe(2);
    expect(sweep.split?.b[0].n).toBe(2);
  });

  test('top-score histogram bins each row once by its max rerank score', () => {
    const h = topScoreHistogram(rows, 0.1);
    expect(h.length).toBe(10);
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(4);
    expect(h[9].count).toBe(2); // 0.9 and 0.95
    expect(h[3].count).toBe(1); // 0.3
    expect(h[6].count).toBe(1); // 0.6
  });
});

describe('parseReplayNdjson', () => {
  test('keeps question rows, skips summary + error rows, aborts on a missing pool naming the row', () => {
    const good = JSON.stringify({ question_id: 'q1', question_type: 't', rerank_pool: pool([0.9, 0.1]), search_meta: { autocut: { applied: true, kept: 1 } }, answer_session_ids: ['S0'] });
    const errRow = JSON.stringify({ question_id: 'q2', error: 'boom' });
    const summary = JSON.stringify({ summary: true, total: 1 });
    const parsed = parseReplayNdjson(`${summary}\n${good}\n\n${errRow}\n`);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].autocut).toEqual({ applied: true, kept: 1 });
    expect(parsed.skipped_error_rows).toBe(1);
    expect(parsed.skipped_non_question_rows).toBe(1);
    expect(() => parseReplayNdjson(JSON.stringify({ question_id: 'q9', answer_session_ids: [] }))).toThrow(/q9.*rerank_pool/);
    expect(() => parseReplayNdjson('{not json')).toThrow(/line 1/);
  });

  test('carries the exact harness pool shape incl. UNSCORED alias / exact-lookup rows; malformed rows abort naming row + index', () => {
    // The harness records the exact pre-autocut returnPool: scored rows carry
    // rerank_score; alias-hop / exact-lookup injections have NO rerank_score
    // (arrived post-rerank) but carry alias_hit / exact_lookup: true.
    const captured = {
      question_id: 'q1',
      question_type: 'single-session-user',
      rerank_pool: [
        { slug: 'chat/s0', chunk_id: 0, session_id: 'S0', rrf_rank: 1, rerank_score: 0.9, est_tokens: 100 },
        { slug: 'chat/s1', chunk_id: 1, session_id: 'S1', rrf_rank: 3, rerank_score: 0.85, est_tokens: 120 },
        { slug: 'chat/s2', chunk_id: 2, session_id: 'S2', rrf_rank: 2, rerank_score: 0.3, est_tokens: 90 },
        { slug: 'people/alias-a', chunk_id: null, session_id: 'A', alias_hit: true, est_tokens: 40 },
        { slug: 'people/exact-b', chunk_id: null, session_id: 'B', exact_lookup: true, est_tokens: 30 },
        { slug: 'chat/unscored', chunk_id: 9, session_id: 'U', rerank_score: null, est_tokens: 10 },
      ],
      autocut: { applied: true, kept: 4, total: 6, gapRatio: (0.85 - 0.3) / 0.9 },
      autocut_kept_keys: ['chat/s0#0', 'chat/s1#1', 'people/alias-a#', 'people/exact-b#'],
      answer_session_ids: ['S0', 'A'],
    };
    const parsed = parseReplayNdjson(JSON.stringify(captured) + '\n');
    expect(parsed.rows.length).toBe(1);
    const p = parsed.rows[0].rerank_pool;
    expect(p.length).toBe(6); // every row carried, unscored included
    expect(p[3]).toEqual({ slug: 'people/alias-a', chunk_id: null, session_id: 'A', rerank_score: null, alias_hit: true, est_tokens: 40 });
    expect(p[4]).toEqual({ slug: 'people/exact-b', chunk_id: null, session_id: 'B', rerank_score: null, exact_lookup: true, est_tokens: 30 });
    expect(p[5].rerank_score).toBeNull();
    expect(p[1].rrf_rank).toBe(3);
    // Replay sees the same pool the live call saw: total 6, the two preserved
    // injections survive, the unscored non-preserved row is dropped (hybrid.ts semantics).
    const rep = replayRow(parsed.rows[0], 0.35, 5);
    expect(rep.decision.total).toBe(6);
    expect(rep.kept.map((r) => r.slug)).toEqual(['chat/s0', 'chat/s1', 'people/alias-a', 'people/exact-b']);
    expect(rep.recall_all_hit).toBe(true); // gold A is the alias row
    expect(rep.returned_est_tokens).toBe(100 + 120 + 40 + 30);
    expect(validateLive(parsed.rows, 0.35)).toEqual([]);

    // Malformed rows abort with row + index, never silently drop.
    expect(() => normalizePoolRow({ slug: 'x' }, 'row q1 rerank_pool[2]')).toThrow(/row q1 rerank_pool\[2\].*no session_id/);
    expect(() => normalizePoolRow({ session_id: 'S' }, 'w')).toThrow(/no slug/);
    expect(() => normalizePoolRow('nope', 'w')).toThrow(/not an object/);
    const bad = { ...captured, rerank_pool: [captured.rerank_pool[0], { slug: 'chat/no-session', chunk_id: 1 }] };
    expect(() => parseReplayNdjson(JSON.stringify(bad))).toThrow(/row q1 \(line 1\) rerank_pool\[1\]/);
    // A non-finite score is carried as unscored (null), not as a number.
    expect(normalizePoolRow({ slug: 'a', session_id: 's', rerank_score: 'NaN' }, 'w').rerank_score).toBeNull();
    // exact_lookup / relational_pinned are carried only when literally true (the capture's own shape).
    expect(normalizePoolRow({ slug: 'a', session_id: 's', exact_lookup: false }, 'w').exact_lookup).toBeUndefined();
    expect(normalizePoolRow({ slug: 'a', session_id: 's', relational_pinned: false }, 'w').relational_pinned).toBeUndefined();
    expect(normalizePoolRow({ slug: 'a', session_id: 's', relational_pinned: true, rerank_score: 0.05 }, 'w')).toEqual({
      slug: 'a',
      session_id: 's',
      rerank_score: 0.05,
      relational_pinned: true,
    });
  });
});

describe('scripts/replay-autocut-floor.ts (CLI)', () => {
  test('validate-live passes on a consistent capture and fails (exit 1) on a tampered one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autocut-replay-'));
    try {
      const rows: ReplayRow[] = [
        liveRow('q1', ['S0', 'S2'], 'temporal-reasoning'),
        liveRow('q2', ['S0', 'S4'], 'multi-session'),
      ];
      const okFile = join(dir, 'ok.ndjson');
      writeFileSync(okFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n' + JSON.stringify({ summary: true }) + '\n');
      const r = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', okFile, '--floors', 'off,0.35,0.65', '--k', '5', '--validate-live', '0.35', '--split-half', 'seed42', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.rows).toBe(2);
      expect(out.validate_live.mismatches).toEqual([]);
      expect(out.floors).toEqual(['off', '0.35', '0.65']);
      expect(out.summaries[0].recall_all_hit).toBe(2);
      expect(out.summaries[1].recall_all_hit).toBe(1);
      expect(out.split.seed).toBe('seed42');
      // Every printed metric resolves through the shared glossary (no local fallback lines).
      for (const key of ['recall_all@k', 'recall_any@k', 'mean_returned_results', 'mean_returned_est_tokens']) {
        expect(out._meta.metric_glossary[key], key).toBeTruthy();
      }
      expect(Object.keys(out._meta.metric_glossary).sort()).toEqual(['mean_returned_est_tokens', 'mean_returned_results', 'recall_all@k', 'recall_any@k']);

      const badFile = join(dir, 'bad.ndjson');
      const tampered = { ...rows[0], autocut: { ...rows[0].autocut!, kept: 5 } };
      writeFileSync(badFile, [tampered, rows[1]].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const r2 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', badFile, '--floors', 'off,0.35', '--validate-live', '0.35'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
      expect(r2.status).toBe(1);
      expect(r2.stdout).toContain('validate-live @ 0.35: FAIL');
      expect(r2.stdout).toContain('q1');

      const r3 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', okFile], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(r3.status).toBe(2); // --floors required

      // --validate-live takes exactly ONE floor: a comma list used to be
      // silently truncated to its first entry.
      const r4 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', okFile, '--floors', 'off,0.35', '--validate-live', '0.35,0.5'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
      expect(r4.status).toBe(2);
      expect(r4.stderr).toContain('--validate-live takes exactly one floor (got 2');
      expect(r4.stdout).toBe(''); // nothing was replayed

      // Current harness rows carry answer_session_ids; captures produced
      // before that carried only gold COUNTS (gold_total / gold_found). Without
      // --dataset such an older capture must be refused — scoring against an
      // empty gold set printed 0% recall at every floor once.
      const noGold = rows.map(({ answer_session_ids: _drop, ...rest }) => ({ ...rest, gold_total: _drop.length }));
      const noGoldFile = join(dir, 'nogold.ndjson');
      writeFileSync(noGoldFile, noGold.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const r5 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', noGoldFile, '--floors', 'off,0.35'], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(r5.status).toBe(1);
      expect(r5.stderr).toContain('2 of 2 capture row(s) carry no answer_session_ids');

      // --dataset joins the gold by question_id (JSON array, the LongMemEval shape) → same scores as the self-contained capture.
      const dsFile = join(dir, 'dataset.json');
      writeFileSync(dsFile, JSON.stringify(rows.map((r) => ({ question_id: r.question_id, question_type: r.question_type, answer_session_ids: r.answer_session_ids, haystack_sessions: [] }))));
      const r6 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', noGoldFile, '--dataset', dsFile, '--floors', 'off,0.35,0.65', '--k', '5', '--json'], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(r6.status).toBe(0);
      const out6 = JSON.parse(r6.stdout);
      expect(out6.summaries[0].recall_all_hit).toBe(2);
      expect(out6.summaries[1].recall_all_hit).toBe(1);

      // A capture question missing from the dataset is an error, not a silent zero.
      writeFileSync(dsFile, JSON.stringify([{ question_id: 'q1', answer_session_ids: ['S0', 'S2'] }]));
      const r7 = spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', noGoldFile, '--dataset', dsFile, '--floors', 'off,0.35'], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(r7.status).toBe(1);
      expect(r7.stderr).toContain('1 capture row(s) have no question in');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gold join refuses MIXED gold-less captures, usage-errors on bad floors, and treats a non-array dataset gold as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autocut-replay-'));
    const run = (args: string[]) => spawnSync('bun', ['run', 'scripts/replay-autocut-floor.ts', ...args], { cwd: process.cwd(), encoding: 'utf-8' });
    try {
      const withGold = liveRow('q1', ['S0', 'S2'], 'temporal-reasoning');
      const { answer_session_ids: _drop, ...noGoldQ2 } = liveRow('q2', ['S0', 'S4'], 'multi-session');
      const mixedFile = join(dir, 'mixed.ndjson');
      writeFileSync(mixedFile, [withGold, { ...noGoldQ2, gold_total: 2 }].map((r) => JSON.stringify(r)).join('\n') + '\n');

      // (a) ONE gold-less row among gold-carrying rows, no --dataset: refused
      // with the count — pre-fix only an all-gold-less capture was refused and
      // the gold-less row silently scored as a miss at every floor.
      const r1 = run([mixedFile, '--floors', 'off,0.35', '--json']);
      expect(r1.status).toBe(1);
      expect(r1.stderr).toContain('1 of 2 capture row(s) carry no answer_session_ids');
      expect(r1.stderr).toContain('--dataset');
      expect(r1.stdout).toBe('');

      // (b) an invalid floor is a USAGE error (exit 2, the documented code),
      // not an uncaught stack trace exiting 1.
      const r2 = run([mixedFile, '--floors', 'off,1.5']);
      expect(r2.status).toBe(2);
      expect(r2.stderr).toContain("--floors: invalid autocut floor '1.5'");
      expect(r2.stderr).toContain('usage:');
      expect(r2.stderr).not.toContain('at parseFloors');
      const r3 = run([mixedFile, '--floors', 'off,0.35', '--validate-live', 'abc']);
      expect(r3.status).toBe(2);
      expect(r3.stderr).toContain("--validate-live: invalid autocut floor 'abc'");

      // (c) a dataset row whose answer_session_ids is missing / not an array
      // is MISSING gold (exit 1, counted), never joined as [].
      const dsFile = join(dir, 'dataset.json');
      writeFileSync(dsFile, JSON.stringify([{ question_id: 'q1', answer_session_ids: ['S0', 'S2'] }, { question_id: 'q2', answer_session_ids: 'S0' }]));
      const r4 = run([mixedFile, '--dataset', dsFile, '--floors', 'off,0.35', '--json']);
      expect(r4.status).toBe(1);
      expect(r4.stderr).toContain('1 capture row(s) match a question in');
      expect(r4.stderr).toContain('answer_session_ids is missing or not a non-empty array');
      expect(r4.stdout).toBe('');
      writeFileSync(dsFile, JSON.stringify([{ question_id: 'q2', question_type: 'multi-session' }]));
      const r5 = run([mixedFile, '--dataset', dsFile, '--floors', 'off,0.35']);
      expect(r5.status).toBe(1);
      expect(r5.stderr).toContain('1 capture row(s) match a question in');

      // …and with a proper array the same mixed capture scores (the gold-carrying row is left alone).
      writeFileSync(dsFile, JSON.stringify([{ question_id: 'q2', answer_session_ids: ['S0', 'S4'] }]));
      const r6 = run([mixedFile, '--dataset', dsFile, '--floors', 'off,0.35', '--k', '5', '--json']);
      expect(r6.status).toBe(0);
      const out6 = JSON.parse(r6.stdout);
      expect(out6.rows).toBe(2);
      expect(out6.summaries[0].recall_all_hit).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
