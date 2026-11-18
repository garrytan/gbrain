/**
 * Relationship state refresh (temporal typed edges). Reads every piece of
 * evidence for the given relationships (`links` assertions +
 * `link_transitions`) through the engine, runs the pure
 * `buildRelationshipState`, and writes one `link_relationships` row per read
 * scope:
 *
 *   all    evidence from every live origin page in the relationship's source
 *   world  the same minus evidence from private origins, so private notes
 *          never change what a remote caller sees
 *
 * The reads and writes are engine members: src/core/engine-sql/link-temporal.ts
 * on PGLite and Postgres, the store on Rust (rust/docs/store/link_temporal.md).
 * Callers run this inside the transaction that changed the evidence (link
 * writes, derived-link replacement, transition replacement), so state and
 * evidence commit together; the Rust engine has no transactions, so there the
 * refresh follows the evidence write. Evidence from soft-deleted origins, from
 * origins in another source, or attached to a soft-deleted endpoint does not
 * count. Relationships with no remaining evidence lose their state row (and
 * then read as live, the same as an unrefreshed relationship).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import {
  buildRelationshipState, relationSemantics, statusAt, stintsToMultirange, dateKey,
  type AssertionEvidence, type TransitionEvidence, type RelationshipScope, type TransitionProducer,
} from './link-validity.ts';

export interface RelationshipKey { from_page_id: number; to_page_id: number; link_type: string }

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

/** The engine members a refresh reads and writes through. */
export type RelationshipStateStore = Pick<BrainEngine, 'readLinkRelationshipEvidence' | 'writeLinkRelationshipState'>;

/**
 * Refresh the state of `keys`. Returns the number of state rows written or removed. Each engine reads the evidence
 * and writes the rows (engine-sql/link-temporal.ts, or the Rust store); the state itself is built here.
 */
export async function refreshRelationships(engine: RelationshipStateStore, keys: Iterable<RelationshipKey>): Promise<number> {
  const rows = temporalKeys(keys);
  if (rows.length === 0) return 0;
  const evidence = await engine.readLinkRelationshipEvidence(rows);
  return engine.writeLinkRelationshipState(buildRelationshipStateWrite(rows, evidence));
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
export async function relationshipKeysForPages(engine: Pick<BrainEngine, 'linkRelationshipKeysForPages'>, pageIds: readonly number[]): Promise<RelationshipKey[]> {
  const ids = [...new Set(pageIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return [];
  return engine.linkRelationshipKeysForPages(ids);
}

/**
 * Relationships whose state is missing or older than their newest evidence,
 * oldest first. The extract cycle phase refreshes these so writers that bypass
 * the engine (or ran before an upgrade) converge.
 */
export function staleRelationshipKeys(engine: Pick<BrainEngine, 'staleLinkRelationshipKeys'>, limit = 500): Promise<RelationshipKey[]> {
  return engine.staleLinkRelationshipKeys(limit);
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
