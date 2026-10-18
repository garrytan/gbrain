/**
 * Tier changes outside a publication diff (docs/designs/BELIEF_LEDGER.md
 * sections 6.3 and 6.4). A publication or owner action whose tier change lies
 * in its own streams is recorded by its batch's diff. Two writers change tiers
 * of rows in streams they do not publish:
 *
 * - bulk runs (`trust backfill`, `claim-sources --relower`) append one summary
 *   `trust.retiered` per source and stream page, plus one
 *   `belief_retier_manifest` row (subject key, from, to) per changed subject,
 *   keyed by the summary event, so replay can say which belief's trust changed;
 * - derived propagation appends one `trust.retiered` per lowered dependent
 *   outside the enclosing batch's streams, whose cause names each input and
 *   the event that recorded its change; a dependent inside them is recorded
 *   by the batch's diff, at its final state hash, with that cause.
 *
 * Neither holds its dependents' page keys (a lock taken late can deadlock), so
 * these events order within a stream by the row locks the tier UPDATE took.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { appendBeliefEvents, type BeliefEventDraft } from './append.ts';
import { eventKeyHex, pageKey, slugRef } from './keys.ts';
import { coverageActive, currentBeliefBatch, noteBelief, readLedgerSource, stateHashOf } from './ledger.ts';
import { resolveLifetimes } from './lifetimes.ts';
import { readBeliefState, type RawPage } from './state.ts';
import { keyedSubjects, pageNeeds } from './subjects.ts';

export interface RetierRow { table: string; id: number; from: string | null; to: string }

interface Resolved {
  row: RetierRow; sourceId: string; incarnation: string; stream: string; page: RawPage | null; lifetime: string | null;
  kind: 'page' | 'fact' | 'take'; key: string; visibility: string; claimFp: string | null; stateHash: string; writerTier: string | null;
}

const KIND: Record<string, 'page' | 'fact' | 'take'> = { pages: 'page', facts: 'fact', takes: 'take' };

/** Each ledger subject among `rows` (timeline rows are not subjects), keyed as its stream's current state keys it; covered sources only. */
async function resolveSubjects(tx: BrainEngine, rows: readonly RetierRow[]): Promise<Resolved[]> {
  const subjects = rows.filter(r => KIND[r.table]);
  if (!subjects.length) return [];
  const ids = (table: string) => subjects.filter(r => r.table === table).map(r => r.id);
  const located = await tx.executeRaw<{ t: string; id: number; source_id: string; slug: string | null }>(`
    SELECT 'facts' AS t, id, source_id, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])
    UNION ALL SELECT 'takes', t.id, p.source_id, p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($2::bigint[])
    UNION ALL SELECT 'pages', id, source_id, slug FROM pages WHERE id = ANY($3::bigint[])`, [ids('facts'), ids('takes'), ids('pages')]);
  const where = new Map(located.filter(r => r.slug).map(r => [`${r.t}:${Number(r.id)}`, { sourceId: r.source_id, slug: r.slug! }]));
  const out: Resolved[] = [];
  for (const sourceId of new Set([...where.values()].map(w => w.sourceId))) {
    const source = await readLedgerSource(tx, sourceId);
    if (!source || !coverageActive(source.coverage)) continue;
    const mine = subjects.filter(r => where.get(`${r.table}:${r.id}`)?.sourceId === sourceId);
    const streams = [...new Set(mine.map(r => where.get(`${r.table}:${r.id}`)!.slug))];
    const state = await readBeliefState(tx, sourceId, streams);
    const lifetimes = await resolveLifetimes(tx, pageNeeds(sourceId, source.incarnation, state));
    const pagesBySlug = new Map(state.pages.map(p => [p.slug, p]));
    const keyed = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug }, state,
      id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world');
    const hash = (slug: string) => { const page = pagesBySlug.get(slug) ?? null; return stateHashOf(page, page ? lifetimes.get(page.id)! : null, keyed.filter(s => s.stream === slug)); };
    for (const row of mine) {
      const stream = where.get(`${row.table}:${row.id}`)!.slug;
      const page = pagesBySlug.get(stream) ?? null;
      const lifetime = page ? lifetimes.get(page.id) ?? null : null;
      const base = { row, sourceId, incarnation: source.incarnation, stream, page, lifetime, stateHash: hash(stream), writerTier: state.writerTier };
      if (row.table === 'pages') {
        if (page && lifetime) out.push({ ...base, kind: 'page', key: pageKey(lifetime), visibility: page.visible ? 'world' : 'private', claimFp: null });
        continue;
      }
      const subject = keyed.find(s => s.kind === KIND[row.table] && s.rowIds.includes(row.id));
      if (subject) out.push({ ...base, kind: subject.kind as 'fact' | 'take', key: subject.key, visibility: subject.visibility, claimFp: subject.claimFp });
    }
  }
  return out;
}

const draftOf = (r: Resolved, cause: Record<string, unknown>): BeliefEventDraft => ({ sourceId: r.sourceId, incarnation: r.incarnation, lifetime: r.lifetime, slug: r.stream,
  stream: r.stream, subjectKind: r.kind, subjectKey: r.key, eventType: 'trust.retiered', trustTier: r.row.to, writerTier: r.writerTier, tierBasis: 'row',
  visibility: r.visibility, value: { from: r.row.from, to: r.row.to }, stateHash: r.stateHash, claimFp: r.claimFp, cause });

/**
 * Per-subject `trust.retiered` events for rows whose tier changed (derived
 * propagation). Appended under the enclosing batch's publication when there is
 * one, else under `publicationId`. Returns the publication id when it appended.
 */
export async function appendRetierEvents(tx: BrainEngine, rows: readonly RetierRow[], cause: Record<string, unknown>, publicationId?: string): Promise<string | null> {
  const batch = currentBeliefBatch();
  const all = await resolveSubjects(tx, rows);
  // A dependent in the enclosing batch's own streams is recorded by its finalization (after every write, with the final state hash); the batch carries the cause.
  const inBatch = (r: Resolved) => !!batch && batch.sourceId === r.sourceId && batch.slugs.includes(r.stream);
  for (const r of all.filter(inBatch)) noteBelief({ kind: 'retier_cause', table: r.row.table as 'facts' | 'takes' | 'pages', rowId: r.row.id, cause });
  const resolved = all.filter(r => !inBatch(r));
  if (!resolved.length) return null;
  const pub = batch?.publicationId ?? publicationId ?? randomUUID();
  let appended = 0;
  for (const sourceId of new Set(resolved.map(r => r.sourceId))) {
    const source = (await readLedgerSource(tx, sourceId))!;
    appended += await appendBeliefEvents(tx, resolved.filter(r => r.sourceId === sourceId).map(r => draftOf(r, cause)),
      { publicationId: pub, origin: await readManagedMode(tx) ? 'live' : 'unmanaged', purgesPossible: source.purgesPossible });
  }
  return appended ? pub : null;
}

/**
 * A bulk run's tier changes in one transaction: one summary `trust.retiered`
 * per source and stream (the stream page's key, or the slug form for a stream
 * with no page) and one manifest row per changed subject. Returns the
 * publication id when it appended.
 */
export async function appendBulkRetier(tx: BrainEngine, rows: readonly RetierRow[], op: string, publicationId = randomUUID()): Promise<string | null> {
  const resolved = await resolveSubjects(tx, rows.filter(r => r.from !== r.to));
  if (!resolved.length) return null;
  let appended = 0;
  for (const sourceId of new Set(resolved.map(r => r.sourceId))) {
    const source = (await readLedgerSource(tx, sourceId))!;
    const mine = resolved.filter(r => r.sourceId === sourceId);
    const summaries = [...new Set(mine.map(r => r.stream))].map(stream => {
      const members = mine.filter(r => r.stream === stream);
      const first = members[0]!;
      const to: Record<string, number> = {};
      for (const m of members) to[m.row.to] = (to[m.row.to] ?? 0) + 1;
      const draft: BeliefEventDraft = { sourceId, incarnation: first.incarnation, lifetime: first.lifetime, slug: stream, stream, subjectKind: 'page',
        subjectKey: first.lifetime ? pageKey(first.lifetime) : JSON.stringify(['p', slugRef(first.incarnation, stream)]), eventType: 'trust.retiered',
        trustTier: first.page?.tier ?? 'unknown', writerTier: first.writerTier, tierBasis: first.page ? 'row' : 'unknown',
        visibility: first.page && !first.page.visible ? 'private' : 'world', value: { summary: true, subjects: members.length, to }, stateHash: first.stateHash,
        cause: { op, manifest: true } };
      return { draft, members };
    });
    appended += await appendBeliefEvents(tx, summaries.map(s => s.draft), { publicationId, origin: await readManagedMode(tx) ? 'live' : 'unmanaged', purgesPossible: source.purgesPossible });
    const manifest = summaries.flatMap(({ draft, members }) => members.map(m => ({ event_key: eventKeyHex(publicationId, draft.subjectKey, draft.eventType),
      subject_kind: m.kind, subject_key: m.key, from_tier: m.row.from, to_tier: m.row.to })));
    await tx.executeRaw(`INSERT INTO belief_retier_manifest (summary_event, source_id, subject_kind, subject_key, from_tier, to_tier)
      SELECT e.id, $1, m.subject_kind, m.subject_key, m.from_tier, m.to_tier
      FROM jsonb_to_recordset($2::text::jsonb) AS m(event_key text, subject_kind text, subject_key text, from_tier text, to_tier text)
      JOIN belief_events e ON e.event_key = decode(m.event_key, 'hex')
      ON CONFLICT DO NOTHING`, [sourceId, JSON.stringify(manifest)]);
  }
  return appended ? publicationId : null;
}

/**
 * The event that recorded each input's tier change, for a propagation's cause:
 * the enclosing batch's own `trust.retiered` when the input lies in its
 * streams (its key is derived, it is appended at finalization), else the
 * newest per-subject event or bulk summary naming the input's key.
 */
export async function retierInputCauses(tx: BrainEngine, inputs: readonly { table: string; id: number }[]): Promise<Array<{ subject_key: string; event_key: string | null }>> {
  const resolved = await resolveSubjects(tx, inputs.map(i => ({ ...i, from: null, to: '' })));
  const batch = currentBeliefBatch();
  const out: Array<{ subject_key: string; event_key: string | null }> = [];
  for (const r of resolved) {
    if (batch && batch.sourceId === r.sourceId && batch.slugs.includes(r.stream)) {
      out.push({ subject_key: r.key, event_key: eventKeyHex(batch.publicationId, r.key, 'trust.retiered') });
      continue;
    }
    const [row] = await tx.executeRaw<{ key: string }>(`SELECT encode(k.event_key, 'hex') AS key FROM (
        SELECT e.id, e.event_key FROM belief_events e WHERE e.source_id = $1 AND e.subject_key = $2 AND e.event_type = 'trust.retiered'
        UNION ALL SELECT e.id, e.event_key FROM belief_retier_manifest m JOIN belief_events e ON e.id = m.summary_event
          WHERE m.source_id = $1 AND m.subject_key = $2) k ORDER BY k.id DESC LIMIT 1`, [r.sourceId, r.key]);
    out.push({ subject_key: r.key, event_key: row?.key ?? null });
  }
  return out;
}
