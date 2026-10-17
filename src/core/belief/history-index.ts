/**
 * The history text index (W3, docs/architecture/historical-retrieval.md section 4): one row per content interval of a
 * page lifetime, with that interval's recorded-time bounds from the ledger and its chunks (body chunks through the same
 * chunker as content_chunks, plus one row per fence take) stored once by content hash.
 *
 * Maintenance runs inside `appendBeliefEvents`, in the appending transaction: each content event (the predicate
 * page-at-time's replay uses) closes the lifetime's open row and opens a new one at the event's recorded_at, reading
 * the body from the live page row, which already holds it. A purge, expiry or hard delete marks the lifetime's rows
 * stale and removes their titles, aliases, mappings and every chunk no other row references; a fact or take purge
 * rebuilds the lifetime from its redacted versions in the same transaction.
 *
 * The initial build (`gbrain beliefs history-index`) is preview-first and resumable: pass 1 indexes every interval
 * still open, pass 2 the closed ones newest first. The source's index cut stays unset until pass 1 completes.
 */
import type { BrainEngine } from '../engine.ts';
import { chunkText } from '../chunkers/recursive.ts';
import { parseTakesFence, TAKE_RESERVATION_SOURCE } from '../takes-fence.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { computeEffectiveDate } from '../effective-date.ts';
import { opError } from '../ops/contract.ts';
import { keyedFenceTakes, sha256Hex } from './keys.ts';
import { lifetimeContentIntervals, pageContentRevision, type ContentInterval } from './page-at-time.ts';

const GONE_TYPES = new Set(['page.purged', 'page.expired']);
const BUILD_BATCH = 50;
const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();

/** True for an event that opens a content interval: the predicate page-at-time's replay uses. */
export const isHistoryContentEvent = (e: { event_type: string; value: Record<string, unknown> | null }) => pageContentRevision(e) != null;

/** A body's chunks, through the chunker content_chunks uses (takes fences and private fact rows stripped). */
export function historyBodyChunks(compiledTruth: string | null, timeline: string | null): string[] {
  return [...chunkText(compiledTruth ?? ''), ...chunkText(timeline ?? '')].map(c => c.text);
}

export interface FenceTake { take_key: string; holder: string; claim: string; kind: string; weight: number; row_num: number; since_date: string | null }

/** The active fence take rows of a body, keyed like the ledger's take subjects. */
export function fenceTakeRows(lifetime: string, body: string): FenceTake[] {
  const rows = parseTakesFence(body).takes.filter(t => t.source !== TAKE_RESERVATION_SOURCE);
  return keyedFenceTakes(lifetime, rows).filter(k => k.take.active !== false).sort((a, b) => a.index - b.index)
    .map(({ take: t, key }) => ({ take_key: key, holder: t.holder, claim: t.claim, kind: t.kind, weight: Number(t.weight ?? 0), row_num: t.rowNum, since_date: t.sinceDate ?? null }));
}

function contentDate(slug: string, frontmatter: Record<string, unknown>): string | null {
  const epoch = new Date(0);
  const r = computeEffectiveDate({ slug, frontmatter, filename: slug.split('/').pop() ?? null, updatedAt: epoch, createdAt: epoch });
  return r.date && r.source !== 'fallback' && r.source !== 'created' ? r.date.toISOString().slice(0, 10) : null;
}

interface RowInput {
  sourceId: string; incarnation: string; lifetime: string; revision: string; visibility: string; knownFrom: string; knownUntil: string | null;
  openingEvent: number; closingEvent: number | null;
  page: { slug: string; title: string | null; frontmatter: Record<string, unknown>; compiled_truth: string | null; timeline: string | null; segmented: boolean } | null;
}

/** Inserts one interval row and its chunk mappings; chunks already stored are not stored again. Returns false when the interval already had a row. */
async function insertRow(tx: Pick<BrainEngine, 'executeRaw'>, r: RowInput): Promise<boolean> {
  const fm = r.page?.frontmatter ?? {};
  const [row] = await tx.executeRaw<{ id: number }>(`INSERT INTO belief_text_revisions (source_id, source_incarnation, page_lifetime, revision, title, aliases, content_date,
      visibility, segmented, known_from, known_until, opening_event, closing_event)
    VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::text[], $7::date, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13)
    ON CONFLICT (opening_event) DO NOTHING RETURNING id`, [r.sourceId, r.incarnation, r.lifetime, r.revision, r.page?.title ?? null, normalizeAliasList(fm.aliases),
    r.page ? contentDate(r.page.slug, fm) : null, r.visibility, r.page?.segmented === true, r.knownFrom, r.knownUntil, r.openingEvent, r.closingEvent]);
  if (!row) return false;
  if (!r.page || r.page.segmented) return true;
  const body = historyBodyChunks(r.page.compiled_truth, r.page.timeline);
  const takes = fenceTakeRows(r.lifetime, `${r.page.compiled_truth ?? ''}\n${r.page.timeline ?? ''}`);
  const items = [...body.map(text => ({ kind: 'body', holder: null as string | null, take_key: null as string | null, text })),
    ...takes.map(t => ({ kind: 'take', holder: t.holder, take_key: t.take_key, text: t.claim }))].map((x, ord) => ({ ord, kind: x.kind, holder: x.holder, take_key: x.take_key, hash: sha256Hex(x.text), body: x.text }));
  if (!items.length) return true;
  await tx.executeRaw(`WITH input AS (SELECT * FROM jsonb_to_recordset($2::text::jsonb) AS r(ord integer, kind text, holder text, take_key text, hash text, body text)),
    stored AS (INSERT INTO belief_text_chunks (text_hash, search_vector)
      SELECT DISTINCT ON (i.hash) decode(i.hash, 'hex'), to_tsvector('english', gbrain_fts_input(i.body)) FROM input i
      WHERE NOT EXISTS (SELECT 1 FROM belief_text_chunks c WHERE c.text_hash = decode(i.hash, 'hex'))
      ON CONFLICT (text_hash) DO NOTHING)
    INSERT INTO belief_text_revision_chunks (revision_row, ord, kind, holder, take_key, text_hash)
    SELECT $1, i.ord, i.kind, i.holder, i.take_key, decode(i.hash, 'hex') FROM input i`, [Number(row.id), JSON.stringify(items)]);
  return true;
}

/** Deletes the given rows (their mappings cascade) and every chunk no remaining row references. */
async function dropRows(tx: Pick<BrainEngine, 'executeRaw'>, where: string, params: unknown[]): Promise<void> {
  await tx.executeRaw(`WITH r AS (SELECT id FROM belief_text_revisions WHERE ${where}),
      m AS (DELETE FROM belief_text_revision_chunks WHERE revision_row IN (SELECT id FROM r) RETURNING text_hash),
      d AS (DELETE FROM belief_text_revisions WHERE id IN (SELECT id FROM r))
    DELETE FROM belief_text_chunks c WHERE c.text_hash IN (SELECT text_hash FROM m)
      AND NOT EXISTS (SELECT 1 FROM belief_text_revision_chunks x WHERE x.text_hash = c.text_hash AND x.revision_row NOT IN (SELECT id FROM r))`, params);
}

/** A purged, expired or hard-deleted lifetime: its rows stay as skeletons (stale, no title, no aliases) with no mappings, and orphaned chunks go. */
export async function staleHistoryLifetimes(tx: Pick<BrainEngine, 'executeRaw'>, lifetimes: readonly string[]): Promise<void> {
  if (!lifetimes.length) return;
  await tx.executeRaw(`WITH r AS (UPDATE belief_text_revisions SET stale = true, title = NULL, aliases = '{}' WHERE page_lifetime = ANY($1::uuid[]) RETURNING id),
      m AS (DELETE FROM belief_text_revision_chunks WHERE revision_row IN (SELECT id FROM r) RETURNING text_hash)
    DELETE FROM belief_text_chunks c WHERE c.text_hash IN (SELECT text_hash FROM m)
      AND NOT EXISTS (SELECT 1 FROM belief_text_revision_chunks x WHERE x.text_hash = c.text_hash AND x.revision_row NOT IN (SELECT id FROM r))`, [[...lifetimes]]);
}

const rowOf = (sourceId: string, incarnation: string, i: ContentInterval): RowInput => ({ sourceId, incarnation, lifetime: i.lifetime, revision: i.revision!, visibility: i.event.visibility,
  knownFrom: i.event.recorded_at, knownUntil: i.known_until, openingEvent: i.event.id, closingEvent: i.closing_event,
  page: i.page ? { slug: i.slug, title: i.page.title, frontmatter: i.page.frontmatter, compiled_truth: i.page.compiled_truth, timeline: i.page.timeline, segmented: i.body === 'segmented' }
    : i.body === 'segmented' ? { slug: i.slug, title: null, frontmatter: {}, compiled_truth: null, timeline: null, segmented: true } : null });

/** Rebuilds lifetimes from the ledger and their (redacted) versions, in the caller's transaction. */
async function rebuildHistoryLifetimes(tx: BrainEngine, sourceId: string, incarnation: string, lifetimes: readonly string[]): Promise<void> {
  if (!lifetimes.length) return;
  await dropRows(tx, 'page_lifetime = ANY($1::uuid[])', [[...lifetimes]]);
  for (const [, { intervals }] of await lifetimeContentIntervals(tx, sourceId, lifetimes)) {
    for (const i of intervals) await insertRow(tx, rowOf(sourceId, incarnation, i));
  }
}

type Fault = 'skip_maintenance';
let fault: Fault | null = null;
/** Test seam for the row invariant's forced probe: maintenance skipped, so the check must refuse the batch. */
export function __setHistoryIndexFaultForTests(f: Fault | null): void { fault = f; }

/** Test runs refuse a batch whose content event opened no row; `GBRAIN_BELIEF_HISTORY_CHECK=0` turns it off for a probe that breaks it on purpose. */
export const historyInvariantEnforced = (): boolean => process.env.NODE_ENV === 'test' && process.env.GBRAIN_BELIEF_HISTORY_CHECK !== '0';

export interface AppendedEvent {
  id: number; source_id: string; source_incarnation: string; page_lifetime: string | null; slug: string; subject_kind: string; event_type: string;
  value: Record<string, unknown> | null; visibility: string; recorded_at: string; purged: boolean;
}

/** Keeps the index in step with the events one `appendBeliefEvents` call inserted, in its transaction. */
export async function maintainHistoryIndex(tx: BrainEngine, appended: AppendedEvent[], origin: string): Promise<void> {
  if (origin === 'backfill' || !appended.length) return;
  const events = [...appended].map(e => ({ ...e, id: Number(e.id), value: json(e.value) as AppendedEvent['value'], recorded_at: iso(e.recorded_at)! })).sort((a, b) => a.id - b.id);
  for (const e of events.filter(x => x.event_type === 'coverage.started')) {
    await tx.executeRaw(`INSERT INTO belief_text_index_state (source_id, source_incarnation, index_cut, build_pass)
      SELECT $1, $2::uuid, $3::timestamptz, 2 WHERE NOT EXISTS (SELECT 1 FROM belief_events p WHERE p.source_id = $1 AND p.source_incarnation = $2::uuid
        AND p.subject_kind = 'page' AND p.id < $4)
      ON CONFLICT (source_id) DO NOTHING`, [e.source_id, e.source_incarnation, e.recorded_at, e.id]);
  }
  const content = events.filter(e => e.subject_kind === 'page' && e.page_lifetime && isHistoryContentEvent(e));
  if (fault !== 'skip_maintenance') {
    for (const e of content) {
      await tx.executeRaw('UPDATE belief_text_revisions SET known_until = $2::timestamptz, closing_event = $3 WHERE page_lifetime = $1::uuid AND known_until IS NULL',
        [e.page_lifetime, e.recorded_at, e.id]);
      const [page] = await tx.executeRaw<{ slug: string; title: string | null; frontmatter: unknown; compiled_truth: string | null; timeline: string | null; segmented: boolean }>(
        `SELECT p.slug, p.title, p.frontmatter, p.compiled_truth, p.timeline, p.body_storage = 'segmented' AS segmented
         FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id WHERE l.page_lifetime = $1::uuid`, [e.page_lifetime]);
      await insertRow(tx, { sourceId: e.source_id, incarnation: e.source_incarnation, lifetime: e.page_lifetime!, revision: pageContentRevision(e)!, visibility: e.visibility,
        knownFrom: e.recorded_at, knownUntil: null, openingEvent: e.id, closingEvent: null,
        page: page ? { ...page, frontmatter: (json(page.frontmatter) as Record<string, unknown>) ?? {}, segmented: page.segmented === true } : null });
    }
    const gone = new Set(events.filter(e => e.subject_kind === 'page' && e.page_lifetime && (GONE_TYPES.has(e.event_type) || e.value?.hard === true)).map(e => e.page_lifetime!));
    await staleHistoryLifetimes(tx, [...gone]);
    const redacted = events.filter(e => e.subject_kind !== 'page' && e.page_lifetime && !gone.has(e.page_lifetime) && (e.purged || e.event_type.endsWith('.purged')));
    for (const [sourceId, list] of groupBy(redacted, e => `${e.source_id}\u0000${e.source_incarnation}`)) {
      const [id, incarnation] = sourceId.split('\u0000');
      await rebuildHistoryLifetimes(tx, id!, incarnation!, [...new Set(list.map(e => e.page_lifetime!))]);
    }
  }
  if (historyInvariantEnforced() && content.length) {
    const have = new Set((await tx.executeRaw<{ opening_event: number }>('SELECT opening_event FROM belief_text_revisions WHERE opening_event = ANY($1::bigint[])',
      [content.map(e => e.id)])).map(r => Number(r.opening_event)));
    const missing = content.filter(e => !have.has(e.id));
    if (missing.length) {
      throw new Error(`belief history index invariant: ${missing.map(e => `${e.slug} event ${e.id} (${e.event_type})`).join('; ')} opened no history index row (historical-retrieval.md section 4)`);
    }
  }
}

function groupBy<T>(list: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) out.set(key(t), [...out.get(key(t)) ?? [], t]);
  return out;
}

export interface HistoryIndexState { source_id: string; source_incarnation: string | null; index_cut: string | null; build_pass: number }

/** The source's build state: the index cut (null until build pass 1 completes) and the passes done for its current incarnation. */
export async function historyIndexState(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<HistoryIndexState> {
  const [row] = await engine.executeRaw<{ source_incarnation: string; index_cut: string | null; build_pass: number; current: boolean }>(`SELECT st.source_incarnation::text AS source_incarnation,
      st.index_cut, st.build_pass, st.source_incarnation = s.incarnation AS current FROM belief_text_index_state st JOIN sources s ON s.id = st.source_id WHERE st.source_id = $1`, [sourceId]);
  if (!row || row.current !== true) return { source_id: sourceId, source_incarnation: row?.source_incarnation ?? null, index_cut: null, build_pass: 0 };
  return { source_id: sourceId, source_incarnation: row.source_incarnation, index_cut: iso(row.index_cut), build_pass: Number(row.build_pass) };
}

export interface HistoryIndexGap { event_id: number; slug: string; event_type: string; recorded_at: string }

/** Doctor's scan: content events at or after the index cut with no row (none before the build sets a cut). */
export async function historyIndexGaps(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, opts: { limit?: number } = {}): Promise<HistoryIndexGap[]> {
  const state = await historyIndexState(engine, sourceId);
  if (!state.index_cut) return [];
  const rows = await engine.executeRaw<HistoryIndexGap>(`SELECT e.id AS event_id, e.slug, e.event_type, e.recorded_at FROM belief_events e
    JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'page' AND e.page_lifetime IS NOT NULL AND e.origin <> 'backfill' AND e.recorded_at >= $2::timestamptz
      AND jsonb_typeof(e.value->'revision_after') = 'string' AND e.event_type <> ALL($3::text[]) AND COALESCE(e.value->>'hard', '') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM belief_text_revisions r WHERE r.opening_event = e.id)
      AND NOT EXISTS (SELECT 1 FROM belief_text_revisions r WHERE r.page_lifetime = e.page_lifetime AND r.stale)
    ORDER BY e.id DESC LIMIT ${Math.max(1, Math.floor(opts.limit ?? 100))}`, [sourceId, state.index_cut, [...GONE_TYPES]]);
  return rows.map(r => ({ ...r, event_id: Number(r.event_id), recorded_at: iso(r.recorded_at)! }));
}

export interface HistoryIndexBuildReport {
  source_id: string; applied: boolean; intervals: number; open_intervals: number; closed_intervals: number; bytes: number; estimated_seconds: number;
  indexed: number; build_pass: number; complete: boolean; index_cut: string | null;
}

/**
 * `gbrain beliefs history-index`: without `apply`, counts the intervals that have no row (and their bytes) and writes
 * nothing. With `apply`, indexes them resumably: pass 1 every interval still open, one lifetime at a time under its page
 * key; pass 2 the closed intervals, newest first, moving the cut back after each batch. `stopAfterLifetimes` stops pass
 * 1 early (the resumability probe).
 */
export async function buildHistoryIndex(engine: BrainEngine, sourceId: string, opts: { apply?: boolean; stopAfterLifetimes?: number } = {}): Promise<HistoryIndexBuildReport> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [sourceId]);
  if (!source) throw opError('invalid_params', `Source "${sourceId}" not found.`, 'Pass a source id from gbrain sources list.');
  const incarnation = source.incarnation;
  const lifetimes = (await engine.executeRaw<{ l: string }>(`SELECT DISTINCT page_lifetime::text AS l FROM belief_events WHERE source_id = $1 AND source_incarnation = $2::uuid
    AND subject_kind = 'page' AND page_lifetime IS NOT NULL AND origin <> 'backfill' ORDER BY 1`, [sourceId, incarnation])).map(r => r.l);
  const missingOf = async (ls: readonly string[]) => {
    const all: ContentInterval[] = [];
    for (let i = 0; i < ls.length; i += 200) for (const [, v] of await lifetimeContentIntervals(engine, sourceId, ls.slice(i, i + 200))) all.push(...v.intervals);
    const have = new Set<number>();
    for (let i = 0; i < all.length; i += 1000) {
      for (const r of await engine.executeRaw<{ e: number }>('SELECT opening_event AS e FROM belief_text_revisions WHERE opening_event = ANY($1::bigint[])', [all.slice(i, i + 1000).map(x => x.event.id)])) have.add(Number(r.e));
    }
    return all.filter(x => !have.has(x.event.id));
  };
  const missing = await missingOf(lifetimes);
  const open = missing.filter(m => m.known_until == null);
  const report = (extra: Partial<HistoryIndexBuildReport>): HistoryIndexBuildReport => ({ source_id: sourceId, applied: false, intervals: missing.length, open_intervals: open.length,
    closed_intervals: missing.length - open.length, bytes: missing.reduce((n, m) => n + Number(m.page?.body_bytes ?? 0), 0), estimated_seconds: Math.ceil(missing.length / 200),
    indexed: 0, build_pass: 0, complete: false, index_cut: null, ...extra });
  const state = await historyIndexState(engine, sourceId);
  if (!opts.apply) return report({ build_pass: state.build_pass, complete: state.build_pass === 2 && !missing.length, index_cut: state.index_cut });
  const setState = (cut: string | null, pass: number) => engine.executeRaw(`INSERT INTO belief_text_index_state (source_id, source_incarnation, index_cut, build_pass, updated_at)
    VALUES ($1, $2::uuid, $3::timestamptz, $4, now()) ON CONFLICT (source_id) DO UPDATE SET source_incarnation = EXCLUDED.source_incarnation, index_cut = EXCLUDED.index_cut,
      build_pass = EXCLUDED.build_pass, updated_at = now()`, [sourceId, incarnation, cut, pass]);
  let indexed = 0;
  if (state.build_pass < 1) {
    await setState(null, 0);
    const openLifetimes = [...new Set(open.map(m => m.lifetime))];
    for (const [n, lifetime] of openLifetimes.entries()) {
      if (opts.stopAfterLifetimes !== undefined && n >= opts.stopAfterLifetimes) return report({ applied: true, indexed, build_pass: 1, complete: false });
      indexed += await engine.transaction(async tx => {
        const slug = open.find(m => m.lifetime === lifetime)!.slug;
        await tx.lockPageKeys([{ sourceId, slug }]);
        let added = 0;
        for (const [, v] of await lifetimeContentIntervals(tx, sourceId, [lifetime])) {
          const head = v.intervals.at(-1);
          if (head && head.known_until == null && await insertRow(tx, rowOf(sourceId, incarnation, head))) added++;
        }
        return added;
      });
    }
  }
  const closed = (await missingOf(lifetimes)).filter(m => m.known_until != null).sort((a, b) => Date.parse(b.known_until!) - Date.parse(a.known_until!) || b.event.id - a.event.id);
  const [{ first }] = await engine.executeRaw<{ first: string | null }>('SELECT min(recorded_at) AS first FROM belief_events WHERE source_id = $1 AND source_incarnation = $2::uuid', [sourceId, incarnation]);
  const cutAfter = (rest: ContentInterval[]) => rest.length ? rest[0]!.known_until! : iso(first) ?? new Date().toISOString();
  await setState(cutAfter(closed), closed.length ? 1 : 2);
  for (let i = 0; i < closed.length; i += BUILD_BATCH) {
    const batch = closed.slice(i, i + BUILD_BATCH);
    indexed += await engine.transaction(async tx => {
      let added = 0;
      for (const m of batch) if (await insertRow(tx, rowOf(sourceId, incarnation, m))) added++;
      return added;
    });
    const rest = closed.slice(i + BUILD_BATCH);
    await setState(cutAfter(rest), rest.length ? 1 : 2);
  }
  const final = await historyIndexState(engine, sourceId);
  return report({ applied: true, indexed, build_pass: final.build_pass, complete: final.build_pass === 2, index_cut: final.index_cut });
}
