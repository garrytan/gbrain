/**
 * W7 (wave 4b): the private forecast journal. Every active take that is not
 * a fact is a prediction; the journal gives each one its prediction time
 * (certified or not), exact claim, horizon (src/core/takes-horizon.ts),
 * state and resolution, and keeps the unresolved denominator. The grouped
 * scorecard (`takes_scorecard {group_by}`) reads the same predictions.
 *
 * Trusted local only: the CLI (`gbrain takes journal`, `gbrain takes
 * scorecard --group-by`) and the local op path read it; a remote caller that
 * asks for groups gets `scorecard_group_by_local_only`
 * (src/core/ops/takes.ts).
 *
 * Prediction time: when the belief ledger recorded the exact claim (claim,
 * kind, holder) on the page, either its first live `take.asserted` or, for a
 * take the page was created with, the creation snapshot (see
 * recordedPredictionTimes), certified only where the ledger's coverage
 * certifies that instant (a managed source with no drift or truncated purge
 * walk); without a recorded time, the take's since_date, never certified.
 */
import type { BrainEngine } from './engine.ts';
import { coverageAt, coverageIntervals } from './belief/coverage-report.ts';
import { takeClaimHash } from './belief/keys.ts';
import { gradeJudgeMeasured } from './cycle/grade-takes-measured.ts';
import { readTakeHorizons, type HorizonBasis } from './takes-horizon.ts';

export type JournalState = 'resolved' | 'overdue' | 'open' | 'undated';
export interface PredictionTime { at: string | null; basis: 'recorded' | 'since_date' | null; certified: boolean }
export interface JournalEntry {
  take_id: number; source_id: string; page_slug: string; row_num: number; claim: string; kind: string; holder: string; weight: number | null;
  prediction: PredictionTime;
  horizon: { date: string; basis: HorizonBasis; current: true } | null;
  state: JournalState;
  resolution: { quality: string; resolved_at: string | null; resolved_by: string | null; resolved_source: string | null } | null;
  /** The newest cached grade_takes verdict (W6), applied or not; judge_measured says whether the W6 eval measured its judge and prompt. */
  grade: { verdict: string; confidence: number; applied: boolean; judge_model_id: string; judge_measured: boolean; graded_at: string } | null;
}
export interface JournalTotals { predictions: number; resolved: number; unresolved: number; open: number; overdue: number; undated: number; certified_prediction_times: number }
export interface JournalQuery {
  sourceId?: string; sourceIds?: string[]; holder?: string; about?: string; since?: string; until?: string;
  state?: JournalState; asOf?: Date; limit?: number;
}
export interface ScorecardGroup {
  key: string; n: number; correct: number; incorrect: number; partial: number; unresolvable: number;
  accuracy: number | null; accuracy_shrunk: number | null; accuracy_wilson95: [number, number] | null; accuracy_recent: number | null;
  brier: number | null; brier_skill: number | null; citations: number;
  open: number; overdue: number; undated: number; unresolved: number; low_n: boolean;
}

/** Pseudo-observations of the Beta prior centred on the pooled accuracy. */
export const SCORECARD_PRIOR_STRENGTH = 10;
/** Half-life, in days since resolution, of the recency-weighted accuracy. */
export const SCORECARD_RECENCY_HALF_LIFE_DAYS = 365;
export const SCORECARD_DEFAULT_MIN_N = 10;

const iso = (v: string | Date | null) => v == null ? null : new Date(v).toISOString();

interface TakeRow {
  id: number | string; source_id: string; page_slug: string; row_num: number; claim: string; kind: string; holder: string; weight: number | string | null;
  since_date: string | null; resolved_quality: string | null; resolved_at: string | Date | null; resolved_by: string | null; resolved_source: string | null;
}

async function readPredictions(engine: BrainEngine, q: JournalQuery): Promise<TakeRow[]> {
  const sources = q.sourceIds?.length ? q.sourceIds : q.sourceId ? [q.sourceId] : null;
  return engine.executeRaw<TakeRow>(
    `SELECT t.id, p.source_id, p.slug AS page_slug, t.row_num, t.claim, t.kind, t.holder, t.weight, t.since_date,
            t.resolved_quality, t.resolved_at, t.resolved_by, t.resolved_source
       FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE p.deleted_at IS NULL AND t.active AND t.kind <> 'fact'
        AND ($1::text[] IS NULL OR p.source_id = ANY($1::text[]))
        AND ($2::text IS NULL OR t.holder = $2)
        AND ($3::text IS NULL OR left(p.slug, length($3)) = $3)
        AND ($4::text IS NULL OR t.since_date >= $4)
        AND ($5::text IS NULL OR t.since_date <= $5)
      ORDER BY p.source_id, p.slug, t.row_num`,
    [sources, q.holder ?? null, q.about ?? null, q.since ?? null, q.until ?? null]);
}

interface LedgerRow { source_id: string; slug: string; event_type: string; subject_key: string | null; at: string | Date }

/**
 * Recorded prediction times from the belief ledger, keyed by (source, slug,
 * claim hash), over each page's current lifetime. A take added after its
 * page was created has a live `take.asserted`; its earliest is the time.
 * A take present when the page was created has no per-take creation event
 * (the create is one `page.published` snapshot, BELIEF_LEDGER.md section 4),
 * so it takes the snapshot's time, but only when coverage has run without a
 * stop, restore or drift mark on the page since then: otherwise the take
 * could have been added while the ledger was not watching. A take whose first
 * event is `take.transferred` came from another page and gets no recorded
 * time. Certified only where coverageAt certifies the instant.
 */
async function recordedPredictionTimes(engine: BrainEngine, rows: TakeRow[]): Promise<Map<string, PredictionTime>> {
  const out = new Map<string, PredictionTime>();
  if (!rows.length) return out;
  const sources = [...new Set(rows.map(r => r.source_id))];
  const events = await engine.executeRaw<LedgerRow>(
    `SELECT l.source_id, l.slug, e.event_type, e.subject_key, e.recorded_at AS at
       FROM belief_page_lifetimes l
       JOIN sources s ON s.id = l.source_id AND s.incarnation = l.source_incarnation
       JOIN belief_events e ON e.source_id = l.source_id AND e.source_incarnation = l.source_incarnation AND e.page_lifetime = l.page_lifetime
      WHERE l.ended_at IS NULL AND l.source_id = ANY($1::text[]) AND l.slug = ANY($2::text[]) AND e.origin <> 'backfill'
        AND (e.subject_kind = 'take' OR (e.event_type = 'page.published' AND e.value->>'revision_before' IS NULL))
      ORDER BY e.id`,
    [sources, [...new Set(rows.map(r => r.page_slug))]]);
  const created = new Map<string, string>();
  const firstTakeEvent = new Map<string, { type: string; at: string }>();
  for (const e of events) {
    const page = `${e.source_id}\u0000${e.slug}`;
    if (e.event_type === 'page.published') { if (!created.has(page)) created.set(page, iso(e.at)!); continue; }
    const key = `${page}\u0000${String((JSON.parse(e.subject_key!) as unknown[])[2])}`;
    if (!firstTakeEvent.has(key)) firstTakeEvent.set(key, { type: e.event_type, at: iso(e.at)! });
  }
  const intervals = new Map<string, Awaited<ReturnType<typeof coverageIntervals>>>();
  for (const id of sources) intervals.set(id, await coverageIntervals(engine, id));
  const watchedSince = (sourceId: string, slug: string, at: string) => {
    const open = intervals.get(sourceId)!.at(-1);
    return !!open && !open.stopped_at && open.started_at <= at
      && !open.restores.some(r => r.at > at) && !open.drift.some(d => d.slug === slug && d.to > at);
  };
  for (const r of rows) {
    const page = `${r.source_id}\u0000${r.page_slug}`;
    const key = `${page}\u0000${takeClaimHash(r.claim, r.kind, r.holder)}`;
    if (out.has(key)) continue;
    const first = firstTakeEvent.get(key);
    const pageCreated = created.get(page);
    const at = first?.type === 'take.asserted' ? first.at
      : first?.type === 'take.transferred' || !pageCreated || !watchedSince(r.source_id, r.page_slug, pageCreated) ? null
      : pageCreated;
    if (!at) continue;
    const coverage = await coverageAt(engine, r.source_id, at, r.page_slug);
    if (!coverage.ok) continue;
    out.set(key, { at, basis: 'recorded', certified: coverage.certified });
  }
  return out;
}

/** The journal: entries (filtered by `state`, then capped by `limit`) and totals over every prediction the other filters match. */
export async function readForecastJournal(engine: BrainEngine, q: JournalQuery = {}): Promise<{ as_of: string; entries: JournalEntry[]; totals: JournalTotals }> {
  const asOf = q.asOf ?? new Date();
  const today = asOf.toISOString().slice(0, 10);
  const rows = await readPredictions(engine, q);
  const horizons = await readTakeHorizons(engine, rows.map(r => Number(r.id)));
  const recorded = await recordedPredictionTimes(engine, rows);
  const grades = new Map((await engine.executeRaw<{ take_id: number | string; verdict: string; confidence: number | string; applied: boolean; judge_model_id: string; prompt_version: string; graded_at: string | Date }>(
    `SELECT DISTINCT ON (take_id) take_id, verdict, confidence, applied, judge_model_id, prompt_version, graded_at
       FROM take_grade_cache WHERE take_id = ANY($1::bigint[]) ORDER BY take_id, graded_at DESC`,
    [rows.map(r => Number(r.id))])).map(g => [Number(g.take_id), {
      verdict: g.verdict, confidence: Number(g.confidence), applied: g.applied, judge_model_id: g.judge_model_id,
      judge_measured: gradeJudgeMeasured(g.judge_model_id, g.prompt_version), graded_at: iso(g.graded_at)!,
    }]));
  const all: JournalEntry[] = rows.map(r => {
    const h = horizons.get(Number(r.id));
    const horizon = h?.current ? { date: h.horizon_date, basis: h.basis, current: true as const } : null;
    const state: JournalState = r.resolved_quality ? 'resolved' : !horizon ? 'undated' : horizon.date < today ? 'overdue' : 'open';
    const prediction = recorded.get(`${r.source_id}\u0000${r.page_slug}\u0000${takeClaimHash(r.claim, r.kind, r.holder)}`)
      ?? { at: r.since_date, basis: r.since_date ? 'since_date' as const : null, certified: false };
    return {
      take_id: Number(r.id), source_id: r.source_id, page_slug: r.page_slug, row_num: r.row_num, claim: r.claim, kind: r.kind, holder: r.holder,
      weight: r.weight == null ? null : Number(r.weight), prediction, horizon, state,
      resolution: r.resolved_quality ? { quality: r.resolved_quality, resolved_at: iso(r.resolved_at), resolved_by: r.resolved_by, resolved_source: r.resolved_source } : null,
      grade: grades.get(Number(r.id)) ?? null,
    };
  });
  const count = (s: JournalState) => all.filter(e => e.state === s).length;
  const totals: JournalTotals = {
    predictions: all.length, resolved: count('resolved'), unresolved: all.length - count('resolved'),
    open: count('open'), overdue: count('overdue'), undated: count('undated'),
    certified_prediction_times: all.filter(e => e.prediction.certified).length,
  };
  const filtered = q.state ? all.filter(e => e.state === q.state) : all;
  return { as_of: asOf.toISOString(), entries: q.limit === undefined ? filtered : filtered.slice(0, q.limit), totals };
}

function wilson95(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Per holder or source, over the journal's predictions: accuracy on
 * correct/incorrect resolutions, shrunk toward the pooled accuracy with a
 * Beta prior of SCORECARD_PRIOR_STRENGTH pseudo-observations, its Wilson 95%
 * interval, recency-weighted accuracy, Brier and Brier skill (against the
 * group's own base rate), citations (resolutions naming a source), the open,
 * overdue and undated counts, and low_n when n < minN.
 */
export async function scorecardGroups(engine: BrainEngine, q: JournalQuery & { groupBy: 'holder' | 'source'; minN?: number }): Promise<ScorecardGroup[]> {
  const asOf = q.asOf ?? new Date();
  const { entries } = await readForecastJournal(engine, { ...q, state: undefined, limit: undefined, asOf });
  const byKey = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const key = q.groupBy === 'holder' ? e.holder : e.source_id;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const scored = (e: JournalEntry) => e.resolution?.quality === 'correct' || e.resolution?.quality === 'incorrect';
  const pooledN = entries.filter(scored).length;
  const pooled = pooledN ? entries.filter(e => e.resolution?.quality === 'correct').length / pooledN : 0.5;
  const minN = q.minN ?? SCORECARD_DEFAULT_MIN_N;
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const resolved = group.filter(scored);
    const outcome = (e: JournalEntry) => e.resolution!.quality === 'correct' ? 1 : 0;
    const n = resolved.length;
    const correct = resolved.filter(e => outcome(e) === 1).length;
    const weighted = resolved.filter(e => e.weight != null);
    const brier = weighted.length ? weighted.reduce((s, e) => s + (e.weight! - outcome(e)) ** 2, 0) / weighted.length : null;
    const base = weighted.length ? weighted.filter(e => outcome(e) === 1).length / weighted.length : null;
    const ref = base === null ? 0 : base * (1 - base);
    const dated = resolved.filter(e => e.resolution!.resolved_at);
    const decay = (e: JournalEntry) => 0.5 ** (Math.max(0, asOf.getTime() - Date.parse(e.resolution!.resolved_at!)) / 86_400_000 / SCORECARD_RECENCY_HALF_LIFE_DAYS);
    const wSum = dated.reduce((s, e) => s + decay(e), 0);
    const count = (s: JournalState) => group.filter(e => e.state === s).length;
    return {
      key, n, correct, incorrect: n - correct,
      partial: group.filter(e => e.resolution?.quality === 'partial').length,
      unresolvable: group.filter(e => e.resolution?.quality === 'unresolvable').length,
      accuracy: n ? correct / n : null,
      accuracy_shrunk: (correct + SCORECARD_PRIOR_STRENGTH * pooled) / (n + SCORECARD_PRIOR_STRENGTH),
      accuracy_wilson95: wilson95(correct, n),
      accuracy_recent: wSum > 0 ? dated.reduce((s, e) => s + decay(e) * outcome(e), 0) / wSum : null,
      brier, brier_skill: brier !== null && ref > 0 ? 1 - brier / ref : null,
      citations: resolved.filter(e => e.resolution!.resolved_source?.trim()).length,
      open: count('open'), overdue: count('overdue'), undated: count('undated'), unresolved: group.length - count('resolved'),
      low_n: n < minN,
    };
  });
}
