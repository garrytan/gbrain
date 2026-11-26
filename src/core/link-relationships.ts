/**
 * Relationship state refresh (temporal typed edges): one SQL implementation
 * for both engines. Reads every piece of evidence for the given relationships
 * (`links` assertions + `link_transitions`), runs the pure
 * `buildRelationshipState`, and upserts one `link_relationships` row per read
 * scope:
 *
 *   all    evidence from every live origin page in the relationship's source
 *   world  the same minus evidence from private origins, so private notes
 *          never change what a remote caller sees
 *
 * Callers run this inside the transaction that changed the evidence (link
 * writes, derived-link replacement, transition replacement), so state and
 * evidence commit together. Evidence from soft-deleted origins, from origins in
 * another source, or attached to a soft-deleted endpoint does not count.
 * Relationships with no remaining evidence lose their state row (and then read
 * as live, the same as an unrefreshed relationship).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { executeRawJsonb } from './sql-query.ts';
import { privatePagesFilterFragment } from './search/private-visibility.ts';
import {
  buildRelationshipState, relationSemantics, statusAt, stintsToMultirange, dateKey, temporalLinkTypes,
  type AssertionEvidence, type TransitionEvidence, type RelationshipScope, type TransitionProducer,
} from './link-validity.ts';

export interface RelationshipKey { from_page_id: number; to_page_id: number; link_type: string }

type RawExec = { executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> };

const keyOf = (k: RelationshipKey) => `${k.from_page_id}\0${k.to_page_id}\0${k.link_type}`;

/** Dedupe keys and keep only temporal (state/event) relation types. */
export function temporalKeys(keys: Iterable<RelationshipKey>): RelationshipKey[] {
  const out = new Map<string, RelationshipKey>();
  for (const k of keys) {
    if (!k || relationSemantics(k.link_type) === 'reference') continue;
    const from = Number(k.from_page_id), to = Number(k.to_page_id);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
    out.set(keyOf(k), { from_page_id: from, to_page_id: to, link_type: k.link_type });
  }
  return [...out.values()];
}

export interface AssertionRow { from_page_id: number; to_page_id: number; link_type: string; origin_id: number; tense: string; created_at: unknown; source_id: string; origin_public: boolean }
export interface TransitionRow { from_page_id: number; to_page_id: number; link_type: string; origin_id: number | null; kind: string; occurred_on: unknown; producer: string; created_at: unknown; source_id: string; origin_public: boolean }
export interface ExistingRow { from_page_id: number; to_page_id: number; link_type: string; scope: RelationshipScope; recorded_at: unknown; retired_at: unknown; evidence_hash: string }

/** Every piece of evidence for a set of relationships, and their state rows (BrainEngine readLinkRelationshipEvidence). */
export interface RelationshipEvidence { assertions: AssertionRow[]; transitions: TransitionRow[]; existing: ExistingRow[] }

/** One `link_relationships` row as the builder writes it. */
export interface RelationshipStateRow extends RelationshipKey {
  scope: RelationshipScope; source_id: string; semantics: 'state' | 'event'; valid_ranges: string; status_now: string;
  first_start: string | null; last_start: string | null; last_end: string | null; undated_present: number; undated_past: number;
  disputed: boolean; recorded_at: string; retired_at: string | null; evidence_hash: string;
}

/** The state rows to upsert and remove, and how many upserts changed (BrainEngine writeLinkRelationshipState). */
export interface RelationshipStateWrite {
  upserts: RelationshipStateRow[];
  removals: Array<RelationshipKey & { scope: RelationshipScope }>;
  changed: number;
}

/** Refresh the state of `keys`. Returns the number of state rows written or removed. */
export async function refreshRelationships(exec: RawExec, keys: Iterable<RelationshipKey>): Promise<number> {
  const rows = temporalKeys(keys);
  if (rows.length === 0) return 0;
  const payload = { rows };
  const assertions = await executeRawJsonb<AssertionRow>(exec,
    `SELECT v.from_page_id, v.to_page_id, v.link_type,
            COALESCE(l.origin_page_id, l.from_page_id) AS origin_id,
            COALESCE(l.assertion_tense, 'present') AS tense, l.created_at, f.source_id,
            (${privatePagesFilterFragment('o')}) AS origin_public
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN links l ON l.from_page_id = v.from_page_id AND l.to_page_id = v.to_page_id AND l.link_type = v.link_type
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
       JOIN pages o ON o.id = COALESCE(l.origin_page_id, l.from_page_id) AND o.deleted_at IS NULL AND o.source_id = f.source_id`,
    [], [payload]);
  const transitions = await executeRawJsonb<TransitionRow>(exec,
    `SELECT v.from_page_id, v.to_page_id, v.link_type, lt.origin_page_id AS origin_id, lt.kind,
            lt.occurred_on::text AS occurred_on, lt.producer, lt.created_at, f.source_id,
            (o.id IS NULL OR ${privatePagesFilterFragment('o')}) AS origin_public
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN link_transitions lt ON lt.from_page_id = v.from_page_id AND lt.to_page_id = v.to_page_id AND lt.link_type = v.link_type
       JOIN pages f ON f.id = lt.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id = lt.to_page_id AND t.deleted_at IS NULL
       LEFT JOIN pages o ON o.id = lt.origin_page_id
      WHERE lt.origin_page_id IS NULL OR (o.deleted_at IS NULL AND o.source_id = f.source_id)`,
    [], [payload]);
  const existing = await executeRawJsonb<ExistingRow>(exec,
    `SELECT lr.from_page_id, lr.to_page_id, lr.link_type, lr.scope, lr.recorded_at, lr.retired_at, lr.evidence_hash
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN link_relationships lr ON lr.from_page_id = v.from_page_id AND lr.to_page_id = v.to_page_id AND lr.link_type = v.link_type`,
    [], [payload]);

  const byKey = new Map<string, { a: AssertionRow[]; t: TransitionRow[] }>();
  const bucket = (k: RelationshipKey) => {
    const id = keyOf(k);
    let b = byKey.get(id);
    if (!b) { b = { a: [], t: [] }; byKey.set(id, b); }
    return b;
  };
  for (const a of assertions) bucket(a).a.push(a);
  for (const t of transitions) bucket(t).t.push(t);
  const prior = new Map(existing.map(e => [`${keyOf(e)}\0${e.scope}`, e]));

  let changed = 0;
  const upserts: Array<Record<string, unknown>> = [];
  const removals: Array<{ from_page_id: number; to_page_id: number; link_type: string; scope: RelationshipScope }> = [];
  const now = new Date();
  for (const key of rows) {
    const evidence = byKey.get(keyOf(key));
    const semantics = relationSemantics(key.link_type) as 'state' | 'event';
    for (const scope of ['all', 'world'] as const) {
      const a = (evidence?.a ?? []).filter(r => scope === 'all' || r.origin_public);
      const t = (evidence?.t ?? []).filter(r => scope === 'all' || r.origin_public);
      const before = prior.get(`${keyOf(key)}\0${scope}`);
      if (a.length === 0 && t.length === 0) {
        if (before) removals.push({ ...key, scope });
        continue;
      }
      const state = buildRelationshipState(semantics,
        a.map((r): AssertionEvidence => ({ tense: r.tense === 'past' ? 'past' : 'present', originPageId: Number(r.origin_id) })),
        t.map((r): TransitionEvidence => ({ kind: r.kind === 'end' ? 'end' : 'start', occurredOn: String(dateKey(r.occurred_on)), producer: r.producer as TransitionProducer, originPageId: r.origin_id == null ? null : Number(r.origin_id) })));
      const status = statusAt(state);
      const hash = evidenceHash(a, t);
      const earliest = [...a.map(r => r.created_at), ...t.map(r => r.created_at), before?.recorded_at]
        .map(v => (v instanceof Date ? v : v == null ? null : new Date(String(v))))
        .filter((d): d is Date => !!d && Number.isFinite(d.getTime()))
        .sort((x, y) => x.getTime() - y.getTime())[0] ?? now;
      const ended = status === 'ended' || status === 'ended_unknown_date';
      const priorRetired = before?.retired_at == null ? null : before.retired_at instanceof Date ? before.retired_at : new Date(String(before.retired_at));
      const retiredAt = ended ? (priorRetired ?? now) : null;
      upserts.push({
        ...key, scope, source_id: (a[0] ?? t[0]).source_id, semantics,
        valid_ranges: stintsToMultirange(state.stints), status_now: status,
        first_start: state.firstStart, last_start: state.lastStart, last_end: state.lastEnd,
        undated_present: state.undatedPresent, undated_past: state.undatedPast, disputed: state.disputed,
        recorded_at: earliest.toISOString(), retired_at: retiredAt ? retiredAt.toISOString() : null,
        evidence_hash: hash,
      });
      if (!before || before.evidence_hash !== hash || (before.retired_at == null) !== (retiredAt == null)) changed++;
    }
  }

  if (upserts.length) {
    const written = await executeRawJsonb(exec,
      `INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges,
         status_now, first_start, last_start, last_end, undated_present, undated_past, disputed, recorded_at, retired_at,
         evidence_hash, refreshed_at)
       SELECT v.from_page_id, v.to_page_id, v.link_type, v.scope, v.source_id, v.semantics, v.valid_ranges::datemultirange,
              v.status_now, v.first_start, v.last_start, v.last_end, v.undated_present, v.undated_past, v.disputed,
              v.recorded_at, v.retired_at, v.evidence_hash, now()
         FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text, scope text,
           source_id text, semantics text, valid_ranges text, status_now text, first_start date, last_start date,
           last_end date, undated_present int, undated_past int, disputed boolean, recorded_at timestamptz,
           retired_at timestamptz, evidence_hash text)
       ON CONFLICT (from_page_id, to_page_id, link_type, scope) DO UPDATE SET
         source_id = EXCLUDED.source_id, semantics = EXCLUDED.semantics, valid_ranges = EXCLUDED.valid_ranges,
         status_now = EXCLUDED.status_now, first_start = EXCLUDED.first_start, last_start = EXCLUDED.last_start,
         last_end = EXCLUDED.last_end, undated_present = EXCLUDED.undated_present, undated_past = EXCLUDED.undated_past,
         disputed = EXCLUDED.disputed, recorded_at = LEAST(link_relationships.recorded_at, EXCLUDED.recorded_at),
         retired_at = EXCLUDED.retired_at, evidence_hash = EXCLUDED.evidence_hash, refreshed_at = now()
       RETURNING 1`,
      [], [{ rows: upserts }]);
    if (written.length !== upserts.length) throw new Error('link_relationships refresh did not persist every state row');
  }
  if (removals.length) {
    const removed = await executeRawJsonb(exec,
      `DELETE FROM link_relationships lr
        USING jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text, scope text)
        WHERE lr.from_page_id = v.from_page_id AND lr.to_page_id = v.to_page_id AND lr.link_type = v.link_type AND lr.scope = v.scope
        RETURNING 1`,
      [], [{ rows: removals }]);
    changed += removed.length;
  }
  if (changed) await exec.executeRaw(`SELECT nextval('graph_generation_seq')`);
  return changed;
}

/** The pure part of a refresh: the state rows `evidence` gives each of `rows` (deduped temporal keys), in both scopes. */
export function buildRelationshipStateWrite(rows: readonly RelationshipKey[], evidence: RelationshipEvidence, now = new Date()): RelationshipStateWrite {
  const byKey = new Map<string, { a: AssertionRow[]; t: TransitionRow[] }>();
  const bucket = (k: RelationshipKey) => {
    const id = keyOf(k);
    let b = byKey.get(id);
    if (!b) { b = { a: [], t: [] }; byKey.set(id, b); }
    return b;
  };
  for (const a of evidence.assertions) bucket(a).a.push(a);
  for (const t of evidence.transitions) bucket(t).t.push(t);
  const prior = new Map(evidence.existing.map(e => [`${keyOf(e)}\0${e.scope}`, e]));

  let changed = 0;
  const upserts: RelationshipStateRow[] = [];
  const removals: RelationshipStateWrite['removals'] = [];
  for (const key of rows) {
    const found = byKey.get(keyOf(key));
    const semantics = relationSemantics(key.link_type) as 'state' | 'event';
    for (const scope of ['all', 'world'] as const) {
      const a = (found?.a ?? []).filter(r => scope === 'all' || r.origin_public);
      const t = (found?.t ?? []).filter(r => scope === 'all' || r.origin_public);
      const before = prior.get(`${keyOf(key)}\0${scope}`);
      if (a.length === 0 && t.length === 0) {
        if (before) removals.push({ ...key, scope });
        continue;
      }
      const state = buildRelationshipState(semantics,
        a.map((r): AssertionEvidence => ({ tense: r.tense === 'past' ? 'past' : 'present', originPageId: Number(r.origin_id) })),
        t.map((r): TransitionEvidence => ({ kind: r.kind === 'end' ? 'end' : 'start', occurredOn: String(dateKey(r.occurred_on)), producer: r.producer as TransitionProducer, originPageId: r.origin_id == null ? null : Number(r.origin_id) })));
      const status = statusAt(state);
      const hash = evidenceHash(a, t);
      const earliest = [...a.map(r => r.created_at), ...t.map(r => r.created_at), before?.recorded_at]
        .map(v => (v instanceof Date ? v : v == null ? null : new Date(String(v))))
        .filter((d): d is Date => !!d && Number.isFinite(d.getTime()))
        .sort((x, y) => x.getTime() - y.getTime())[0] ?? now;
      const ended = status === 'ended' || status === 'ended_unknown_date';
      const priorRetired = before?.retired_at == null ? null : before.retired_at instanceof Date ? before.retired_at : new Date(String(before.retired_at));
      const retiredAt = ended ? (priorRetired ?? now) : null;
      upserts.push({
        ...key, scope, source_id: (a[0] ?? t[0])!.source_id, semantics,
        valid_ranges: stintsToMultirange(state.stints), status_now: status,
        first_start: state.firstStart, last_start: state.lastStart, last_end: state.lastEnd,
        undated_present: state.undatedPresent, undated_past: state.undatedPast, disputed: state.disputed,
        recorded_at: earliest.toISOString(), retired_at: retiredAt ? retiredAt.toISOString() : null,
        evidence_hash: hash,
      });
      if (!before || before.evidence_hash !== hash || (before.retired_at == null) !== (retiredAt == null)) changed++;
    }
  }
  return { upserts, removals, changed };
}

function evidenceHash(a: readonly AssertionRow[], t: readonly TransitionRow[]): string {
  const parts = [
    ...a.map(r => `a:${r.origin_id}:${r.tense}`),
    ...t.map(r => `t:${r.origin_id ?? 'manual'}:${r.kind}:${dateKey(r.occurred_on)}:${r.producer}`),
  ].sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

/** Relationship keys with any evidence touching these pages (as endpoint or origin). */
export async function relationshipKeysForPages(exec: RawExec, pageIds: readonly number[]): Promise<RelationshipKey[]> {
  const ids = [...new Set(pageIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return [];
  const rows = await exec.executeRaw<RelationshipKey>(
    `SELECT DISTINCT from_page_id, to_page_id, link_type FROM links
      WHERE (from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[]) OR origin_page_id = ANY($1::int[]))
        AND link_type = ANY($2::text[])
     UNION
     SELECT DISTINCT from_page_id, to_page_id, link_type FROM link_transitions
      WHERE from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[]) OR origin_page_id = ANY($1::int[])
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_relationships
      WHERE from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[])`,
    [ids, temporalLinkTypes()]);
  return rows.map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));
}

/**
 * Relationships whose state is missing or older than their newest evidence,
 * oldest first. The extract cycle phase refreshes these so writers that bypass
 * the engine (or ran before an upgrade) converge.
 */
export async function staleRelationshipKeys(exec: RawExec, limit = 500): Promise<RelationshipKey[]> {
  const rows = await exec.executeRaw<RelationshipKey>(
    `SELECT from_page_id, to_page_id, link_type FROM (
       SELECT l.from_page_id, l.to_page_id, l.link_type, max(l.created_at) AS newest
         FROM links l WHERE l.link_type = ANY($1::text[]) GROUP BY 1, 2, 3
       UNION ALL
       SELECT lt.from_page_id, lt.to_page_id, lt.link_type, max(lt.created_at)
         FROM link_transitions lt GROUP BY 1, 2, 3
     ) e
     WHERE NOT EXISTS (SELECT 1 FROM link_relationships lr WHERE lr.from_page_id = e.from_page_id
         AND lr.to_page_id = e.to_page_id AND lr.link_type = e.link_type AND lr.scope = 'all' AND lr.refreshed_at >= e.newest)
     GROUP BY from_page_id, to_page_id, link_type
     ORDER BY min(newest) LIMIT $2`,
    [temporalLinkTypes(), limit]);
  // Relationships whose evidence-owning page was deleted, restored or edited
  // after the last refresh (soft deletes change no evidence row).
  const originChanged = rows.length >= limit ? [] : await exec.executeRaw<RelationshipKey>(
    `SELECT DISTINCT lr.from_page_id, lr.to_page_id, lr.link_type FROM link_relationships lr
       JOIN links l ON l.from_page_id = lr.from_page_id AND l.to_page_id = lr.to_page_id AND l.link_type = lr.link_type
       JOIN pages o ON o.id = COALESCE(l.origin_page_id, l.from_page_id)
      WHERE lr.scope = 'all' AND GREATEST(o.updated_at, COALESCE(o.deleted_at, o.updated_at)) > lr.refreshed_at
      LIMIT $1`, [limit - rows.length]);
  rows.push(...originChanged.filter(k => !rows.some(r => r.from_page_id === k.from_page_id && r.to_page_id === k.to_page_id && r.link_type === k.link_type)));
  // State rows whose evidence is gone entirely (raw deletes) are refreshed away too.
  const orphans = rows.length >= limit ? [] : await exec.executeRaw<RelationshipKey>(
    `SELECT lr.from_page_id, lr.to_page_id, lr.link_type FROM link_relationships lr
      WHERE lr.scope = 'all'
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = lr.from_page_id AND l.to_page_id = lr.to_page_id AND l.link_type = lr.link_type)
        AND NOT EXISTS (SELECT 1 FROM link_transitions t WHERE t.from_page_id = lr.from_page_id AND t.to_page_id = lr.to_page_id AND t.link_type = lr.link_type)
      LIMIT $1`, [limit - rows.length]);
  return [...rows, ...orphans].map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));
}


/**
 * Extract-phase sweep: relationships whose state is missing, older than their
 * newest evidence, or orphaned converge here, bounded per cycle. Zero LLM.
 * Returns details for the phase result; never throws.
 */
export async function sweepStaleRelationships(engine: BrainEngine, limit = 2000): Promise<Record<string, unknown>> {
  try {
    const { primeRelationSemantics } = await import('./link-semantics-pack.ts');
    await primeRelationSemantics(engine);
    const keys = await staleRelationshipKeys(engine, limit);
    if (!keys.length) return {};
    const { maintenanceTransaction } = await import('./persistence/attribution.ts');
    const changed = await maintenanceTransaction(engine, tx => refreshRelationships(tx, keys));
    return { relationships_swept: keys.length, relationships_changed: changed };
  } catch (e) {
    return { relationship_sweep_error: e instanceof Error ? e.message : String(e) };
  }
}
