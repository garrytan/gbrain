/**
 * The one history reader of the belief ledger (docs/designs/BELIEF_LEDGER.md
 * section 8, privacy). Every read of events goes through `readBeliefHistory`;
 * remote callers never touch the table. A remote caller sees an event only when
 * all hold, and the read fails closed when an owner cannot be resolved:
 *   - the event's own visibility was `world` when recorded, and no later
 *     event of the same claim (any key, so a fact moved to `private`) is
 *     private: making a claim private hides its earlier world history;
 *   - the stream page's current lifetime is visible now (a page made private
 *     later hides its earlier events; an ended lifetime hides them too);
 *   - for links, every page-backed endpoint and the origin are visible now;
 *   - for takes, the take's holder is one the caller may read (`takesHolders`, default `['world']`, the takes
 *     surfaces' rule). A removal carries no value, so its holder is the key's newest earlier value's (one key is one
 *     holder); a take whose values were all purged has no holder and is hidden.
 * For every caller, a key with a `derived.hidden` (a purge hid the row it
 * describes, section 6.5) hides its events below that marker and its backfill
 * events at any id; the marker itself stays visible as the disclosure. Only
 * the source's current incarnation is read: a removed and re-added source
 * inherits no history.
 */
import type { BrainEngine } from '../engine.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

export interface BeliefHistoryRow {
  id: number; slug: string; page_lifetime: string | null; subject_kind: string; subject_key: string; event_type: string; origin: string;
  trust_tier: string; writer_tier: string | null; tier_basis: string; visibility: string; recorded_at: string; source_time: string | null;
  value: Record<string, unknown> | null; value_hash: string | null; prior_hash: string | null; state_hash: string; cause: Record<string, unknown>;
  purged: boolean; redacted_fields: string[] | null;
}

export interface BeliefHistoryQuery {
  sourceId: string; slug?: string; subjectKey?: string; remote: boolean; afterId?: number; limit?: number;
  /** Recorded-time window (after, until]. */
  recordedAfter?: string; recordedUntil?: string;
  /** Only these subject keys, below this event id (the history of keys before a window, read newest first with `descending`). */
  subjectKeys?: readonly string[]; beforeId?: number; descending?: boolean;
  /** Remote callers: the take holders they may read (the takes surfaces' allow-list); `['world']` when absent. */
  takesHolders?: readonly string[];
}

/** Lifetimes a link key names (`L:<uuid>` components), for the endpoint visibility rule. */
function linkLifetimes(subjectKey: string): string[] {
  const parts = JSON.parse(subjectKey) as unknown[];
  const flat = parts[0] === 'lt' ? (parts[1] as unknown[]) : parts;
  return flat.filter((p): p is string => typeof p === 'string' && p.startsWith('L:')).map(p => p.slice(2));
}

export async function readBeliefHistory(engine: BrainEngine, q: BeliefHistoryQuery): Promise<BeliefHistoryRow[]> {
  return (await readBeliefHistoryPage(engine, q)).rows;
}

/**
 * One page of history and how far it read: `scanned` rows matched the query before the remote filter, the last of them
 * `lastScannedId`. A remote page can hold fewer rows than `limit` and still not be the last; page on these, never on
 * `rows.length`.
 */
export async function readBeliefHistoryPage(engine: BrainEngine, q: BeliefHistoryQuery): Promise<{ rows: BeliefHistoryRow[]; scanned: number; lastScannedId: number | null }> {
  const rows = await engine.executeRaw<BeliefHistoryRow & { stream_visible: boolean | null; later_private: boolean; take_holder: string | null }>(`SELECT e.id, e.slug, e.page_lifetime::text AS page_lifetime,
      e.subject_kind, e.subject_key, e.event_type, e.origin, e.trust_tier, e.writer_tier, e.tier_basis, e.visibility, e.recorded_at, e.source_time,
      e.value, e.value_hash, e.prior_hash, e.state_hash, e.cause, e.purged, e.redacted_fields,
      (SELECT ${privatePagesFilterFragment('p')} FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug
        AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
        WHERE l.page_lifetime = e.page_lifetime AND l.ended_at IS NULL) AS stream_visible,
      (e.claim_fp IS NOT NULL AND EXISTS (SELECT 1 FROM belief_events v WHERE v.source_id = e.source_id AND v.source_incarnation = e.source_incarnation
        AND v.claim_fp = e.claim_fp AND v.subject_kind = e.subject_kind AND v.visibility = 'private' AND v.id > e.id)) AS later_private,
      CASE WHEN e.subject_kind = 'take' THEN COALESCE(e.value->>'holder', (SELECT t.value->>'holder' FROM belief_events t WHERE t.source_id = e.source_id
        AND t.source_incarnation = e.source_incarnation AND t.subject_kind = 'take' AND t.subject_key = e.subject_key AND t.id < e.id AND t.value->>'holder' IS NOT NULL
        ORDER BY t.id DESC LIMIT 1)) END AS take_holder
    FROM belief_events e
    WHERE e.source_id = $1 AND e.source_incarnation = (SELECT s.incarnation FROM sources s WHERE s.id = $1) AND ($2::text IS NULL OR e.slug = $2) AND ($3::text IS NULL OR e.subject_key = $3) AND e.id > $4
      AND ($6::timestamptz IS NULL OR e.recorded_at > $6::timestamptz) AND ($7::timestamptz IS NULL OR e.recorded_at <= $7::timestamptz)
      AND ($8::text[] IS NULL OR e.subject_key = ANY($8::text[])) AND ($9::bigint IS NULL OR e.id < $9::bigint)
      AND NOT EXISTS (SELECT 1 FROM belief_events h WHERE h.source_id = e.source_id AND h.subject_kind = e.subject_kind AND h.subject_key = e.subject_key
        AND h.event_type = 'derived.hidden' AND h.id <> e.id AND (h.id > e.id OR e.origin = 'backfill'))
    ORDER BY e.id ${q.descending ? 'DESC' : 'ASC'} LIMIT $5`, [q.sourceId, q.slug ?? null, q.subjectKey ?? null, q.afterId ?? 0, Math.min(Math.max(q.limit ?? 1000, 1), 10_000),
      q.recordedAfter ?? null, q.recordedUntil ?? null, q.subjectKeys ? [...q.subjectKeys] : null, q.beforeId ?? null]);
  const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
  const out = rows.map(r => ({ ...r, id: Number(r.id), value: json(r.value) as BeliefHistoryRow['value'], cause: json(r.cause) as BeliefHistoryRow['cause'] }));
  const page = (kept: typeof out) => ({ rows: kept.map(({ stream_visible: _, later_private: __, take_holder: ___, ...row }) => row), scanned: out.length, lastScannedId: out.at(-1)?.id ?? null });
  if (!q.remote) return page(out);
  const linkIds = [...new Set(out.filter(r => r.subject_kind === 'link' || r.subject_kind === 'link_transition').flatMap(r => linkLifetimes(r.subject_key)))];
  const visibleLifetimes = new Set(linkIds.length ? (await engine.executeRaw<{ page_lifetime: string }>(`SELECT l.page_lifetime::text AS page_lifetime
    FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
    WHERE l.page_lifetime = ANY($1::uuid[]) AND l.ended_at IS NULL AND ${privatePagesFilterFragment('p')}`, [linkIds])).map(r => r.page_lifetime) : []);
  const holders = new Set(q.takesHolders ?? ['world']);
  return page(out.filter(r => r.visibility === 'world' && r.later_private !== true
    && (r.subject_kind !== 'take' || typeof r.take_holder === 'string' && holders.has(r.take_holder))
    && (r.page_lifetime == null ? r.subject_kind === 'fact' : r.stream_visible === true)
    && (r.subject_kind !== 'link' && r.subject_kind !== 'link_transition' || linkLifetimes(r.subject_key).every(id => visibleLifetimes.has(id)))));
}
