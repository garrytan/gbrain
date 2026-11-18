/**
 * The one history reader of the belief ledger (docs/designs/BELIEF_LEDGER.md
 * section 8, privacy). Every read of events goes through `readBeliefHistory`;
 * remote callers never touch the table. A remote caller sees an event only when
 * all hold, and the read fails closed when an owner cannot be resolved:
 *   - the event's own visibility was `world` when recorded, and no later
 *     event of the same claim (any key, so a fact moved to `private`) is
 *     private: making a claim private hides its earlier world history;
 *   - the stream page's current lifetime is visible now (a page made private
 *     later hides its earlier events; an ended lifetime hides them too), and
 *     for facts and takes it is not quarantined (#6259: a quarantined page's
 *     claims are scraped text, kept from remote readers as its body is);
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
  const rows = await engine.readBeliefHistoryRows({
    sourceId: q.sourceId, slug: q.slug ?? null, subjectKey: q.subjectKey ?? null, afterId: q.afterId ?? 0, limit: Math.min(Math.max(q.limit ?? 1000, 1), 10_000),
    recordedAfter: q.recordedAfter ?? null, recordedUntil: q.recordedUntil ?? null, subjectKeys: q.subjectKeys ?? null, beforeId: q.beforeId ?? null,
    descending: q.descending === true,
  }) as unknown as Array<BeliefHistoryRow & { stream_visible: boolean | null; later_private: boolean; take_holder: string | null }>;
  const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
  const out = rows.map(r => ({ ...r, id: Number(r.id), value: json(r.value) as BeliefHistoryRow['value'], cause: json(r.cause) as BeliefHistoryRow['cause'] }));
  const page = (kept: typeof out) => ({ rows: kept.map(({ stream_visible: _, later_private: __, take_holder: ___, ...row }) => row), scanned: out.length, lastScannedId: out.at(-1)?.id ?? null });
  if (!q.remote) return page(out);
  const linkIds = [...new Set(out.filter(r => r.subject_kind === 'link' || r.subject_kind === 'link_transition').flatMap(r => linkLifetimes(r.subject_key)))];
  const visibleLifetimes = new Set(linkIds.length ? await engine.listVisibleBeliefLifetimes(linkIds) : []);
  const holders = new Set(q.takesHolders ?? ['world']);
  return page(out.filter(r => r.visibility === 'world' && r.later_private !== true
    && (r.subject_kind !== 'take' || typeof r.take_holder === 'string' && holders.has(r.take_holder))
    && (r.page_lifetime == null ? r.subject_kind === 'fact' : r.stream_visible === true)
    && (r.subject_kind !== 'link' && r.subject_kind !== 'link_transition' || linkLifetimes(r.subject_key).every(id => visibleLifetimes.has(id)))));
}
