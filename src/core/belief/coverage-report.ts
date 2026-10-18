/**
 * Coverage reads and repairs of the belief ledger (docs/designs/BELIEF_LEDGER.md
 * sections 5.3, 7.1 and 7.3), shared by `gbrain beliefs`, the doctor check
 * `belief_ledger_coverage` and the cycle's extract phase.
 *
 * - `coverageIntervals`: one interval per activation run of the source's
 *   current incarnation, with its watermark, certified status, baseline
 *   progress, restore gaps and the slugs a drift finding uncertified.
 * - `coverageAt`: whether a recorded-time read at `T` is covered, the coded
 *   refusal `coverage_from` before a page's cut, `coverage_gap` inside a
 *   stopped or restore gap.
 * - `beliefEventVisibility`: the section 5.3 visibility rule over commit marks.
 * - `scanBeliefDrift` / `reconcileBeliefDrift`: slugs whose current belief set
 *   no longer hashes to their newest event's `state_hash`, and the `reconcile`
 *   events that restate them.
 * - `orphanLifetimes`, `unmarkedPublications`: the check's integrity findings.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PurgeReplayState, ReplayRecord } from './purge-mirror.ts';
import { COVERAGE_KEY, pageKey, valueHash } from './keys.ts';
import { appendBeliefEvents, markBeliefCommits, type BeliefEventDraft } from './append.ts';
import { coverageActive, currentStateHash, readLedgerSource } from './ledger.ts';
import { keyedSubjects } from './subjects.ts';
import { endLifetime, readOpenLifetimes } from './lifetimes.ts';

/** One `coverage.restored` (purge-mirror.ts `replayPurgesInRestore`): the archive time and the purge replay outcome. */
export interface RestoreMark { event_id: number; at: string; archived_at: string | null; purge_replay: PurgeReplayState | null; replays: ReplayRecord[] }
export interface DriftMark { slug: string; event_id: number; from: string | null; to: string }
export interface CoverageInterval {
  run: string | null; incarnation: string; started_id: number; started_at: string;
  /** recorded_at of `coverage.complete`: the source's watermark; null while the baseline runs. */
  watermark: string | null;
  stopped_at: string | null;
  /** Only a managed source's completed baseline is certified; links only for journaled publications. */
  certified: boolean;
  links_certified: 'journaled_only' | false;
  baseline: { pages_done: number; pending: number | null; complete: boolean };
  restores: RestoreMark[];
  /** Slug intervals a drift finding uncertified: (from, to], permanently. */
  drift: DriftMark[];
  /** Purge requests whose derivation walk hit its bound in this interval: the interval is not certified (design 6.5). */
  truncated_walks: string[];
}

interface CoverageRow { id: number; event_type: string; recorded_at: string; value: unknown; cause: unknown; incarnation: string }
const iso = (v: unknown) => new Date(v as string).toISOString();
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Record<string, unknown>;
const field = (row: CoverageRow, name: string) => obj(row.value)[name] ?? obj(row.cause)[name];

/** Coverage intervals of the source's current incarnation, oldest first. */
export async function coverageIntervals(engine: BrainEngine, sourceId: string): Promise<CoverageInterval[]> {
  const rows = await engine.executeRaw<CoverageRow>(`SELECT e.id, e.event_type, e.recorded_at, e.value, e.cause, e.source_incarnation::text AS incarnation
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'coverage' AND e.subject_key = $2 ORDER BY e.id`, [sourceId, COVERAGE_KEY]);
  const intervals: CoverageInterval[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    const current = intervals.at(-1);
    if (row.event_type === 'coverage.started') {
      intervals.push({ run: (obj(row.cause).run as string | undefined) ?? null, incarnation: row.incarnation, started_id: id, started_at: iso(row.recorded_at),
        watermark: null, stopped_at: null, certified: false, links_certified: false, baseline: { pages_done: 0, pending: null, complete: false }, restores: [], drift: [], truncated_walks: [] });
      continue;
    }
    if (!current || current.stopped_at) continue;
    if (row.event_type === 'coverage.complete') {
      current.watermark = iso(row.recorded_at);
      current.certified = obj(row.cause).certified === true;
      current.links_certified = current.certified ? 'journaled_only' : false;
      current.baseline.complete = true;
      const pages = obj(row.cause).pages;
      if (typeof pages === 'number') current.baseline.pages_done = pages;
    } else if (row.event_type === 'coverage.stopped') current.stopped_at = iso(row.recorded_at);
    else if (row.event_type === 'coverage.restored') {
      const archive = field(row, 'archived_at');
      const replays = field(row, 'replays');
      current.restores.push({ event_id: id, at: iso(row.recorded_at), archived_at: archive ? iso(archive) : null,
        purge_replay: (field(row, 'purge_replay') as PurgeReplayState | undefined) ?? null, replays: Array.isArray(replays) ? replays as ReplayRecord[] : [] });
    }
  }
  for (const interval of intervals) {
    if (!interval.baseline.complete || !interval.baseline.pages_done) {
      const [done] = await engine.executeRaw<{ n: number }>(`SELECT count(DISTINCT slug)::int AS n FROM belief_events
        WHERE source_id = $1 AND event_type = 'baseline' AND cause->>'run' = $2`, [sourceId, interval.run ?? '']);
      interval.baseline.pages_done = Number(done?.n ?? 0);
    }
    const drift = await engine.executeRaw<{ id: number; slug: string; recorded_at: string; from: string | null }>(`SELECT id, slug, recorded_at, cause->>'uncertified_from' AS "from"
      FROM belief_events WHERE source_id = $1 AND subject_kind = 'page' AND origin = 'reconcile' AND source_incarnation = $2::uuid AND id > $3
        AND ($4::timestamptz IS NULL OR recorded_at <= $4::timestamptz) ORDER BY id`,
    [sourceId, interval.incarnation, interval.started_id, interval.stopped_at]);
    interval.drift = drift.map(d => ({ slug: d.slug, event_id: Number(d.id), from: d.from ? iso(d.from) : null, to: iso(d.recorded_at) }));
    const walks = await engine.executeRaw<{ request: string }>(`SELECT DISTINCT cause->>'purge_request' AS request FROM belief_events
      WHERE source_id = $1 AND event_type = 'derived.hidden' AND cause->>'derived_walk' = 'truncated' AND source_incarnation = $2::uuid AND id > $3
        AND ($4::timestamptz IS NULL OR recorded_at <= $4::timestamptz) ORDER BY 1`, [sourceId, interval.incarnation, interval.started_id, interval.stopped_at]);
    interval.truncated_walks = walks.map(w => w.request);
    if (walks.length) { interval.certified = false; interval.links_certified = false; }
  }
  const open = intervals.at(-1);
  if (open && !open.stopped_at && !open.baseline.complete) {
    const [pending] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM (
        SELECT p.slug FROM pages p WHERE p.source_id = $1
        UNION SELECT f.entity_slug FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL
      ) s WHERE NOT EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = $1 AND e.slug = s.slug AND e.event_type = 'baseline' AND e.cause->>'run' = $2)`,
    [sourceId, open.run ?? '']);
    open.baseline.pending = Number(pending?.n ?? 0);
  }
  return intervals;
}

export type CoverageAt =
  | { ok: true; certified: boolean; uncertified_reason: 'unmanaged' | 'truncated_walk' | 'drift' | null; cut: string; interval: CoverageInterval }
  | { ok: false; code: 'coverage_from'; from: string | null; message: string }
  | { ok: false; code: 'coverage_gap'; reason: 'not_covered' | 'restore'; from: string | null; until: string | null; message: string };

/** The first recorded cut of `slug` in the interval: its baseline, creation snapshot or first page-less assertion, under the slug or its page's lifetime (a renamed page keeps its cut). */
async function slugCut(engine: BrainEngine, sourceId: string, interval: CoverageInterval, slug: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ recorded_at: string }>(`SELECT recorded_at FROM belief_events
    WHERE source_id = $1 AND source_incarnation = $2::uuid AND id > $4 AND origin <> 'backfill'
      AND (slug = $3 OR page_lifetime = (SELECT l.page_lifetime FROM belief_page_lifetimes l WHERE l.source_incarnation = $2::uuid AND l.slug = $3 AND l.ended_at IS NULL))
      AND (event_type = 'baseline' OR (event_type = 'page.published' AND value->>'revision_before' IS NULL)
        OR (page_lifetime IS NULL AND subject_kind = 'fact' AND event_type = 'fact.asserted'))
    ORDER BY id LIMIT 1`, [sourceId, interval.incarnation, slug, interval.started_id]);
  return row ? iso(row.recorded_at) : null;
}

/**
 * Whether a recorded-time read at `at` is answered by the ledger: for a page
 * (`slug`), from its own cut; for the source, from the watermark. Before the
 * cut: `coverage_from`. Between intervals or inside a restore gap
 * ([archive time, restore]): `coverage_gap`. A covered answer says whether it
 * is certified (managed source, no truncated purge walk in the interval, no
 * drift mark over `at`).
 */
export async function coverageAt(engine: BrainEngine, sourceId: string, at: Date | string, slug?: string): Promise<CoverageAt> {
  const t = new Date(at).getTime();
  const intervals = await coverageIntervals(engine, sourceId);
  const first = intervals[0];
  if (!first || t < Date.parse(first.started_at)) {
    return { ok: false, code: 'coverage_from', from: first?.watermark ?? first?.started_at ?? null,
      message: first ? `The belief ledger covers ${sourceId} only from ${first.watermark ?? first.started_at}.` : `The belief ledger has no coverage of ${sourceId}.` };
  }
  const interval = [...intervals].reverse().find(i => Date.parse(i.started_at) <= t);
  if (!interval || (interval.stopped_at && t >= Date.parse(interval.stopped_at))) {
    const next = intervals.find(i => Date.parse(i.started_at) > t) ?? null;
    return { ok: false, code: 'coverage_gap', reason: 'not_covered', from: interval?.stopped_at ?? null, until: next?.started_at ?? null,
      message: `The belief ledger was not recording ${sourceId} at ${new Date(t).toISOString()}.` };
  }
  const gap = interval.restores.find(r => r.archived_at && t > Date.parse(r.archived_at) && t <= Date.parse(r.at));
  if (gap) {
    return { ok: false, code: 'coverage_gap', reason: 'restore', from: gap.archived_at, until: gap.at,
      message: `A backup restore at ${gap.at} replaced the ledger with an archive from ${gap.archived_at}; what happened between them is unknown.` };
  }
  const cut = slug ? await slugCut(engine, sourceId, interval, slug) : interval.watermark;
  if (!cut || t < Date.parse(cut)) {
    return { ok: false, code: 'coverage_from', from: cut,
      message: cut ? `The belief ledger covers ${slug ?? sourceId} only from ${cut}.` : `The baseline of ${slug ?? sourceId} has not run yet.` };
  }
  const drifted = slug ? interval.drift.some(d => d.slug === slug && (d.from == null || t > Date.parse(d.from)) && t <= Date.parse(d.to)) : false;
  return { ok: true, certified: interval.certified && !drifted, cut, interval,
    uncertified_reason: interval.truncated_walks.length ? 'truncated_walk' : !interval.certified ? 'unmanaged' : drifted ? 'drift' : null };
}

/**
 * Section 5.3: at `at`, an event is visible once its publication's commit mark
 * is at or before `at`, not visible when it was recorded after `at`, and
 * otherwise unproven unless a later event of the same page (higher id, same
 * page lock) was recorded at or before `at`.
 */
export async function beliefEventVisibility(engine: BrainEngine, eventId: number, at: Date | string): Promise<'visible' | 'not_visible' | 'unproven'> {
  const [row] = await engine.executeRaw<{ recorded: boolean; observed: boolean; proven: boolean }>(`SELECT e.recorded_at <= $2::timestamptz AS recorded,
      COALESCE(m.observed_at <= $2::timestamptz, false) AS observed,
      EXISTS (SELECT 1 FROM belief_events l WHERE l.source_id = e.source_id AND l.id > e.id AND l.recorded_at <= $2::timestamptz
        AND ((e.page_lifetime IS NOT NULL AND l.page_lifetime = e.page_lifetime) OR (e.page_lifetime IS NULL AND l.slug = e.slug))) AS proven
    FROM belief_events e LEFT JOIN belief_commit_marks m ON m.publication_id = e.publication_id WHERE e.id = $1`, [eventId, new Date(at).toISOString()]);
  if (!row) throw new Error(`belief event not found: ${eventId}`);
  if (row.observed) return 'visible';
  if (!row.recorded) return 'not_visible';
  return row.proven ? 'visible' : 'unproven';
}

export interface DriftFinding { slug: string; recorded_hash: string | null; current_hash: string; last_event_id: number | null }
export interface DriftScan { checked: number; candidates: number; exact: boolean; drifted: DriftFinding[] }
export const DRIFT_SAMPLE_PAGES = 200;
export const UNMARKED_WINDOW_DAYS = 7;

/**
 * Slugs whose current belief set no longer hashes to the `state_hash` of their
 * newest event (a writer changed state without appending). Candidates are the
 * source's pages, page-less fact subjects and open lifetimes, most recently
 * updated first; `deep` checks all of them, otherwise the first `limit`.
 * Runs only on a source whose baseline completed.
 */
export async function scanBeliefDrift(engine: BrainEngine, sourceId: string, opts: { deep?: boolean; limit?: number } = {}): Promise<DriftScan> {
  const source = await readLedgerSource(engine, sourceId);
  if (!source || !coverageActive(source.coverage) || source.coverage === 'coverage.started') return { checked: 0, candidates: 0, exact: true, drifted: [] };
  const candidates = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM (
      SELECT p.slug, p.updated_at AS at FROM pages p WHERE p.source_id = $1
      UNION ALL SELECT f.entity_slug, max(f.created_at) FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.entity_slug IS NOT NULL GROUP BY f.entity_slug
      UNION ALL SELECT l.slug, l.started_at FROM belief_page_lifetimes l WHERE l.source_id = $1 AND l.source_incarnation = $2::uuid AND l.ended_at IS NULL
    ) c GROUP BY slug ORDER BY max(at) DESC NULLS LAST, slug`, [sourceId, source.incarnation]);
  const limit = opts.deep ? candidates.length : Math.min(candidates.length, opts.limit ?? DRIFT_SAMPLE_PAGES);
  const drifted: DriftFinding[] = [];
  for (const { slug } of candidates.slice(0, limit)) {
    const finding = await driftOf(engine, sourceId, source.incarnation, slug);
    if (finding) drifted.push(finding);
  }
  return { checked: limit, candidates: candidates.length, exact: limit === candidates.length, drifted };
}

async function newestEvent(tx: BrainEngine, sourceId: string, incarnation: string, slug: string): Promise<{ id: number; state_hash: string; recorded_at: string } | null> {
  const [row] = await tx.executeRaw<{ id: number; state_hash: string; recorded_at: string }>(`SELECT id, state_hash, recorded_at FROM belief_events
    WHERE source_id = $1 AND source_incarnation = $2::uuid AND slug = $3 AND subject_kind <> 'coverage' AND origin <> 'backfill' ORDER BY id DESC LIMIT 1`, [sourceId, incarnation, slug]);
  return row ? { id: Number(row.id), state_hash: row.state_hash, recorded_at: iso(row.recorded_at) } : null;
}

async function driftOf(engine: BrainEngine, sourceId: string, incarnation: string, slug: string): Promise<DriftFinding | null> {
  return engine.transaction(async tx => {
    const [{ hash, state }, last] = [await currentStateHash(tx, sourceId, incarnation, slug, { readOnly: true }), await newestEvent(tx, sourceId, incarnation, slug)];
    if (last?.state_hash === hash) return null;
    const open = await readOpenLifetimes(tx, [{ incarnation, slug }]);
    if (!last && !state.pages.some(p => p.slug === slug) && !state.facts.length && !open.size) return null;
    return { slug, recorded_hash: last?.state_hash ?? null, current_hash: hash, last_event_id: last?.id ?? null };
  });
}

/** The diff hash of a recorded value: a link's context is carried text, outside the hash (subjects.ts). */
function recordedVhash(r: { subject_kind: string; value: unknown; value_hash: string | null }): string | null {
  if (r.subject_kind !== 'link') return r.value_hash;
  const { context: _context, ...identity } = obj(r.value);
  return valueHash(identity);
}

const PROVEN_KINDS = /\.(asserted|revised|resolved|unresolved|adopted|transferred)$|^baseline$|^reconcile$/;

/**
 * Appends `reconcile` events (origin 'reconcile', recorded_at the append) for
 * one drifted slug, under its page key: one per key whose current value no
 * per-key event after the slug's latest snapshot proves unchanged, one with no
 * value per recorded key that is gone, and one on the page carrying the new
 * full-set state_hash and `uncertified_from` (the previous event's time). On a
 * managed source that interval stays uncertified (coverageIntervals' drift).
 * Returns the events appended (0 when the slug no longer drifts under its key).
 */
export async function reconcileSlug(engine: BrainEngine, sourceId: string, slug: string, opts: { op?: string } = {}): Promise<number> {
  const publicationId = randomUUID();
  const appended = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const source = await readLedgerSource(tx, sourceId);
    if (!source || !coverageActive(source.coverage)) return 0;
    const { hash, state, lifetimes } = await currentStateHash(tx, sourceId, source.incarnation, slug);
    const last = await newestEvent(tx, sourceId, source.incarnation, slug);
    if (last?.state_hash === hash) return 0;
    const page = state.pages.find(p => p.slug === slug) ?? null;
    const lifetime = page ? lifetimes.get(page.id)! : null;
    const subjects = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(page ? [[slug, page]] : []) }, state,
      id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world').filter(s => s.stream === slug && (page && !page.deleted || s.dbOnly));
    const recorded = await tx.executeRaw<{ id: number; subject_kind: string; subject_key: string; event_type: string; value: unknown; value_hash: string | null; trust_tier: string;
      visibility: string; claim_fp: string | null }>(`SELECT DISTINCT ON (subject_kind, subject_key) id, subject_kind, subject_key, event_type, value, value_hash, trust_tier, visibility, claim_fp
      FROM belief_events WHERE source_id = $1 AND source_incarnation = $2::uuid AND slug = $3 AND subject_kind NOT IN ('page','coverage') AND origin <> 'backfill'
        AND id > COALESCE((SELECT max(id) FROM belief_events s WHERE s.source_id = $1 AND s.source_incarnation = $2::uuid AND s.slug = $3 AND s.subject_kind = 'page' AND s.origin <> 'backfill'
          AND (s.event_type IN ('baseline','reconcile') OR (s.event_type = 'page.published' AND s.value->>'revision_before' IS NULL))), 0)
      ORDER BY subject_kind, subject_key, id DESC`, [sourceId, source.incarnation, slug]);
    const proven = new Map(recorded.filter(r => PROVEN_KINDS.test(r.event_type) && r.value_hash).map(r => [`${r.subject_kind}\u0000${r.subject_key}`, recordedVhash(r)]));
    const present = new Set(subjects.map(s => `${s.kind}\u0000${s.key}`));
    const cause = { op: opts.op ?? 'reconcile', drift: true, ...(last ? { prior_event: last.id, uncertified_from: last.recorded_at } : {}) };
    const base = { sourceId, incarnation: source.incarnation, slug, stream: slug, eventType: 'reconcile', stateHash: hash };
    const link = (kind: string) => kind === 'link' || kind === 'link_transition';
    const drafts: BeliefEventDraft[] = subjects.filter(s => proven.get(`${s.kind}\u0000${s.key}`) !== s.vhash).map(s => ({ ...base,
      lifetime: s.dbOnly && !page ? null : lifetime, subjectKind: s.kind, subjectKey: s.key, trustTier: link(s.kind) ? 'unknown' : s.tier,
      tierBasis: link(s.kind) ? 'unknown' as const : 'row' as const, visibility: s.visibility, value: s.value, claimFp: s.claimFp, validFrom: s.validFrom,
      validUntil: s.validUntil, cause: { ...cause, ...(s.rowNum != null ? { row: s.rowNum } : {}), label: s.label } }));
    for (const r of recorded) {
      if (present.has(`${r.subject_kind}\u0000${r.subject_key}`) || !PROVEN_KINDS.test(r.event_type) || !r.value_hash) continue;
      drafts.push({ ...base, lifetime, subjectKind: r.subject_kind as BeliefEventDraft['subjectKind'], subjectKey: r.subject_key, trustTier: r.trust_tier,
        tierBasis: link(r.subject_kind) ? 'unknown' : 'row', visibility: r.visibility, value: null, claimFp: r.claim_fp, cause: { ...cause, absent: true } });
    }
    if (page) {
      const bound = subjects.filter(s => !s.dbOnly);
      drafts.push({ ...base, lifetime, subjectKind: 'page', subjectKey: pageKey(lifetime!), trustTier: page.tier, visibility: page.visible ? 'world' : 'private',
        value: { revision_after: page.revision, full_set: true, counts: { facts: bound.filter(s => s.kind === 'fact').length, takes: bound.filter(s => s.kind === 'take').length,
          links: bound.filter(s => s.kind === 'link').length, link_transitions: bound.filter(s => s.kind === 'link_transition').length }, ...(page.deleted ? { deleted: true } : {}) },
        cause });
    } else {
      const open = (await readOpenLifetimes(tx, [{ incarnation: source.incarnation, slug }])).get(`${source.incarnation}\u0000${slug}`);
      if (open) {
        await endLifetime(tx, open.page_lifetime);
        drafts.push({ ...base, lifetime: open.page_lifetime, subjectKind: 'page', subjectKey: pageKey(open.page_lifetime), trustTier: 'unknown', tierBasis: 'unknown',
          visibility: 'world', value: { absent: true }, cause: { ...cause, absent: true } });
      }
    }
    return appendBeliefEvents(tx, drafts, { publicationId, origin: 'reconcile', purgesPossible: source.purgesPossible });
  });
  if (appended) await markBeliefCommits(engine, [publicationId]);
  return appended;
}

/** Reconcile every drifted slug the scan finds (deep unless a limit is given). */
export async function reconcileBeliefDrift(engine: BrainEngine, sourceId: string, opts: { limit?: number; op?: string } = {}): Promise<{ scan: DriftScan; reconciled: string[]; events: number }> {
  const scan = await scanBeliefDrift(engine, sourceId, opts.limit ? { limit: opts.limit } : { deep: true });
  const reconciled: string[] = [];
  let events = 0;
  for (const finding of scan.drifted) {
    const n = await reconcileSlug(engine, sourceId, finding.slug, { op: opts.op });
    if (n) { reconciled.push(finding.slug); events += n; }
  }
  return { scan, reconciled, events };
}

/** Open lifetimes with no page at their slug (an untracked hard delete), and (`deep`, a whole-ledger read) events naming a lifetime that does not exist. */
export async function orphanLifetimes(engine: BrainEngine, sourceId: string, limit = 20, opts: { deep?: boolean } = {}): Promise<{ count: number; samples: Array<{ slug: string; page_lifetime: string; reason: 'no_page' | 'no_lifetime' }> }> {
  const rows = await engine.executeRaw<{ slug: string; page_lifetime: string; reason: 'no_page' | 'no_lifetime'; total: number }>(`SELECT slug, page_lifetime, reason, count(*) OVER ()::int AS total FROM (
      SELECT l.slug, l.page_lifetime::text AS page_lifetime, 'no_page' AS reason FROM belief_page_lifetimes l JOIN sources s ON s.id = l.source_id AND s.incarnation = l.source_incarnation
      WHERE l.source_id = $1 AND l.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = l.source_id AND p.slug = l.slug)
      UNION ALL SELECT DISTINCT e.slug, e.page_lifetime::text, 'no_lifetime' FROM belief_events e
      WHERE $2::boolean AND e.source_id = $1 AND e.page_lifetime IS NOT NULL AND NOT EXISTS (SELECT 1 FROM belief_page_lifetimes l WHERE l.page_lifetime = e.page_lifetime)
    ) o ORDER BY slug LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId, opts.deep === true]);
  return { count: Number(rows[0]?.total ?? 0), samples: rows.map(r => ({ slug: r.slug, page_lifetime: r.page_lifetime, reason: r.reason })) };
}

/**
 * Committed publications of the source with no commit mark (a crash before the post-commit mark). The routine scan
 * (cycle, doctor, status) reads events recorded in the last UNMARKED_WINDOW_DAYS through the recorded_at index; `deep`
 * (`gbrain beliefs reconcile`, `doctor --tier deep`) reads the whole source.
 */
export async function unmarkedPublications(engine: BrainEngine, sourceId: string, limit = 1000, opts: { deep?: boolean } = {}): Promise<string[]> {
  const rows = await engine.executeRaw<{ publication_id: string }>(`SELECT DISTINCT e.publication_id::text AS publication_id FROM belief_events e
    WHERE e.source_id = $1 AND ($2::boolean OR e.recorded_at > now() - make_interval(days => ${UNMARKED_WINDOW_DAYS}))
      AND NOT EXISTS (SELECT 1 FROM belief_commit_marks m WHERE m.publication_id = e.publication_id)
    ORDER BY 1 LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId, opts.deep === true]);
  return rows.map(r => r.publication_id);
}

/** Writes the missing commit marks (a reader that finds a committed event with no mark writes one, section 5.3). */
export async function fillCommitMarks(engine: BrainEngine, sourceId: string, opts: { deep?: boolean } = {}): Promise<number> {
  let filled = 0;
  for (;;) {
    const ids = await unmarkedPublications(engine, sourceId, 1000, opts);
    if (!ids.length) return filled;
    await markBeliefCommits(engine, ids);
    filled += ids.length;
    if (ids.length < 1000) return filled;
  }
}

/** Sources with any coverage event in their current incarnation. */
export async function coveredSources(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM belief_events e
    WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $1 AND e.source_incarnation = s.incarnation) ORDER BY 1`, [COVERAGE_KEY]);
  return rows.map(r => r.id);
}

/** The cycle's extract phase: a sampled drift reconcile and commit-mark fill on each covered source (or the cycle's source); failures become details. */
export async function cycleBeliefReconcile(engine: BrainEngine, sourceId?: string): Promise<Record<string, unknown>> {
  const sources = sourceId ? (await coveredSources(engine)).filter(s => s === sourceId) : await coveredSources(engine);
  if (!sources.length) return {};
  const out = { belief_slugs_checked: 0, belief_slugs_reconciled: 0, belief_events_appended: 0, belief_commit_marks_filled: 0 };
  try {
    for (const source of sources) {
      const run = await reconcileBeliefDrift(engine, source, { limit: DRIFT_SAMPLE_PAGES, op: 'cycle_extract' });
      out.belief_slugs_checked += run.scan.checked;
      out.belief_slugs_reconciled += run.reconciled.length;
      out.belief_events_appended += run.events;
      out.belief_commit_marks_filled += await fillCommitMarks(engine, source);
    }
    return out;
  } catch (error) {
    return { ...out, belief_reconcile_error: error instanceof Error ? error.message : String(error) };
  }
}
