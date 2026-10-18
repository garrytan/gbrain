/**
 * Page-at-time (W2 first slice, docs/designs/BELIEF_LEDGER.md section 10):
 * what a page was, as the brain had recorded it at a recorded-time instant
 * `known_as_of`. Each version's validity interval comes from the page
 * lifetime's publication events, never from the newest `page_versions` row
 * at or before T (versions are preimages, so that picks the wrong side of an
 * edit). An event counts at T under the section 5.3 visibility rule: its
 * commit mark is at or before T, or a later event of the same lifetime was
 * recorded at or before T; recorded after T, it does not count; otherwise the
 * read refuses `known_as_of_unproven` instead of guessing. The body of
 * interval i is the preimage version written by the transition that closed
 * it (versions of one revision pair with that revision's closed intervals in
 * order), or the live page for the open head. A body no version holds any
 * more is disclosed, never borrowed from a neighbour.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';
import { coverageAt } from './coverage-report.ts';

const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DATE_ONLY = /^\d{4}-\d{2}(?:-\d{2})?$/;

/** Parses `known_as_of`: an ISO 8601 instant with a zone. A bare date is the valid-time clock (`as_of`), refused `clock_mismatch`. */
export function parseKnownAsOf(value: unknown): Date {
  const text = typeof value === 'string' ? value.trim() : '';
  if (DATE_ONLY.test(text)) {
    throw opError('clock_mismatch', `known_as_of needs an instant with a time and zone (for example 2026-10-01T12:00:00Z), not the date ${text}.`,
      'known_as_of is recorded time: when the brain had recorded something. A calendar date is valid time, which as_of takes on get_links. Pass a full instant.',
      { reason: 'date_for_instant' });
  }
  const at = INSTANT.test(text) ? new Date(text.replace(' ', 'T')) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw opError('invalid_params', 'known_as_of must be an ISO 8601 instant with a zone, for example 2026-10-01T12:00:00Z.', 'Pass an instant such as 2026-10-01T12:00:00Z.');
  }
  return at;
}

interface PageEventRow {
  id: number; lifetime: string; slug: string; event_type: string; origin: string; visibility: string;
  recorded_at: string; observed_at: string | null; source_time: string | null; value: Record<string, unknown> | null; purged: boolean; proven: boolean;
}

export type BodyStatus = 'live' | 'version' | 'segmented' | 'unavailable';
export type BodyReason = 'purged' | 'expired' | 'hard_deleted' | 'pruned' | 'version_missing';
export interface PageInterval {
  lifetime: string;
  slug: string;
  revision: string | null;
  deleted: boolean;
  /** The transition that opened the interval: `recorded_at` bounds when it was written, `visible_at` is its commit mark. */
  event: { id: number; type: string; origin: string; recorded_at: string; visible_at: string | null; source_time: string | null; visibility: string };
  /** When the next transition known at T was recorded; null for the interval current at T. */
  until: string | null;
  body: BodyStatus;
  /** Why no body is returned. */
  body_reason?: BodyReason;
  version_id?: number;
  page?: { title: string | null; type: string | null; frontmatter: Record<string, unknown>; tags: string[]; compiled_truth: string | null; timeline: string | null; body_bytes: number | null };
}

export interface PageAtTime {
  slug: string;
  source_id: string;
  known_as_of: string;
  certified: boolean;
  uncertified_reason: string | null;
  coverage_cut: string;
  /** Intervals of the page at `slug` known at T, oldest first; the interval current at T has `until: null`. */
  intervals: PageInterval[];
  /** The interval current at T, when a page stood at the slug then. */
  current: PageInterval | null;
  /** The page row of the lifetime current at T, when it still exists. */
  page_id: number | null;
}

const GONE: Record<string, BodyReason> = { 'page.purged': 'purged', 'page.expired': 'expired' };
const SKIPPED = ['backfill', 'trust.retiered', 'trust.contested', 'trust.held', 'derived.hidden'];
const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();

/** The page events of every lifetime that ever stood at `slug` in the source's current incarnation (backfill rows excluded), each with whether a later event of its lifetime was recorded by T. */
async function readPageEvents(engine: BrainEngine, sourceId: string, slug: string, at: Date): Promise<PageEventRow[]> {
  const rows = await engine.executeRaw<PageEventRow>(`WITH inc AS (SELECT incarnation FROM sources WHERE id = $1),
    lt AS (SELECT DISTINCT e.page_lifetime FROM belief_events e, inc WHERE e.source_id = $1 AND e.source_incarnation = inc.incarnation AND e.slug = $2
      AND e.subject_kind = 'page' AND e.page_lifetime IS NOT NULL AND e.origin <> 'backfill')
    SELECT e.id, e.page_lifetime::text AS lifetime, e.slug, e.event_type, e.origin, e.visibility, e.recorded_at, m.observed_at, e.source_time, e.value, e.purged,
      EXISTS (SELECT 1 FROM belief_events l WHERE l.source_id = e.source_id AND l.page_lifetime = e.page_lifetime AND l.id > e.id AND l.origin <> 'backfill'
        AND l.recorded_at <= $3::timestamptz) AS proven
    FROM belief_events e LEFT JOIN belief_commit_marks m ON m.publication_id = e.publication_id
    WHERE e.source_id = $1 AND e.page_lifetime IN (SELECT page_lifetime FROM lt) AND e.subject_kind = 'page' AND e.origin <> 'backfill'
      AND NOT (e.event_type = ANY($4::text[]))
    ORDER BY e.id`, [sourceId, slug, at.toISOString(), SKIPPED]);
  return rows.map(r => ({ ...r, id: Number(r.id), recorded_at: iso(r.recorded_at)!, observed_at: iso(r.observed_at), source_time: iso(r.source_time),
    value: json(r.value) as PageEventRow['value'], purged: r.purged === true, proven: r.proven === true }));
}

function visibilityAt(e: PageEventRow, t: number): 'visible' | 'not_visible' | 'unproven' {
  if (e.observed_at && Date.parse(e.observed_at) <= t) return 'visible';
  if (Date.parse(e.recorded_at) > t) return 'not_visible';
  return e.proven ? 'visible' : 'unproven';
}

interface Draft { lifetime: string; slug: string; revision: string | null; deleted: boolean; gone: BodyReason | null; content: boolean; event: PageInterval['event'] }

/** Replays one lifetime's events into intervals: one per content state (a revision, or a view change at one revision), rename or removal. A purge-redacted event (value NULL) carries no revision, so a purged lifetime's content changes collapse: its intervals split only where its slug or deleted state changed, which the event type and row still say. */
function replay(events: PageEventRow[]): Draft[] {
  const out: Draft[] = [];
  let state: { slug: string; deleted: boolean; revision: string | null } | null = null;
  for (const e of events) {
    const v = e.value ?? {};
    const gone = GONE[e.event_type] ?? (v.hard === true ? 'hard_deleted' : null);
    const content = gone == null && typeof v.revision_after === 'string';
    const next: { slug: string; deleted: boolean; revision: string | null } = { slug: e.slug, revision: content ? v.revision_after as string : state?.revision ?? null,
      deleted: gone != null || e.event_type === 'page.deleted' || (v.deleted === true && e.event_type !== 'page.restored') };
    if (state && !content && gone == null && next.slug === state.slug && next.deleted === state.deleted) continue;
    state = next;
    out.push({ lifetime: e.lifetime, slug: next.slug, revision: next.revision, deleted: next.deleted, gone, content,
      event: { id: e.id, type: e.event_type, origin: e.origin, recorded_at: e.recorded_at, visible_at: e.observed_at, source_time: e.source_time, visibility: e.visibility } });
  }
  return out;
}

/**
 * Reads the page at `slug` as recorded at `at`. Refuses `coverage_from`
 * before the ledger covers the time (naming the page's best-effort backfill
 * when one exists), `coverage_gap` inside a stopped interval or restore gap,
 * and `known_as_of_unproven` when a transition of the page straddles T.
 * `history` returns every interval known at T (get_versions); otherwise only
 * the one current at T.
 */
export async function readPageAtTime(engine: BrainEngine, q: { sourceId: string; slug: string; at: Date; history?: boolean; withBodies?: boolean }): Promise<PageAtTime> {
  const t = q.at.getTime();
  const [{ now }] = await engine.executeRaw<{ now: string }>('SELECT clock_timestamp() AS now');
  if (t > Date.parse(iso(now)!)) {
    throw opError('invalid_params', `known_as_of ${q.at.toISOString()} is in the future.`, 'Pass an instant at or before now; omit known_as_of for the current page.');
  }
  const events = await readPageEvents(engine, q.sourceId, q.slug, q.at);
  const pageCov = await coverageAt(engine, q.sourceId, q.at, q.slug);
  let cov = pageCov;
  if (!pageCov.ok) {
    if (pageCov.code === 'coverage_gap') throw coverageRefusal(pageCov, q);
    const sourceCov = await coverageAt(engine, q.sourceId, q.at);
    if (!sourceCov.ok) throw coverageRefusal(sourceCov, q, await backfillSummary(engine, q.sourceId, q.slug));
    const first = events.find(e => e.slug === q.slug);
    if (first?.event_type === 'baseline' && Date.parse(first.recorded_at) > t) {
      throw coverageRefusal({ ...pageCov, from: first.recorded_at }, q, await backfillSummary(engine, q.sourceId, q.slug));
    }
    cov = sourceCov;
  }
  if (!cov.ok) throw coverageRefusal(cov, q);

  const lifetimes: Array<{ lifetime: string; all: Draft[]; known: Draft[] }> = [];
  for (const lifetime of [...new Set(events.map(e => e.lifetime))]) {
    const list = events.filter(e => e.lifetime === lifetime);
    const vis = list.map(e => visibilityAt(e, t));
    const last = vis.lastIndexOf('visible');
    const straddling = list.find((_, i) => i > last && vis[i] === 'unproven');
    if (straddling) {
      throw opError('known_as_of_unproven', `A change to ${q.slug} recorded at ${straddling.recorded_at} was not yet proven committed at ${q.at.toISOString()}.`,
        `The write was in flight at that instant, so the page then cannot be stated either way. Ask about an instant before ${straddling.recorded_at}, or after the write was observed committed.`,
        { retryable: true });
    }
    lifetimes.push({ lifetime, all: replay(list), known: replay(list.slice(0, last + 1)) });
  }
  const current = lifetimes.map(l => ({ l, head: l.known[l.known.length - 1] }))
    .filter((x): x is { l: typeof x.l; head: Draft } => !!x.head && x.head.slug === q.slug && x.head.gone == null)
    .sort((a, b) => Number(a.head.deleted) - Number(b.head.deleted) || b.head.event.id - a.head.event.id)[0];
  const keep = q.history ? lifetimes.flatMap(l => l.known.filter(d => d.slug === q.slug)) : current ? [current.head] : [];
  const intervals = (await withBodies(engine, lifetimes, keep, q.withBodies !== false))
    .sort((a, b) => Date.parse(a.event.recorded_at) - Date.parse(b.event.recorded_at) || a.event.id - b.event.id);
  const head = current ? intervals.find(i => i.event.id === current.head.event.id) ?? null : null;
  const [lt] = current ? await engine.executeRaw<{ page_id: number | null }>('SELECT page_id FROM belief_page_lifetimes WHERE page_lifetime = $1::uuid', [current.l.lifetime]) : [];
  return { slug: q.slug, source_id: q.sourceId, known_as_of: q.at.toISOString(), certified: cov.certified, uncertified_reason: cov.uncertified_reason, coverage_cut: cov.cut,
    intervals, current: head, page_id: lt?.page_id == null ? null : Number(lt.page_id) };
}

/**
 * Bodies for `keep`. A content interval's body is the preimage version the next content transition wrote: the closed
 * intervals of one revision pair with that revision's versions in id order, newest with newest. The lifetime's open
 * content interval reads the live page while the page still stands at that revision.
 */
async function withBodies(engine: BrainEngine, lifetimes: Array<{ lifetime: string; all: Draft[]; known: Draft[] }>, keep: Draft[], bodies: boolean): Promise<PageInterval[]> {
  const ids = [...new Set(keep.map(d => d.lifetime))];
  if (!ids.length) return [];
  const rows = await engine.executeRaw<{ page_lifetime: string; page_id: number | null; ended_at: string | null; revision: string | null; body_storage: string | null; body_bytes: number | null }>(
    `SELECT l.page_lifetime::text AS page_lifetime, l.page_id, l.ended_at, p.knowledge_revision::text AS revision, p.body_storage,
       COALESCE(p.body_bytes, octet_length(COALESCE(p.compiled_truth, '')) + octet_length(COALESCE(p.timeline, ''))) AS body_bytes
     FROM belief_page_lifetimes l LEFT JOIN pages p ON p.id = l.page_id WHERE l.page_lifetime = ANY($1::uuid[])`, [ids]);
  const out: PageInterval[] = [];
  for (const lifetime of ids) {
    const l = lifetimes.find(x => x.lifetime === lifetime)!;
    const row = rows.find(r => r.page_lifetime === lifetime);
    const pageId = row?.page_id == null || row.revision == null ? null : Number(row.page_id);
    const content = l.all.filter(d => d.content);
    const openHead = row && row.ended_at == null && pageId != null ? content[content.length - 1] ?? null : null;
    const liveHead = openHead && openHead.revision === row!.revision ? openHead : null;
    const revisions = [...new Set(content.map(d => d.revision).filter((r): r is string => !!r))];
    const versions = pageId != null && bodies && revisions.length ? await engine.executeRaw<Record<string, unknown>>(`SELECT id, knowledge_revision::text AS revision,
        compiled_truth, timeline, title, type, frontmatter, tags, body_storage,
        COALESCE(body_bytes, octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, ''))) AS body_bytes
      FROM page_versions WHERE page_id = $1 AND knowledge_revision = ANY($2::uuid[]) ORDER BY id`, [pageId, revisions]) : [];
    const pairing = new Map<number, Record<string, unknown>>();
    for (const revision of revisions) {
      const closed = content.filter(d => d.revision === revision && d !== liveHead);
      const held = versions.filter(v => v.revision === revision);
      for (let i = 1; i <= Math.min(closed.length, held.length); i++) pairing.set(closed[closed.length - i]!.event.id, held[held.length - i]!);
    }
    const gone = l.all.find(d => d.gone)?.gone ?? (pageId == null ? 'hard_deleted' : null);
    const large = row?.body_storage === 'segmented' || Number(row?.body_bytes ?? 0) > PAGE_INLINE_MAX_BYTES;
    for (const d of keep.filter(x => x.lifetime === lifetime)) {
      const owner = [...content].reverse().find(c => c.event.id <= d.event.id) ?? null;
      const next: Draft | undefined = l.known[l.known.findIndex(k => k.event.id === d.event.id) + 1];
      const base: PageInterval = { lifetime, slug: d.slug, revision: d.revision, deleted: d.deleted, event: d.event, until: next ? next.event.recorded_at : null, body: 'unavailable' };
      if (d.gone) { out.push({ ...base, body_reason: d.gone }); continue; }
      if (owner && owner === liveHead) {
        if (!bodies) { out.push({ ...base, body: 'live' }); continue; }
        const page = await livePage(engine, pageId!);
        out.push({ ...base, body: page.segmented ? 'segmented' : 'live', page: page.view });
        continue;
      }
      const version = owner ? pairing.get(owner.event.id) : undefined;
      if (!bodies) { out.push({ ...base, ...(owner && revisions.length && pageId != null ? {} : { body_reason: gone ?? 'version_missing' }) }); continue; }
      if (!version) { out.push({ ...base, body_reason: gone ?? (large ? 'pruned' : 'version_missing') }); continue; }
      const segmented = version.body_storage === 'segmented';
      out.push({ ...base, body: segmented ? 'segmented' : 'version', version_id: Number(version.id), page: {
        title: (version.title as string | null) ?? null, type: (version.type as string | null) ?? null, frontmatter: (json(version.frontmatter) as Record<string, unknown>) ?? {},
        tags: (json(version.tags) as string[] | null) ?? [], compiled_truth: segmented ? null : (version.compiled_truth as string | null) ?? null,
        timeline: segmented ? null : (version.timeline as string | null) ?? null, body_bytes: version.body_bytes == null ? null : Number(version.body_bytes) } });
    }
  }
  return out;
}

async function livePage(engine: BrainEngine, pageId: number) {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT p.title, p.type, p.frontmatter, p.body_storage, p.compiled_truth, p.timeline,
      COALESCE(p.body_bytes, octet_length(COALESCE(p.compiled_truth, '')) + octet_length(COALESCE(p.timeline, ''))) AS body_bytes,
      COALESCE((SELECT json_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id = p.id), '[]'::json) AS tags
    FROM pages p WHERE p.id = $1`, [pageId]);
  const segmented = row!.body_storage === 'segmented';
  return { segmented, view: { title: (row!.title as string | null) ?? null, type: (row!.type as string | null) ?? null,
    frontmatter: (json(row!.frontmatter) as Record<string, unknown>) ?? {}, tags: (json(row!.tags) as string[]) ?? [],
    compiled_truth: segmented ? null : (row!.compiled_truth as string | null) ?? null, timeline: segmented ? null : (row!.timeline as string | null) ?? null,
    body_bytes: row!.body_bytes == null ? null : Number(row!.body_bytes) } };
}

/** The page's best-effort history summary (the backfill's `backfill` event), named in a `coverage_from` refusal. */
async function backfillSummary(engine: BrainEngine, sourceId: string, slug: string): Promise<{ complete: boolean; versions: number; reasons: string[] } | null> {
  const [row] = await engine.executeRaw<{ value: unknown }>(`SELECT e.value FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.slug = $2 AND e.event_type = 'backfill' ORDER BY e.id DESC LIMIT 1`, [sourceId, slug]);
  const v = row ? json(row.value) as Record<string, unknown> : null;
  return v ? { complete: v.backfill_complete === true, versions: Number(v.versions ?? 0), reasons: (v.reasons as string[] | undefined) ?? [] } : null;
}

function coverageRefusal(c: { code: 'coverage_from' | 'coverage_gap'; from: string | null; message: string; until?: string | null; reason?: string },
  q: { sourceId: string; slug: string; at: Date }, backfill?: { complete: boolean; versions: number; reasons: string[] } | null) {
  const fix = readFix('Lists the coverage intervals, watermark and restore gaps the read is checked against.', { argv: ['gbrain', 'beliefs', 'status', '--source', q.sourceId, '--json'] });
  if (c.code === 'coverage_gap') {
    return opError('coverage_gap', c.message, `Ask about an instant before ${c.from ?? 'the gap'} or after ${c.until ?? 'it'}.`, { reason: c.reason, fix });
  }
  const hint = backfill
    ? `Recorded history of ${q.slug} starts ${c.from ?? 'later'}. A best-effort history from retained versions exists (${backfill.complete ? 'complete' : `incomplete: ${backfill.reasons.join(', ') || 'unknown'}`}); it holds source times only, never recorded times, so it cannot answer known_as_of.`
    : `Recorded history starts ${c.from ?? 'once the ledger is enabled on this source'}; ask about an instant at or after it.`;
  return opError('coverage_from', c.message, hint, { reason: backfill ? (backfill.complete ? 'backfill_only' : 'backfill_incomplete') : 'not_recorded', fix });
}

/** A remote caller reads an interval only when its event was world-visible when recorded and its page is visible now; it fails closed when the page row is gone. */
export async function remoteMayRead(engine: BrainEngine, pageId: number | null, interval: PageInterval): Promise<boolean> {
  if (pageId == null || interval.event.visibility !== 'world') return false;
  const [row] = await engine.executeRaw<{ visible: boolean }>(`SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.id = $1 AND p.deleted_at IS NULL`, [pageId]);
  return row?.visible === true;
}
