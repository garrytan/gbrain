/**
 * autocut-replay.ts — pure replay of the autocut floor sweep over captured
 * rerank pools (plan Phase C / D24).
 *
 * INVARIANT: the replay uses the SAME `applyAutocut` the live search path
 * uses, over the SAME pre-autocut reranked pool, with the SAME preserve
 * predicate — so `validateLive` can demand byte-for-byte agreement with the
 * recorded live decision before any other floor cell is trusted. Slicing to
 * k happens AFTER autocut, exactly like hybrid.ts (autocut runs on the full
 * post-rerank pool, then `slice(offset, offset + limit)`); a replay over only
 * the returned k rows would find different cliffs.
 *
 * Metric semantics mirror the harness (plan 0d): `distinct` = distinct
 * session ids among the first k CHUNK rows of the kept pool;
 * `recall_all` = gold ⊆ distinct; `recall_any` = gold ∩ distinct ≠ ∅. The
 * benefit metric (why autocut exists) is the mean kept result count and the
 * mean kept `est_tokens` over that returned window. No I/O here — the script
 * `scripts/replay-autocut-floor.ts` owns argv, file reading and printing.
 */

import { applyAutocut, DEFAULT_AUTOCUT, type AutocutDecision } from '../../core/search/autocut.ts';
import { mulberry32 } from './bootstrap.ts';

/**
 * One captured row of the EXACT pre-autocut `returnPool` (harness
 * `--capture-pool`): scored rows carry a finite `rerank_score`; alias-hop /
 * exact-lookup injections arrive post-rerank and are UNSCORED
 * (`rerank_score` absent or null) but flagged `alias_hit` / `exact_lookup`;
 * relational pins are flagged `relational_pinned` (scored low by construction,
 * so hybrid.ts keeps them OUT of the cliff math and preserves them). All kinds
 * are carried — dropping a row would change what `applyAutocut` sees (and
 * `decision.total`) versus the live call.
 */
export interface PoolRow {
  slug: string;
  chunk_id?: string | number | null;
  session_id: string;
  rrf_rank?: number;
  rerank_score?: number | null;
  alias_hit?: boolean;
  exact_lookup?: boolean;
  relational_pinned?: boolean;
  est_tokens?: number;
}

/** Live decision as recorded by the harness (`search_meta.autocut`). */
export interface LiveAutocut {
  applied: boolean;
  kept: number;
  total?: number;
  cut?: number;
  gapRatio?: number;
  signal?: string;
}

export interface ReplayRow {
  question_id: string;
  question_type?: string;
  rerank_pool: PoolRow[];
  /** The live decision for the capture arm (recorded at floor 0.35). */
  autocut?: LiveAutocut | null;
  /** Optional exact kept set the harness recorded (`slug#chunk_id` keys). */
  autocut_kept_keys?: string[];
  answer_session_ids: string[];
}

/** A floor is the `minTopScore` weak-top floor; 'off' disables autocut. */
export type Floor = number | 'off';

export interface ReplayKnobs {
  jumpRatio: number;
  minKeep: number;
}

export const DEFAULT_REPLAY_KNOBS: ReplayKnobs = Object.freeze({
  jumpRatio: DEFAULT_AUTOCUT.jumpRatio,
  minKeep: DEFAULT_AUTOCUT.minKeep,
});

export function poolKey(r: PoolRow): string {
  return `${r.slug}#${r.chunk_id ?? ''}`;
}

/**
 * Same score accessor hybrid.ts passes to applyAutocut: a relational-pinned
 * row is UNSCORED for the cliff math (live: `x.relational_pinned ? undefined :
 * x.rerank_score`) — its low-by-construction score must not manufacture or
 * mask a cliff. Every other row scores by `rerank_score` (null = unscored).
 */
export function scoreOf(r: PoolRow): number | null | undefined {
  return r.relational_pinned === true ? undefined : r.rerank_score;
}

/**
 * Same preserve predicate hybrid.ts passes to applyAutocut (alias hop / exact
 * lookup / relational pin survive the cut). Live it reads `x.alias_hit === true
 * || x.exact_lookup !== undefined || x.relational_pinned === true`; the capture
 * writes `exact_lookup: true` exactly when the live row had `exact_lookup !==
 * undefined` (and `relational_pinned: true` iff live), so on the captured shape
 * this is the identical predicate.
 */
export function preservePredicate(r: PoolRow): boolean {
  return r.alias_hit === true || r.exact_lookup === true || r.relational_pinned === true;
}

/**
 * Normalize one captured pool row. Throws on a row that cannot be replayed
 * (no slug / session_id): a silently dropped row would shift `total` and every
 * cliff. `rerank_score` is carried as a finite number or null (unscored);
 * booleans are carried only when literally `true` (the capture's own shape).
 */
export function normalizePoolRow(raw: unknown, where: string): PoolRow {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: pool row is not an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== 'string' || o.slug.length === 0) throw new Error(`${where}: pool row has no slug`);
  if (typeof o.session_id !== 'string' || o.session_id.length === 0) throw new Error(`${where}: pool row ${o.slug} has no session_id`);
  const row: PoolRow = { slug: o.slug, session_id: o.session_id };
  if (typeof o.chunk_id === 'string' || typeof o.chunk_id === 'number') row.chunk_id = o.chunk_id;
  else if (o.chunk_id === null) row.chunk_id = null;
  if (typeof o.rrf_rank === 'number' && Number.isFinite(o.rrf_rank)) row.rrf_rank = o.rrf_rank;
  row.rerank_score = typeof o.rerank_score === 'number' && Number.isFinite(o.rerank_score) ? o.rerank_score : null;
  if (o.alias_hit === true) row.alias_hit = true;
  if (o.exact_lookup === true) row.exact_lookup = true;
  if (o.relational_pinned === true) row.relational_pinned = true;
  if (typeof o.est_tokens === 'number' && Number.isFinite(o.est_tokens)) row.est_tokens = o.est_tokens;
  return row;
}

export function parseFloors(spec: string): Floor[] {
  const out: Floor[] = [];
  for (const raw of spec.split(',')) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (t.toLowerCase() === 'off') {
      out.push('off');
      continue;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`invalid autocut floor '${t}' (expected 'off' or a number in [0, 1])`);
    out.push(n);
  }
  if (out.length === 0) throw new Error('no floors given');
  return out;
}

export function floorLabel(f: Floor): string {
  return f === 'off' ? 'off' : f.toFixed(2);
}

export interface RowReplay {
  question_id: string;
  question_type: string;
  floor: Floor;
  decision: AutocutDecision;
  /** Kept pool (pre-slice), in pool order. */
  kept: PoolRow[];
  /** The returned window: first k kept chunk rows. */
  returned: PoolRow[];
  distinct_sessions: string[];
  recall_all_hit: boolean;
  recall_any_hit: boolean;
  returned_count: number;
  returned_est_tokens: number;
}

/** Replay one row at one floor. Pure. */
export function replayRow(row: ReplayRow, floor: Floor, k: number, knobs: ReplayKnobs = DEFAULT_REPLAY_KNOBS): RowReplay {
  const pool = row.rerank_pool;
  let kept: PoolRow[];
  let decision: AutocutDecision;
  if (floor === 'off') {
    kept = pool;
    decision = { applied: false, signal: 'none', cut: pool.length, kept: pool.length, total: pool.length, gapRatio: 0 };
  } else {
    const r = applyAutocut(pool, scoreOf, { enabled: true, jumpRatio: knobs.jumpRatio, minKeep: knobs.minKeep, minTopScore: floor }, preservePredicate);
    kept = r.kept;
    decision = r.decision;
  }
  const returned = kept.slice(0, k);
  const distinct: string[] = [];
  for (const r of returned) if (!distinct.includes(r.session_id)) distinct.push(r.session_id);
  const gold = new Set(row.answer_session_ids ?? []);
  const distinctSet = new Set(distinct);
  const recall_all_hit = gold.size > 0 && [...gold].every((g) => distinctSet.has(g));
  const recall_any_hit = [...gold].some((g) => distinctSet.has(g));
  return {
    question_id: row.question_id,
    question_type: row.question_type ?? 'unknown',
    floor,
    decision,
    kept,
    returned,
    distinct_sessions: distinct,
    recall_all_hit,
    recall_any_hit,
    returned_count: returned.length,
    returned_est_tokens: returned.reduce((s, r) => s + (Number.isFinite(r.est_tokens) ? (r.est_tokens as number) : 0), 0),
  };
}

export interface TypeSummary {
  n: number;
  all_hit: number;
  any_hit: number;
}

export interface FloorSummary {
  floor: string;
  n: number;
  recall_all_hit: number;
  recall_all_rate: number;
  recall_any_hit: number;
  recall_any_rate: number;
  autocut_applied: number;
  mean_returned_results: number;
  mean_returned_est_tokens: number;
  mean_kept_pool: number;
  by_type: Record<string, TypeSummary>;
}

export function summarizeFloor(replays: RowReplay[], floor: Floor): FloorSummary {
  const n = replays.length;
  const by_type: Record<string, TypeSummary> = {};
  let all = 0;
  let any = 0;
  let applied = 0;
  let results = 0;
  let tokens = 0;
  let keptPool = 0;
  for (const r of replays) {
    const t = (by_type[r.question_type] ??= { n: 0, all_hit: 0, any_hit: 0 });
    t.n++;
    if (r.recall_all_hit) {
      all++;
      t.all_hit++;
    }
    if (r.recall_any_hit) {
      any++;
      t.any_hit++;
    }
    if (r.decision.applied) applied++;
    results += r.returned_count;
    tokens += r.returned_est_tokens;
    keptPool += r.kept.length;
  }
  const mean = (x: number) => (n === 0 ? 0 : x / n);
  return {
    floor: floorLabel(floor),
    n,
    recall_all_hit: all,
    recall_all_rate: mean(all),
    recall_any_hit: any,
    recall_any_rate: mean(any),
    autocut_applied: applied,
    mean_returned_results: mean(results),
    mean_returned_est_tokens: mean(tokens),
    mean_kept_pool: mean(keptPool),
    by_type,
  };
}

export interface PairedDelta {
  floor: string;
  baseline_floor: string;
  wins: number;
  losses: number;
  net: number;
  /** Per-type net (all_hit at floor − all_hit at baseline). */
  by_type_net: Record<string, number>;
  lost_question_ids: string[];
}

/** Paired recall_all comparison of `floor` against `baseline`, row by row. */
export function pairedDelta(atFloor: RowReplay[], atBaseline: RowReplay[]): PairedDelta {
  const base = new Map(atBaseline.map((r) => [r.question_id, r]));
  let wins = 0;
  let losses = 0;
  const by_type_net: Record<string, number> = {};
  const lost: string[] = [];
  for (const r of atFloor) {
    const b = base.get(r.question_id);
    if (!b) continue;
    const d = Number(r.recall_all_hit) - Number(b.recall_all_hit);
    if (d > 0) wins++;
    if (d < 0) {
      losses++;
      lost.push(r.question_id);
    }
    by_type_net[r.question_type] = (by_type_net[r.question_type] ?? 0) + d;
  }
  return {
    floor: atFloor[0] ? floorLabel(atFloor[0].floor) : '?',
    baseline_floor: atBaseline[0] ? floorLabel(atBaseline[0].floor) : '?',
    wins,
    losses,
    net: wins - losses,
    by_type_net,
    lost_question_ids: lost,
  };
}

export interface LiveMismatch {
  question_id: string;
  reason: string;
  live: LiveAutocut | null | undefined;
  replayed: AutocutDecision;
}

/**
 * Assert the replay at `floor` reproduces every row's recorded live decision:
 * `applied` and `kept` must agree (and `total` / `gapRatio` when recorded);
 * when the harness recorded `autocut_kept_keys`, the kept SET must match too.
 * Rows without a recorded decision are mismatches (nothing to validate against).
 */
export function validateLive(rows: ReplayRow[], floor: Floor, knobs: ReplayKnobs = DEFAULT_REPLAY_KNOBS): LiveMismatch[] {
  const out: LiveMismatch[] = [];
  for (const row of rows) {
    const rep = replayRow(row, floor, Number.MAX_SAFE_INTEGER, knobs);
    const live = row.autocut;
    if (!live) {
      out.push({ question_id: row.question_id, reason: 'no live autocut decision recorded', live, replayed: rep.decision });
      continue;
    }
    const reasons: string[] = [];
    // Pool-size disagreement first: it explains every downstream difference
    // (a missing unscored alias row shifts total, kept and the cliff), so name
    // it directly instead of letting it surface as an opaque kept mismatch.
    if (typeof live.total === 'number' && live.total !== rep.decision.total) {
      const diff = live.total - rep.decision.total;
      reasons.push(
        diff > 0
          ? `live pool held ${diff} row(s) the capture omitted (live total=${live.total}, captured pool=${rep.decision.total})`
          : `captured pool has ${-diff} row(s) the live pool lacked (live total=${live.total}, captured pool=${rep.decision.total})`,
      );
    }
    if (live.applied !== rep.decision.applied) reasons.push(`applied live=${live.applied} replay=${rep.decision.applied}`);
    if (live.kept !== rep.decision.kept) reasons.push(`kept live=${live.kept} replay=${rep.decision.kept}`);
    if (typeof live.gapRatio === 'number' && Math.abs(live.gapRatio - rep.decision.gapRatio) > 1e-9) {
      reasons.push(`gapRatio live=${live.gapRatio} replay=${rep.decision.gapRatio}`);
    }
    if (Array.isArray(row.autocut_kept_keys)) {
      const liveKeys = [...row.autocut_kept_keys].sort();
      const repKeys = rep.kept.map(poolKey).sort();
      if (liveKeys.length !== repKeys.length || liveKeys.some((k, i) => k !== repKeys[i])) reasons.push('kept set differs from autocut_kept_keys');
    }
    if (reasons.length > 0) out.push({ question_id: row.question_id, reason: reasons.join('; '), live, replayed: rep.decision });
  }
  return out;
}

/** 32-bit FNV-1a over a string → uint32 (deterministic seed derivation). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Seeded 50/50 split by question_id (sorted first so input order is
 * irrelevant). Half A gets the ceil when n is odd. Deterministic for a seed.
 */
export function splitHalf<T extends { question_id: string }>(rows: T[], seed: string): { a: T[]; b: T[] } {
  const sorted = [...rows].sort((x, y) => (x.question_id < y.question_id ? -1 : x.question_id > y.question_id ? 1 : 0));
  const rnd = mulberry32(fnv1a32(seed));
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  const mid = Math.ceil(sorted.length / 2);
  return { a: sorted.slice(0, mid), b: sorted.slice(mid) };
}

/**
 * Histogram of each row's TOP rerank score (the weak-top floor's input) — over
 * the same `scoreOf` view autocut sees, so pinned rows never supply the top.
 */
export function topScoreHistogram(rows: ReplayRow[], binWidth = 0.1): Array<{ bin_start: number; bin_end: number; count: number }> {
  const bins = Math.max(1, Math.round(1 / binWidth));
  const counts = new Array<number>(bins).fill(0);
  let above = 0;
  for (const row of rows) {
    const scores = row.rerank_pool.map(scoreOf).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
    if (scores.length === 0) continue;
    const top = Math.max(...scores);
    if (top >= 1) {
      above++;
      continue;
    }
    // +1e-9 guards the binary-float edge (0.3 / 0.1 = 2.9999…) so 0.3 lands in [0.3, 0.4).
    counts[Math.min(bins - 1, Math.max(0, Math.floor(top / binWidth + 1e-9)))]++;
  }
  const out = counts.map((count, i) => ({ bin_start: +(i * binWidth).toFixed(6), bin_end: +((i + 1) * binWidth).toFixed(6), count }));
  if (above > 0) out[out.length - 1].count += above;
  return out;
}

export interface SweepResult {
  k: number;
  knobs: ReplayKnobs;
  floors: string[];
  summaries: FloorSummary[];
  /** Paired deltas of every floor against the FIRST floor in the list. */
  paired: PairedDelta[];
  top_score_histogram: ReturnType<typeof topScoreHistogram>;
  split?: { seed: string; a: FloorSummary[]; b: FloorSummary[] };
}

/** Run the whole sweep. Pure. */
export function sweepFloors(rows: ReplayRow[], floors: Floor[], k: number, opts: { knobs?: ReplayKnobs; splitSeed?: string } = {}): SweepResult {
  const knobs = opts.knobs ?? DEFAULT_REPLAY_KNOBS;
  const perFloor = floors.map((f) => rows.map((row) => replayRow(row, f, k, knobs)));
  const summaries = perFloor.map((reps, i) => summarizeFloor(reps, floors[i]));
  const paired = perFloor.map((reps) => pairedDelta(reps, perFloor[0]));
  const result: SweepResult = {
    k,
    knobs,
    floors: floors.map(floorLabel),
    summaries,
    paired,
    top_score_histogram: topScoreHistogram(rows),
  };
  if (opts.splitSeed !== undefined) {
    const { a, b } = splitHalf(rows, opts.splitSeed);
    result.split = {
      seed: opts.splitSeed,
      a: floors.map((f) => summarizeFloor(a.map((row) => replayRow(row, f, k, knobs)), f)),
      b: floors.map((f) => summarizeFloor(b.map((row) => replayRow(row, f, k, knobs)), f)),
    };
  }
  return result;
}

export interface ParsedNdjson {
  rows: ReplayRow[];
  skipped_error_rows: number;
  skipped_non_question_rows: number;
}

/**
 * Parse harness ndjson text into replay rows. Question rows carry
 * `question_id`; rows with an `error` field are skipped (counted); a question
 * row WITHOUT `rerank_pool` aborts, naming the row (plan error registry:
 * "autocut replay missing pool"). Summary/meta rows are skipped. Every pool
 * row is normalized through `normalizePoolRow` — unscored alias / exact-lookup
 * rows and relational pins are carried, malformed rows abort naming row + index.
 */
export function parseReplayNdjson(text: string): ParsedNdjson {
  const rows: ReplayRow[] = [];
  let skipped_error_rows = 0;
  let skipped_non_question_rows = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`);
    }
    if (typeof obj.question_id !== 'string') {
      skipped_non_question_rows++;
      continue;
    }
    if (obj.error !== undefined && obj.error !== null) {
      skipped_error_rows++;
      continue;
    }
    if (!Array.isArray(obj.rerank_pool)) {
      throw new Error(`row ${obj.question_id} (line ${i + 1}) has no rerank_pool — capture the arm with --capture-pool`);
    }
    rows.push({
      question_id: obj.question_id,
      question_type: typeof obj.question_type === 'string' ? obj.question_type : undefined,
      rerank_pool: (obj.rerank_pool as unknown[]).map((r, j) => normalizePoolRow(r, `row ${obj.question_id} (line ${i + 1}) rerank_pool[${j}]`)),
      autocut: (obj.autocut ?? (obj.search_meta as { autocut?: LiveAutocut } | undefined)?.autocut ?? null) as LiveAutocut | null,
      autocut_kept_keys: Array.isArray(obj.autocut_kept_keys) ? (obj.autocut_kept_keys as string[]) : undefined,
      answer_session_ids: Array.isArray(obj.answer_session_ids) ? (obj.answer_session_ids as string[]) : [],
    });
  }
  return { rows, skipped_error_rows, skipped_non_question_rows };
}
