/**
 * Purge receipts and verification (#5575 C4, CEO-22, ENG-12, DX-12).
 *
 * One adapter per inventory store, each with an explicit scope, a row bound
 * and a statement deadline. A swept store whose probe still finds the claim is
 * `incomplete`; a probe stopped by its deadline or bound is `unverified`;
 * claim text that survives outside a fence (page prose, a version's prose) is
 * `out_of_scope: source_prose`; rows purge hid are `retained_inactive`, never
 * counted as a zero residual. The vector probe lists same-model neighbours as
 * paraphrase candidates and is never a gate.
 *
 * The receipt lists residuals first and says "removed from live stores"; it
 * never claims erasure. Verification needs the claim text, which exists only
 * in memory during the purge call; `--status` reports completion from the
 * stored receipt, the effects and a fingerprint probe.
 */

import { spawn } from '../spawn.ts';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { getCode } from '../retry-matcher.ts';
import { CLAIM_FORMS_BATCH, claimTextForms, escapeFenceCell } from '../fence-shared.ts';
import { gbrainPath } from '../config.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { DELETION_INVENTORY, OUT_OF_REACH_RESIDUALS, type InventoryEntry } from '../deletion-inventory.ts';
import type { PurgePlan, PurgeTarget } from './purge.ts';
import { gitChildEnv } from '../git-env.ts';
import { segmentedBodyContains } from '../page-body/segment-rewrite.ts';
import { derivationAfterSql, derivationBatchRows, derivationNeedles, derivationPurgeState, recordDerivationStatement,
  type DerivationKey, type DerivationPendingReason, type DerivationStallReason, type DerivationSweepState } from '../page-body/segment-derive.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { derivationClaimCandidateSql, derivationHoldsClaimSql, derivationSweepScopeSql, stagingNeedsTextSql } from '../page-body/schema.ts';
import { claimForms, quotes, type LedgerPurgeReport } from '../belief/purge.ts';
import { CARRYING_FIELDS } from '../belief/keys.ts';
import { relationExists } from '../persistence/rebuildable-cache.ts';

export type StoreCount = Record<string, number>;
export type StoreStatus = 'deleted' | 'would_remove' | 'retained_inactive' | 'unverified' | 'out_of_reach' | 'out_of_scope' | 'not_present' | 'incomplete';
export interface StoreReport { store: string; status: StoreStatus; removed?: number; remaining?: number; reason?: string; detail?: string; items?: unknown[]; probe?: string }
export type PurgeCompletion = 'committed' | 'complete' | 'incomplete';
export interface PurgeReceipt {
  summary: string;
  fact_id: number;
  /** gbrain_fact_fingerprint of the claim: the receipt's content hash. Guessable for short claims. */
  fact_hash: string;
  hash8: string;
  source_id: string;
  subject: string;
  visibility: string;
  residuals: StoreReport[];
  stores: StoreReport[];
  vector_probe: Record<string, unknown>;
  next: string[];
  tell_user_to_run?: { argv: string[]; why: string };
}

/**
 * A page or page-version row (alias `a`) still states the claim: in its body,
 * timeline, title or frontmatter. `$n` is the lowercased claim, `$n+1` its
 * JSON-escaped form (frontmatter is matched as JSON text).
 */
export const carriesClaimSql = (a: string, n: number) => `(strpos(lower(${a}.compiled_truth),$${n})>0 OR strpos(lower(COALESCE(${a}.timeline,'')),$${n})>0
  OR strpos(lower(COALESCE(${a}.title,'')),$${n})>0 OR strpos(lower(COALESCE(${a}.frontmatter::text,'')),$${n + 1})>0)`;
export const claimNeedles = (claim: string): [string, string] => [claim.toLowerCase(), JSON.stringify(claim.toLowerCase()).slice(1, -1)];

export const PURGE_PROBE_LIMITS = { rows: 1000, statementMs: 2_000, totalMs: 20_000, gitBytes: 64 * 1024 * 1024, gitMs: 10_000 } as const;
let probeLimits: { rows: number; statementMs: number; totalMs: number } = { ...PURGE_PROBE_LIMITS };
/** Test seam: shrink the probe bounds (null restores them). */
export function __setPurgeProbeLimitsForTests(limits: Partial<typeof probeLimits> | null): void {
  probeLimits = limits ? { ...probeLimits, ...limits } : { ...PURGE_PROBE_LIMITS };
}

/**
 * Wave B (spec 11): which segmented bodies of the source state one of `needles`, case-insensitively: live pages
 * (`pages`) or retained versions (`page_versions`), each scanned one segment at a time with the tail of the
 * previous segment carried over the needle's length (a forced cut can split prose). Bounded like every probe.
 */
async function segmentedProse(engine: BrainEngine, sourceId: string, needles: readonly string[], deadline: number, store: 'pages' | 'page_versions'):
  Promise<{ hits: Array<{ slug: string; version_id?: number }> } | { unverified: string }> {
  const bodies = store === 'pages'
    ? await engine.executeRaw<{ page_id: number; slug: string; generation: null; version_id: null }>(`SELECT id AS page_id,slug,NULL AS generation,NULL AS version_id FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND body_storage='segmented' ORDER BY id LIMIT $2`, [sourceId, probeLimits.rows + 1])
    : await engine.executeRaw<{ page_id: number; slug: string; generation: number; version_id: number }>(`SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id
      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2`, [sourceId, probeLimits.rows + 1]);
  if (bodies.length > probeLimits.rows) return { unverified: 'row_bound' };
  const hits: Array<{ slug: string; version_id?: number }> = [];
  for (const body of bodies) {
    const found = await segmentedBodyContains(engine, Number(body.page_id), sourceId, needles,
      { deadline, ...(body.generation === null ? {} : { generation: Number(body.generation) }) });
    if (found === 'deadline') return { unverified: 'verification_deadline' };
    if (found) hits.push({ slug: body.slug, ...(body.version_id === null ? {} : { version_id: Number(body.version_id) }) });
  }
  return { hits };
}

/** A page-text store's report with its segmented bodies folded in: a body still stating the claim is prose, a stopped scan is unverified. */
async function withSegmentedProse(engine: BrainEngine, report: StoreReport, sourceId: string, needles: readonly string[], deadline: number): Promise<StoreReport> {
  if (report.status === 'would_remove' || report.status === 'incomplete' || report.status === 'unverified') return report;
  const scan = await segmentedProse(engine, sourceId, needles, deadline, report.store as 'pages' | 'page_versions');
  if ('unverified' in scan) return { ...report, status: 'unverified', reason: scan.unverified };
  if (!scan.hits.length) return report;
  return { ...report, status: 'out_of_scope', reason: 'source_prose', remaining: (report.remaining ?? 0) + scan.hits.length,
    items: [...(report.items ?? []), ...scan.hits].slice(0, 20),
    detail: 'The claim text survives outside a facts fence (page prose); purge the page or edit it to remove it.' };
}

/**
 * Segment texts of the source holding the claim's exact bytes: a text no manifest row references any more is a
 * residual of the sweep (`incomplete`); a referenced one is a body's prose, reported with that body.
 */
async function segmentTextReport(engine: BrainEngine, sourceId: string, needles: readonly string[], removed: number, deadline: number): Promise<StoreReport> {
  const list = needles.filter(Boolean).slice(0, 32);
  const carrying = `SELECT 1 FROM page_segment_texts t WHERE t.source_id=$1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE position(convert_to(n,'UTF8') in t.body)>0)`;
  const referenced = 'EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256)';
  const orphaned = await boundedCount(engine, `${carrying} AND NOT ${referenced}`, [sourceId, list], deadline);
  if ('unverified' in orphaned) return { store: 'page_segment_texts', status: 'unverified', reason: orphaned.unverified, removed };
  if (orphaned.count) return { store: 'page_segment_texts', status: 'incomplete', remaining: orphaned.count, removed };
  const kept = await boundedCount(engine, `${carrying} AND ${referenced}`, [sourceId, list], deadline);
  if ('unverified' in kept) return { store: 'page_segment_texts', status: 'unverified', reason: kept.unverified, removed };
  return kept.count
    ? { store: 'page_segment_texts', status: 'out_of_scope', reason: 'source_prose', remaining: kept.count, removed,
      detail: 'Segments of live pages or retained versions still state the text outside a facts fence; they are listed under pages and page_versions.' }
    : { store: 'page_segment_texts', status: removed ? 'deleted' : 'not_present', removed };
}

/**
 * Derivation rows holding the claim, matched and scoped as the purge sweeps them (segment-derive.ts
 * derivationHoldsClaimSql, derivationSweepScopeSql): a row the sweep covers is a residual (`incomplete`); a row of a
 * live segment of a page the purge did not rewrite is that page's prose, reported with it. The source's rows are walked
 * in primary-key order, segment-derive.ts derivationBatchRows() per statement, each under the probe's statement bound; a
 * statement that outruns it is read again in half as many rows, down to one row, and a single row that still outruns it
 * leaves the store unverified. A probe that stops (a deadline or its row bound) after a statement counted a row holding
 * the claim reports what it found, the stop as `probe`: a row the sweep covers makes the store `incomplete`, a row of a
 * live segment of another page `out_of_scope`. Only when no statement that ran counted one and the purge's own sweep
 * already ended verified (`sweepVerified`: its record is gone, removed only after a walk that deleted nothing) does a
 * probe stopped by a deadline report the sweep's result instead, with the deadline it hit as `probe`.
 */
async function derivationTextReport(engine: BrainEngine, sourceId: string, pageIds: readonly number[], claims: readonly string[], removed: number,
  deadline: number, sweepVerified: boolean): Promise<StoreReport> {
  const { needles, patterns } = await derivationNeedles(engine, claims);
  if (!needles.length) return { store: 'page_segment_derivations', status: removed ? 'deleted' : 'not_present', removed };
  let swept = 0, kept = 0;
  const unverified = (reason: string): StoreReport => {
    if (swept) return { store: 'page_segment_derivations', status: 'incomplete', remaining: swept, removed, probe: reason,
      detail: `The receipt's probe stopped (${reason}) after it counted ${swept} stored result(s) the sweep covers still holding the claim; there may be more.` };
    if (kept) return { store: 'page_segment_derivations', status: 'out_of_scope', reason: 'source_prose', remaining: kept, removed, probe: reason,
      detail: `The receipt's probe stopped (${reason}) after it counted ${kept} derivation(s) of live segments of pages the purge did not rewrite that hold the text their prose still states; they are listed under pages.` };
    return sweepVerified && reason !== 'row_bound'
      ? { store: 'page_segment_derivations', status: removed ? 'deleted' : 'not_present', removed, reason: 'verified_by_sweep', probe: reason,
        detail: `The receipt's probe stopped at its deadline (${reason}) before any statement that ran counted a stored result holding the claim; the purge's sweep had already verified that no stored result it covers holds it. Results of live segments of other pages that still state it are listed under pages.` }
      : { store: 'page_segment_derivations', status: 'unverified', reason, removed };
  };
  let cursor: DerivationKey | null = null;
  let rows = derivationBatchRows();
  for (;;) {
    if (performance.now() > deadline) return unverified('verification_deadline');
    let row: { scanned: number; normalized: number; swept: number; kept: number; last_page: number | null; last_pipeline: string | null; last_occurrence: string | null };
    try {
      row = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('statement_timeout',$1,true)", [`${probeLimits.statementMs}ms`]);
        await faultPoint('purge:derivation_probe', { sourceId, round: rows });
        const [counted] = await tx.executeRaw<typeof row>(`WITH batch AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, ${derivationSweepScopeSql('d', 'p', '$3')} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND ${derivationAfterSql('d', ['$5', '$6', '$7'])}
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT $8
          ), checked AS MATERIALIZED (
            SELECT b.swept, c.candidate, CASE WHEN c.candidate THEN ${derivationHoldsClaimSql('d', '$2', '$4')} ELSE false END AS hit
            FROM batch b JOIN page_segment_derivations d ON d.page_id=b.page_id AND d.pipeline=b.pipeline AND d.occurrence_id=b.occurrence_id
            CROSS JOIN LATERAL (SELECT ${derivationClaimCandidateSql('d', '$4')} AS candidate) c
          ), last AS (
            SELECT b.page_id, b.pipeline, b.occurrence_id::text AS occurrence_id FROM batch b ORDER BY b.page_id DESC, b.pipeline DESC, b.occurrence_id DESC LIMIT 1
          ) SELECT (SELECT count(*)::int FROM batch) AS scanned, count(*) FILTER (WHERE candidate)::int AS normalized,
            count(*) FILTER (WHERE hit AND swept)::int AS swept, count(*) FILTER (WHERE hit AND NOT swept)::int AS kept,
            (SELECT page_id FROM last) AS last_page, (SELECT pipeline FROM last) AS last_pipeline, (SELECT occurrence_id FROM last) AS last_occurrence
          FROM checked`, [sourceId, needles, [...pageIds], patterns, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, rows]);
        return counted!;
      });
    } catch (error) {
      if (getCode(error) !== '57014') throw error;
      if (rows === 1) return unverified('statement_deadline');
      rows = Math.floor(rows / 2);
      continue;
    }
    recordDerivationStatement({ phase: 'probe', scanned: Number(row.scanned), normalized: Number(row.normalized) });
    swept += Number(row.swept);
    kept += Number(row.kept);
    if (swept > probeLimits.rows || kept > probeLimits.rows) return unverified('row_bound');
    if (Number(row.scanned) < rows) break;
    cursor = [Number(row.last_page), row.last_pipeline!, String(row.last_occurrence)];
  }
  if (swept) return { store: 'page_segment_derivations', status: 'incomplete', remaining: swept, removed };
  return kept
    ? { store: 'page_segment_derivations', status: 'out_of_scope', reason: 'source_prose', remaining: kept, removed,
      detail: 'Derivations of live segments of pages the purge did not rewrite hold the text their prose still states; they are listed under pages.' }
    : { store: 'page_segment_derivations', status: removed ? 'deleted' : 'not_present', removed };
}

type ProbeResult = { count: number } | { unverified: string };

/** #6911: a rebuildable cache table that does not exist holds nothing to verify. */
const missingCache = (store: string): StoreReport => ({ store, status: 'not_present', removed: 0, reason: 'table_missing',
  detail: `The ${store} table does not exist on this brain; it is a rebuildable cache, so there was nothing to clear. gbrain doctor reports it under schema_missing_tables.` });

/** One bounded probe: `sql` selects matching rows (no LIMIT); the adapter caps rows and the statement time. */
async function boundedCount(engine: BrainEngine, sql: string, params: unknown[], deadline: number): Promise<ProbeResult> {
  if (performance.now() > deadline) return { unverified: 'verification_deadline' };
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('statement_timeout',$1,true)", [`${probeLimits.statementMs}ms`]);
      const [row] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql} LIMIT ${probeLimits.rows + 1}) bounded`, params);
      const count = Number(row?.n ?? 0);
      return count > probeLimits.rows ? { unverified: 'row_bound' } : { count };
    });
  } catch (error) {
    if (getCode(error) === '57014') return { unverified: 'statement_deadline' };
    throw error;
  }
}

const textMatch = (column: string, at: number) => `(strpos(lower(${column}::text),$${at})>0 OR strpos(lower(${column}::text),$${at + 1})>0)`;
/** Vector and lexeme columns carry no probe-able text. */
const PROBE_SKIP = /embedding|search_vector/;
/** Stores whose probe columns are bytea; their bytes are matched exactly (case-sensitive) against the UTF-8 needle. */
const BINARY_PROBE_TABLES: ReadonlySet<string> = new Set(['minion_attachments', 'page_segment_texts', 'page_body_staging_parts']);

/** Probe one inventory table for any of `needles` (exact, case-insensitive; JSON also in its escaped form). Scoped to the source when the table has one. */
async function probeTable(engine: BrainEngine, entry: InventoryEntry, sourceId: string, needles: readonly string[], deadline: number): Promise<ProbeResult> {
  const columns = (entry.probe ?? entry.columns).filter(col => !PROBE_SKIP.test(col));
  const list = needles.filter(Boolean).slice(0, 32);
  if (!columns.length || !list.length) return { count: 0 };
  const scoped = entry.columns.includes('source_id');
  const binary = BINARY_PROBE_TABLES.has(entry.table);
  const params: unknown[] = [sourceId];
  const ors: string[] = [];
  for (const needle of list) {
    if (binary) { params.push(needle); ors.push(...columns.map(col => `position(convert_to($${params.length}::text,'UTF8') in ${col})>0`)); continue; }
    params.push(needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase());
    ors.push(...columns.map(col => textMatch(col, params.length - 1)));
  }
  return boundedCount(engine, `SELECT 1 FROM ${entry.table} WHERE ${scoped ? 'source_id=$1 AND' : '$1::text IS NOT NULL AND'} (${ors.join(' OR ')})`, params, deadline);
}

/**
 * W1 prerequisite (BELIEF_LEDGER.md 6.5): link context, timeline detail and raw data are reported, not swept, so their
 * receipt names the rows that still carry the claim (scoped to the source through their page), not only a count.
 */
const NAMED_ROW_PROBES: Readonly<Record<string, { select: string; columns: readonly string[] }>> = {
  links: { columns: ['l.context'], select: `SELECT 'link:' || l.id || ' ' || f.slug || ' -> ' || t.slug AS item FROM links l JOIN pages f ON f.id = l.from_page_id
    JOIN pages t ON t.id = l.to_page_id WHERE (f.source_id = $1 OR t.source_id = $1)` },
  timeline_entries: { columns: ['x.summary', 'x.detail'], select: `SELECT 'timeline:' || x.id || ' ' || p.slug || ' ' || x.date::text AS item FROM timeline_entries x
    JOIN pages p ON p.id = x.page_id WHERE p.source_id = $1` },
  raw_data: { columns: ['r.data'], select: `SELECT 'raw_data:' || r.id || ' ' || p.slug || ' ' || r.source AS item FROM raw_data r JOIN pages p ON p.id = r.page_id WHERE p.source_id = $1` },
};

let namedRowProbes = true;
/** Forced-probe seam: false restores the count-only generic adapter for these stores. */
export function __setNamedRowProbesForTests(enabled: boolean): void { namedRowProbes = enabled; }

async function probeNamedRows(engine: BrainEngine, entry: InventoryEntry, sourceId: string, needles: readonly string[], deadline: number): Promise<StoreReport> {
  const named = NAMED_ROW_PROBES[entry.table]!;
  const params: unknown[] = [sourceId];
  const ors: string[] = [];
  for (const needle of needles.filter(Boolean).slice(0, 32)) {
    params.push(needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase());
    ors.push(...named.columns.map(col => textMatch(col, params.length - 1)));
  }
  if (!ors.length) return { store: entry.table, status: 'not_present' };
  const sql = `${named.select} AND (${ors.join(' OR ')})`;
  const counted = await boundedCount(engine, sql, params, deadline);
  if ('unverified' in counted) return { store: entry.table, status: 'unverified', reason: counted.unverified };
  if (!counted.count) return { store: entry.table, status: 'not_present' };
  const items = (await engine.executeRaw<{ item: string }>(`${sql} ORDER BY 1 LIMIT 20`, params)).map(r => r.item);
  return { store: entry.table, status: 'out_of_scope', reason: 'probed_reported', remaining: counted.count, items,
    detail: `${counted.count} row(s) still carry the purged text (listed in items, up to 20); purge does not rewrite this store, so edit or remove them.` };
}

/** W1 (BELIEF_LEDGER.md 6.5): a queued effect whose payload still carries the purged text would write it back after the purge. */
async function effectPayloadReport(engine: BrainEngine, sourceId: string, needles: readonly string[], deadline: number, removed: number): Promise<StoreReport> {
  const list = needles.filter(Boolean).slice(0, 32);
  if (!list.length) return { store: 'persistence_effects', status: 'not_present' };
  const params: unknown[] = [sourceId, ...list.flatMap(n => [n.toLowerCase(), JSON.stringify(n).slice(1, -1).toLowerCase()])];
  const ors = list.flatMap((_, i) => ['data', 'outcome', 'recovery'].map(c => textMatch(`COALESCE(e.${c}::text,'')`, 2 + i * 2)));
  const sql = `SELECT 'effect:' || e.id || ' ' || e.kind || ' ' || e.state AS item FROM persistence_effects e WHERE e.source_id = $1 AND (${ors.join(' OR ')})`;
  const counted = await boundedCount(engine, sql, params, deadline);
  if ('unverified' in counted) return { store: 'persistence_effects', status: 'unverified', reason: counted.unverified, removed };
  if (!counted.count) return { store: 'persistence_effects', status: removed ? 'deleted' : 'not_present', removed };
  const items = (await engine.executeRaw<{ item: string }>(`${sql} ORDER BY 1 LIMIT 20`, params)).map(r => r.item);
  return { store: 'persistence_effects', status: 'incomplete', remaining: counted.count, items, removed,
    detail: 'Queued or recorded effects still carry the purged text in their payload, so running them could write it back.' };
}

/**
 * The belief ledger after its purge redaction (BELIEF_LEDGER.md 6.5): a carrying field still quoting the claim is
 * `incomplete`; the redacted fields are named; a live row whose own context quotes the claim survives the purge and is
 * named as `fact_context` (`out_of_scope: source_prose`) so the user can edit it.
 */
/** Every string inside a recorded value, with the field it sits under. */
function valueStrings(value: unknown, field = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[field, value]];
  if (Array.isArray(value)) return value.flatMap(v => valueStrings(v, field));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => valueStrings(v, field || k));
  return [];
}

/**
 * W1 (BELIEF_LEDGER.md 6.5): what recorded history still says about the claims. Every value is read in keyset
 * batches and matched in JS (case folded like the purge passes, #11). A carrying field still quoting a claim is a
 * redaction the purge missed (`incomplete`); any other field (another subject's longer claim, #12) is history the
 * purge does not rewrite, reported by key as `out_of_scope`.
 */
async function ledgerReports(engine: BrainEngine, sourceId: string, claims: readonly string[], ledger: LedgerPurgeReport | null | undefined, deadline: number): Promise<StoreReport[]> {
  const forms = claimForms(claims);
  if (!forms.length) return [];
  const redacted = ledger?.redacted_fields ?? [];
  const removed = (ledger?.purged_events ?? 0) + redacted.length;
  const missed: string[] = [], other: string[] = [];
  let unverified: string | null = null;
  for (let after = 0; ;) {
    if (performance.now() > deadline) { unverified = 'verification_deadline'; break; }
    const rows = await engine.executeRaw<{ id: number; subject_kind: string; subject_key: string; value: unknown }>(`SELECT id, subject_kind, subject_key, value
      FROM belief_events WHERE source_id = $1 AND id > $2 AND value IS NOT NULL ORDER BY id LIMIT 1000`, [sourceId, after]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1]!.id);
    for (const row of rows) {
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      for (const [field, text] of valueStrings(value)) {
        if (!quotes(text, forms)) continue;
        ((CARRYING_FIELDS[row.subject_kind] ?? []).includes(field) ? missed : other).push(`${field}@${row.subject_key}`);
      }
    }
    if (rows.length < 1000) break;
  }
  const items = [...new Set(redacted.map(r => `${r.field}@${r.subject_key}`))].slice(0, 20);
  const reports: StoreReport[] = [unverified ? { store: 'belief_events', status: 'unverified', reason: unverified, removed }
    : missed.length ? { store: 'belief_events', status: 'incomplete', remaining: missed.length, removed, items: [...new Set(missed)].slice(0, 20) }
      : other.length ? { store: 'belief_events', status: 'out_of_scope', reason: 'probed_reported', remaining: new Set(other).size, removed, items: [...new Set(other)].slice(0, 20),
        detail: 'These recorded events belong to other subjects whose own value quotes the purged claim (a longer claim, say); purge redacts only the purged keys and the fields that quote them. Purge those subjects too to remove them.' }
        : { store: 'belief_events', status: removed ? 'deleted' : 'not_present', removed, ...(items.length ? { items,
          detail: 'Recorded history keeps each event\'s skeleton; the purged values and every carrying field that quoted them now read as the redaction marker.' } : {}) }];
  const live: number[] = [];
  for (let after = 0; live.length < 20 && performance.now() <= deadline; ) {
    const rows = await engine.executeRaw<{ id: number; context: string }>(`SELECT id, context FROM facts WHERE source_id = $1 AND id > $2 AND expired_at IS NULL
      AND COALESCE(context, '') <> '' ORDER BY id LIMIT 1000`, [sourceId, after]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1]!.id);
    for (const r of rows) if (live.length < 20 && quotes(r.context, forms)) live.push(Number(r.id));
    if (rows.length < 1000) break;
  }
  if (live.length) {
    const keys = [...new Set([...(ledger?.live_carriers ?? []), ...redacted].filter(r => r.field === 'context').map(r => r.subject_key))].slice(0, 20);
    reports.push({ store: 'fact_context', status: 'out_of_scope', reason: 'source_prose', remaining: live.length, items: [...live.map(id => `f${id}`), ...keys],
      detail: 'These live facts quote the purged claim in their context, which purge leaves as it is; their recorded history shows the redaction marker until the owner replaces the context. Edit them.' });
  }
  return reports;
}

/** The generic adapter for a `probed_reported` inventory entry. */
async function probeInventoryStore(engine: BrainEngine, entry: InventoryEntry, sourceId: string, needles: readonly string[], deadline: number): Promise<StoreReport> {
  if (namedRowProbes && NAMED_ROW_PROBES[entry.table]) return probeNamedRows(engine, entry, sourceId, needles, deadline);
  const result = await probeTable(engine, entry, sourceId, needles, deadline);
  if ('unverified' in result) return { store: entry.table, status: 'unverified', reason: result.unverified };
  return result.count
    ? { store: entry.table, status: 'out_of_scope', reason: 'probed_reported', remaining: result.count,
      detail: `${result.count} row(s) still mention the purged text; purge does not rewrite this store${entry.columns.includes('source_id') ? '' : ' (probed brain-wide)'}.` }
    : { store: entry.table, status: 'not_present' };
}

/**
 * CEO-22: every swept inventory store appears in a receipt. A swept store
 * without its own adapter is probed for the purged text: still present is
 * `incomplete`; absent is `deleted` when the sweep removed rows there, else
 * `not_present`.
 */
async function sweptInventoryReports(engine: BrainEngine, reported: ReadonlySet<string>, sourceId: string, needles: readonly string[],
  removed: StoreCount, deadline: number, dryRun: boolean): Promise<StoreReport[]> {
  const reports: StoreReport[] = [];
  for (const entry of DELETION_INVENTORY) {
    if (entry.class !== 'swept' || reported.has(entry.table)) continue;
    const planned = removed[entry.table] ?? 0;
    if (dryRun) { reports.push({ store: entry.table, status: planned ? 'would_remove' : 'not_present', removed: planned }); continue; }
    const result = await probeTable(engine, entry, sourceId, needles, deadline);
    if ('unverified' in result) reports.push({ store: entry.table, status: 'unverified', reason: result.unverified, removed: planned });
    else if (result.count) reports.push({ store: entry.table, status: 'incomplete', remaining: result.count, removed: planned });
    else reports.push({ store: entry.table, status: planned ? 'deleted' : 'not_present', removed: planned });
  }
  return reports;
}

/** Commits in the page files' history that add or remove the claim's fence cell. The pattern never enters argv. */
export async function gitResidualCommits(root: string, paths: readonly string[], claim: string, limits = { bytes: PURGE_PROBE_LIMITS.gitBytes, ms: PURGE_PROBE_LIMITS.gitMs }):
  Promise<StoreReport> {
  if (!paths.length || !existsSync(join(root, '.git'))) return { store: 'git_history', status: 'out_of_reach', reason: 'no_repository', detail: 'No brain repository is recorded for these pages.' };
  const needles = [escapeFenceCell(claim).toLowerCase(), claim.toLowerCase()];
  return new Promise(resolve => {
    const child = spawn('git', ['-C', root, '--literal-pathspecs', 'log', '--all', '--format=commit %H %cI', '-p', '--no-color', '--no-ext-diff', '--', ...paths],
      { stdio: ['ignore', 'pipe', 'ignore'], env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }) });
    const commits: Array<{ commit: string; committed_at: string }> = [];
    let current: { commit: string; committed_at: string } | null = null, bytes = 0, tail = '', bounded: string | null = null;
    const timer = setTimeout(() => { bounded = 'deadline'; child.kill('SIGKILL'); }, limits.ms);
    const scan = (line: string) => {
      if (line.startsWith('commit ')) { const [, commit, at] = line.split(' '); current = { commit, committed_at: at }; return; }
      if (!current || commits.at(-1)?.commit === current.commit) return;
      if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
        const lower = line.toLowerCase();
        if (needles.some(n => lower.includes(n))) commits.push(current);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.bytes) { bounded = 'byte_bound'; child.kill('SIGKILL'); return; }
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) scan(line);
    });
    child.on('error', () => { clearTimeout(timer); resolve({ store: 'git_history', status: 'out_of_reach', reason: 'git_unavailable' }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (tail) scan(tail);
      const items = commits.slice(0, 50);
      resolve({ store: 'git_history', status: bounded ? 'unverified' : 'out_of_reach', ...(bounded ? { reason: bounded } : {}), remaining: commits.length, items,
        detail: commits.length ? `${commits.length} commit(s) in this repository's history add or remove the row; purge never rewrites history (other clones and remotes have their own copies).`
          : 'No commit in the page files\' recorded history carries the row.' });
    });
  });
}

async function pageFilePaths(engine: BrainEngine, sourceId: string, pageIds: number[]): Promise<{ root: string | null; paths: string[]; files: string[] }> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source?.local_path || !pageIds.length) return { root: source?.local_path ?? null, paths: [], files: [] };
  const rows = await engine.executeRaw<{ source_path: string }>(`SELECT DISTINCT source_path FROM (
      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s
    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64`, [pageIds]);
  const paths = rows.map(r => r.source_path);
  return { root: source.local_path, paths, files: paths.map(p => join(source.local_path!, p)) };
}

/** The canonical files, their .tmp evidence and the failure log; the .tmp copy carrying the claim is deleted. */
function onDiskReports(files: string[], claim: string, dryRun: boolean): StoreReport[] {
  const needle = claim.toLowerCase();
  const carrying = (path: string) => { try { return existsSync(path) && readFileSync(path, 'utf8').toLowerCase().includes(needle); } catch { return false; } };
  const stale = files.filter(carrying);
  const tmp = files.map(f => `${f}.tmp`).filter(carrying);
  if (!dryRun) for (const path of tmp) { try { unlinkSync(path); } catch { /* reported below */ } }
  const tmpLeft = dryRun ? tmp : tmp.filter(existsSync);
  const log = carrying(gbrainPath('facts.write_failures.jsonl'));
  return [
    { store: 'canonical_markdown', status: !files.length ? 'not_present' : stale.length ? (dryRun ? 'would_remove' : 'out_of_scope') : (dryRun ? 'not_present' : 'deleted'),
      ...(!files.length ? { detail: 'No page file is recorded for the affected pages (database-only source).' } : {}),
      ...(stale.length ? { remaining: stale.length, reason: dryRun ? undefined : 'pending_mirror_or_prose',
        detail: dryRun ? 'The mirror effect rewrites these files after commit.' : 'A page file still carries the claim: the mirror effect has not run yet, the source has no managed checkout, or the text is prose outside the fence.' } : {}) },
    { store: 'fence_tmp_evidence', status: tmpLeft.length ? (dryRun ? 'would_remove' : 'incomplete') : tmp.length ? 'deleted' : 'not_present', ...(tmp.length ? { removed: dryRun ? 0 : tmp.length - tmpLeft.length } : {}) },
    { store: 'facts_write_failures_log', status: log ? 'out_of_reach' : 'not_present', ...(log ? { detail: '~/.gbrain/facts.write_failures.jsonl mentions the claim; edit it by hand if needed.' } : {}) },
  ];
}

/** Same-model nearest neighbours of the purged fact's embedding: paraphrase candidates, never a gate. */
async function vectorProbe(engine: BrainEngine, target: PurgeTarget): Promise<Record<string, unknown>> {
  if (!target.embedding || !target.embedding_model) return { status: 'skipped', reason: 'no_embedding', gate: false };
  try {
    const rows = await engine.executeRaw<{ id: number; similarity: number; contains_claim: boolean }>(`SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity,
        strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
      FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::halfvec LIMIT 5`, [target.embedding, target.source_id, target.embedding_model, target.fact]);
    return { status: 'checked', gate: false, model: target.embedding_model,
      candidates: rows.map(r => ({ fact_id: Number(r.id), similarity: Math.round(Number(r.similarity) * 1000) / 1000, contains_claim: r.contains_claim === true })),
      note: 'Nearest same-model facts are possible rewordings for the user to review; a neighbour always exists, so this is not a residual count.' };
  } catch {
    return { status: 'skipped', reason: 'model_or_dimension_mismatch', gate: false };
  }
}

/** Build the receipt: swept-store verification (or would-remove counts on a dry run), probes, residuals first. */
export async function verifyFactPurge(engine: BrainEngine, input: { target: PurgeTarget; plan: PurgePlan; dryRun: boolean; removed?: StoreCount;
  prose?: Array<{ slug: string; version_id: number }>; vacuum?: boolean; ledger?: LedgerPurgeReport | null; sweepVerified?: boolean }): Promise<PurgeReceipt> {
  const { target, plan, dryRun } = input;
  const deadline = performance.now() + probeLimits.totalMs;
  const claim = target.fact, needle = claim.toLowerCase(), src = target.source_id;
  const removed = input.removed ?? {};
  const stores: StoreReport[] = [];
  const swept = async (store: string, sql: string, params: unknown[], planned: number, removedCount: number | undefined, onRemaining: Omit<StoreReport, 'store'> = { status: 'incomplete' }) => {
    if (dryRun) { stores.push({ store, status: planned ? 'would_remove' : 'not_present', removed: planned }); return; }
    const result = await boundedCount(engine, sql, params, deadline);
    if ('unverified' in result) stores.push({ store, status: 'unverified', reason: result.unverified, removed: removedCount ?? 0 });
    else if (result.count) stores.push({ store, removed: removedCount ?? 0, remaining: result.count, ...onRemaining });
    else stores.push({ store, status: removedCount ? 'deleted' : 'not_present', removed: removedCount ?? 0 });
  };
  await swept('facts', `SELECT 1 FROM facts WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=$3 AND ($4='*' OR entity_slug=$4)`,
    [src, target.visibility, target.fact_hash, plan.subject], plan.factIds.length, removed.facts);
  await swept('takes', `SELECT 1 FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND gbrain_fact_fingerprint(k.claim)=$2 AND ($3='*' OR p.slug=$3)`,
    [src, target.fact_hash, plan.subject], plan.takes.length, removed.takes);
  const prose = { status: 'out_of_scope' as const, reason: 'source_prose', detail: 'The claim text survives outside a facts fence (page prose, title or frontmatter); purge the page or edit it to remove it.' };
  await swept('pages', `SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL AND ${carriesClaimSql('p', 2)}`,
    [src, ...claimNeedles(claim)], plan.pages.length, removed.pages, prose);
  stores[stores.length - 1] = await withSegmentedProse(engine, stores[stores.length - 1]!, src, [claim], deadline);
  await swept('content_chunks', `SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND strpos(lower(c.chunk_text),$2)>0`,
    [src, needle], plan.pages.length, removed.chunks, prose);
  await swept('page_versions', `SELECT 1 FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND ${carriesClaimSql('v', 2)}`,
    [src, ...claimNeedles(claim)], plan.versions, removed.page_versions, { ...prose, items: (input.prose ?? []).slice(0, 20) });
  stores[stores.length - 1] = await withSegmentedProse(engine, stores[stores.length - 1]!, src, [claim], deadline);
  await swept('persistence_requests', `SELECT 1 FROM persistence_requests WHERE source_id=$1 AND (${['intent', 'outcome', 'error_detail', 'error_message']
      .map(c => `strpos(lower(COALESCE(${c}::text,'')),$2)>0 OR strpos(lower(COALESCE(${c}::text,'')),$3)>0`).join(' OR ')})`,
    [src, needle, JSON.stringify(claim).slice(1, -1).toLowerCase()], plan.requests.length, removed.persistence_requests);
  if (!dryRun && !await relationExists(engine, 'query_cache')) stores.push(missingCache('query_cache'));
  else await swept('query_cache', 'SELECT 1 FROM query_cache WHERE $1::text IS NOT NULL', [src], 0, removed.query_cache);
  const refs = plan.factIds.map(String);
  for (const table of ['decide_review_queue', 'decide_review_proposals'] as const) {
    await swept(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))`, [src, refs], plan.review[table], plan.review[table]);
  }
  await swept('decide_proposals', 'SELECT 1 FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[]))',
    [src, plan.factIds], plan.review.decide_proposals, plan.review.decide_proposals);
  await swept('take_proposals', 'SELECT 1 FROM take_proposals WHERE source_id=$1 AND gbrain_fact_fingerprint(claim_text)=$2', [src, target.fact_hash], 0, removed.take_proposals);
  await swept('core_edit_notices', 'SELECT 1 FROM core_edit_notices WHERE source_id=$1 AND strpos(lower(base_text),$2)>0', [src, needle], 0, removed.core_edit_notices);
  stores.push({ store: 'derived_artifacts', status: plan.derived.truncated ? 'unverified' : plan.derived.rows.length ? (dryRun ? 'would_remove' : 'retained_inactive') : 'not_present',
    removed: plan.derived.rows.length, ...(plan.derived.truncated ? { reason: 'derivation_walk_bound' } : {}),
    ...(plan.derived.rows.length ? { detail: 'Model-derived rows built from this fact are hidden and marked needs_rederive; they are not counted as removed text.' } : {}) });
  const [legacy] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')
    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)`, [src]);
  if (Number(legacy?.n ?? 0)) stores.push({ store: 'derived_legacy', status: 'unverified', reason: 'legacy_no_derivation_edges', remaining: Number(legacy.n),
    detail: `${legacy.n} model-derived page(s) in this source predate derivation edges, so purge cannot tell whether they restate the claim in other words.` });
  if (!dryRun) {
    stores.push(await segmentTextReport(engine, src, [...new Set([claim, escapeFenceCell(claim)])], removed.page_segment_texts ?? 0, deadline));
    stores.push(await derivationTextReport(engine, src, plan.pages.map(page => page.page_id), [claim, escapeFenceCell(claim)], removed.page_segment_derivations ?? 0, deadline,
      input.sweepVerified === true));
    stores.push(...await ledgerReports(engine, src, [claim], input.ledger, deadline));
    stores.push(await effectPayloadReport(engine, src, [claim], deadline, removed.persistence_effects ?? 0));
  }
  stores.push(...await sweptInventoryReports(engine, new Set(stores.map(s => s.store)), src, [claim], removed, deadline, dryRun));
  for (const entry of DELETION_INVENTORY) {
    if (entry.class !== 'out_of_scope' || entry.reason !== 'probed_reported') continue;
    stores.push(await probeInventoryStore(engine, entry, src, [claim], deadline));
  }
  const [other] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND gbrain_fact_fingerprint(fact)=$2
    AND NOT (visibility=$3 AND ($4='*' OR entity_slug=$4))`, [src, target.fact_hash, target.visibility, plan.subject]);
  const files = await pageFilePaths(engine, src, plan.pages.map(page => page.page_id));
  stores.push(...onDiskReports(files.files, claim, dryRun));
  let vacuumed: string | null = null;
  if (input.vacuum && !dryRun && engine.kind === 'pglite') {
    const tables = ['facts', 'takes', 'pages', 'content_chunks', 'page_versions', 'persistence_requests', ...(await relationExists(engine, 'query_cache') ? ['query_cache'] : [])];
    vacuumed = await engine.executeRaw(`VACUUM ${tables.join(', ')}`).then(() => 'ran', (error: unknown) => `failed (${(error as Error).message})`);
  }
  const residuals: StoreReport[] = [];
  if (files.root && files.paths.length) residuals.push(await gitResidualCommits(files.root, files.paths, claim));
  for (const r of OUT_OF_REACH_RESIDUALS) {
    if (r.store === 'git_history' && residuals.length) continue;
    const detail = r.store === 'database_physical' ? `${r.detail}${engine.kind === 'pglite' ? (vacuumed === 'ran' ? ' VACUUM ran on the touched tables; filesystem blocks and snapshots may still hold old pages.' : vacuumed ? ` VACUUM of the touched tables ${vacuumed}; rerun with --vacuum.` : ' PGLite has no autovacuum; rerun with --vacuum to compact the touched tables.') : ' On Postgres the operator runs VACUUM; WAL archives, replicas and PITR windows are outside gbrain.'}` : r.detail;
    residuals.push({ store: r.store, status: 'out_of_reach', detail });
  }
  if (Number(other?.n ?? 0)) residuals.push({ store: 'facts_other_scope', status: 'out_of_scope', reason: plan.subject === '*' ? 'other_visibility' : 'other_subject', remaining: Number(other.n),
    detail: `${other.n} fact row(s) state the same claim about another entity or at another visibility; rerun with --all-subjects to purge every entity's copy.` });
  residuals.push(...stores.filter(s => s.reason === 'source_prose' || s.reason === 'probed_reported' || s.store === 'canonical_markdown' && s.status === 'out_of_scope'));
  const next = dryRun
    ? ['Review the residuals with the user, then confirm with the token printed above (gbrain forget <id> --purge asks for it on a terminal).']
    : ['Poll completion with gbrain forget --purge --status --request-id <request_id> until it reports complete.'];
  return {
    summary: dryRun ? 'Dry run: nothing was removed. Counts are what the purge would remove from live stores.'
      : 'Removed from live stores. Residuals below are copies purge cannot reach; this is not physical erasure.',
    fact_id: target.id, fact_hash: target.fact_hash, hash8: target.fact_hash.slice(0, 8), source_id: src, subject: plan.subject, visibility: target.visibility,
    residuals, stores, vector_probe: await vectorProbe(engine, target), next,
    ...(engine.kind === 'postgres' && !dryRun ? { tell_user_to_run: { argv: ['psql', '-c', 'VACUUM (VERBOSE) facts, takes, pages, content_chunks, page_versions, persistence_requests'],
      why: 'Deleted rows stay in Postgres table pages and WAL until VACUUM and WAL recycling; the operator runs it (gbrain does not on Postgres).' } } : {}),
  };
}

/** In-process context a page purge keeps for its receipt (never journaled): the page's claims as probe needles, and row ids. */
export interface PagePurgeContext { needles: string[]; factIds: number[]; pageId: number; paths: string[]; segmentShas: string[]; segmentClaims?: string[]; ledgerClaims?: string[]; ledger?: LedgerPurgeReport | null }

const outOfReach = (engine: BrainEngine): StoreReport[] => OUT_OF_REACH_RESIDUALS.map(r => ({ store: r.store, status: 'out_of_reach' as const,
  detail: r.store === 'database_physical' ? `${r.detail}${engine.kind === 'pglite' ? ' PGLite has no autovacuum.' : ' On Postgres the operator runs VACUUM; WAL archives, replicas and PITR windows are outside gbrain.'}` : r.detail }));

/**
 * CEO-4 / C4: the page purge receipt, store by store like the fact receipt. Page-keyed stores are checked by
 * slug and page id; every other swept inventory store and every probed store is searched for the page's claims;
 * other pages whose prose still carries one are listed as `source_prose`; residuals come first.
 */
export async function verifyPagePurge(engine: BrainEngine, input: { sourceId: string; slug: string; requestId: string; removed: StoreCount;
  blobsRemaining: string[]; context: PagePurgeContext | null }): Promise<Record<string, unknown>> {
  const { sourceId: src, slug, removed, context } = input;
  const deadline = performance.now() + probeLimits.totalMs;
  const needles = context?.needles ?? [];
  const stores: StoreReport[] = [];
  const keyed = async (store: string, sql: string, params: unknown[]) => {
    const result = await boundedCount(engine, sql, params, deadline);
    const n = removed[store] ?? 0;
    if ('unverified' in result) stores.push({ store, status: 'unverified', reason: result.unverified, removed: n });
    else if (result.count) stores.push({ store, status: 'incomplete', remaining: result.count, removed: n });
    else stores.push({ store, status: n ? 'deleted' : 'not_present', removed: n });
  };
  await keyed('pages', 'SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [src, slug]);
  if (context) for (const table of ['content_chunks', 'page_versions', 'takes', 'timeline_entries']) await keyed(table, `SELECT 1 FROM ${table} WHERE page_id=$1`, [context.pageId]);
  await keyed('facts', 'SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [src, slug]);
  for (const table of ['take_proposals', 'open_loops']) await keyed(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND page_slug=$2`, [src, slug]);
  await keyed('core_edit_notices', 'SELECT 1 FROM core_edit_notices WHERE source_id=$1 AND slug=$2', [src, slug]);
  await keyed('page_aliases', 'SELECT 1 FROM page_aliases WHERE source_id=$1 AND slug=$2', [src, slug]);
  await keyed('slug_aliases', 'SELECT 1 FROM slug_aliases WHERE source_id=$1 AND canonical_slug=$2', [src, slug]);
  await keyed('files', 'SELECT 1 FROM files WHERE page_slug=$2 AND (source_id=$1 OR source_id IS NULL)', [src, slug]);
  await keyed('write_gate_holds', 'SELECT 1 FROM write_gate_holds WHERE source_id=$1 AND slug=$2', [src, slug]);
  if (!await relationExists(engine, 'query_cache')) stores.push(missingCache('query_cache'));
  else await keyed('query_cache', 'SELECT 1 FROM query_cache WHERE $1::text IS NOT NULL', [src]);
  // The page's own segment texts, and unreferenced texts holding one of its claims (plain or as a fence cell stores it),
  // only: a text of another page holding the same words is that page's body, never a residue of this purge (an inline
  // page with no claims referenced none, so the inventory sweep below must not probe the table).
  const claimForms = context ? claimTextForms(context.segmentClaims ?? context.needles) : [];
  if (context && !context.segmentShas.length && !claimForms.length) stores.push({ store: 'page_segment_texts', status: 'not_present', removed: removed.page_segment_texts ?? 0 });
  if (context && (context.segmentShas.length || claimForms.length)) {
    const n = removed.page_segment_texts ?? 0;
    let remaining = 0, unverified: string | undefined;
    for (let at = 0; at === 0 || at < claimForms.length; at += CLAIM_FORMS_BATCH) {
      const result = await boundedCount(engine, `SELECT 1 FROM page_segment_texts t WHERE t.source_id=$1
        AND (t.sha256=ANY(SELECT decode(h,'hex') FROM unnest($2::text[]) AS h) OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS n WHERE strpos(lower(convert_from(t.body,'UTF8')),n)>0))
        AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) AND NOT ${stagingNeedsTextSql('t')}`,
      [src, at === 0 ? context.segmentShas : [], claimForms.slice(at, at + CLAIM_FORMS_BATCH)], deadline);
      if ('unverified' in result) { unverified = result.unverified; break; }
      remaining += result.count;
    }
    if (unverified) stores.push({ store: 'page_segment_texts', status: 'unverified', reason: unverified, removed: n });
    else if (remaining) stores.push({ store: 'page_segment_texts', status: 'incomplete', remaining, removed: n });
    else stores.push({ store: 'page_segment_texts', status: n ? 'deleted' : 'not_present', removed: n });
  }
  if (context) {
    const refs = context.factIds.map(String);
    for (const table of ['decide_review_queue', 'decide_review_proposals']) await keyed(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))`, [src, refs]);
    await keyed('decide_proposals', 'SELECT 1 FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[]))', [src, context.factIds]);
    await keyed('trust_proposals', `SELECT 1 FROM trust_proposals WHERE source_id=$1 AND ((target_table='pages' AND target_id=$2) OR (related_table='pages' AND related_id=$2)
      OR (target_table='facts' AND target_id=ANY($3::bigint[])) OR (related_table='facts' AND related_id=ANY($3::bigint[])))`, [src, context.pageId, context.factIds]);
  }
  const textChecks = needles.flatMap((n, i) => ['intent', 'outcome', 'error_detail', 'error_message'].map(c => `strpos(lower(COALESCE(${c}::text,'')),$${4 + i})>0`));
  await keyed('persistence_requests', `SELECT 1 FROM persistence_requests WHERE source_id=$1 AND request_id<>$3::uuid AND (
      (slug=$2 AND intent IS NOT NULL AND state IN ('committed','conflict','failed','cancelled'))${textChecks.length ? ` OR ${textChecks.join(' OR ')}` : ''})`,
  [src, slug, input.requestId, ...needles.map(n => n.toLowerCase())]);
  if (context) {
    stores.push(...await ledgerReports(engine, src, context.ledgerClaims ?? needles, context.ledger, deadline));
    stores.push(await effectPayloadReport(engine, src, needles, deadline, removed.persistence_effects ?? 0));
  }
  stores.push(...await sweptInventoryReports(engine, new Set(stores.map(s => s.store)), src, needles, removed, deadline, false));
  for (const entry of DELETION_INVENTORY) {
    if (entry.class === 'out_of_scope' && entry.reason === 'probed_reported') stores.push(await probeInventoryStore(engine, entry, src, needles, deadline));
  }
  if (!context) stores.push({ store: 'source_prose', status: 'unverified', reason: 'prose_probe_unavailable',
    detail: 'The receipt was built by another process than the purge, so other pages were not searched for the purged page\'s claims.' });
  else if (needles.length) {
    // Page-text stores are judged source-wide as in the fact receipt: the purged page's rows are gone, so any claim
    // text left there is another page's prose (`out_of_scope: source_prose`, naming those pages).
    const lowered = needles.map(n => n.toLowerCase());
    const proseIn: Record<string, string> = {
      pages: `SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0)`,
      content_chunks: `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0)`,
      page_versions: `SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0)`,
      timeline_entries: `SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0)`,
    };
    const all = new Set<string>();
    let unverified: string | null = null;
    for (const [store, sql] of Object.entries(proseIn)) {
      const slugs = (await engine.executeRaw<{ slug: string }>(`${sql} ORDER BY 1 LIMIT 20`, [src, lowered])).map(r => r.slug);
      if (store === 'pages' || store === 'page_versions') {
        const scan = await segmentedProse(engine, src, needles, deadline, store);
        if ('unverified' in scan) unverified = scan.unverified;
        else slugs.push(...new Set(scan.hits.map(hit => hit.slug)));
      }
      if (!slugs.length) continue;
      slugs.forEach(s => all.add(s));
      const at = stores.findIndex(s => s.store === store);
      const report: StoreReport = { store, status: 'out_of_scope', reason: 'source_prose', removed: removed[store] ?? 0, remaining: slugs.length, items: slugs,
        detail: 'The purged page\'s rows are gone; other pages still state one of its claims in their prose. Edit or purge them.' };
      if (at >= 0 && stores[at]!.status !== 'incomplete') stores[at] = report; else if (at < 0) stores.push(report);
    }
    stores.push(all.size ? { store: 'source_prose', status: 'out_of_scope', reason: 'source_prose', remaining: all.size, items: [...all].sort(),
      detail: 'Other pages still state a claim from the purged page in their prose; edit or purge them.' }
      : unverified ? { store: 'source_prose', status: 'unverified', reason: unverified } : { store: 'source_prose', status: 'not_present' });
  }
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [src]);
  const files = source?.local_path ? (context?.paths ?? []).filter(p => !p.startsWith('/') && !p.includes('..')).map(p => join(source.local_path!, p)) : [];
  const present = files.filter(f => existsSync(f)), tmp = files.map(f => `${f}.tmp`).filter(f => existsSync(f));
  for (const path of tmp) { try { unlinkSync(path); } catch { /* reported below */ } }
  stores.push({ store: 'canonical_markdown', status: !files.length ? 'not_present' : present.length ? 'incomplete' : 'deleted', ...(present.length ? { remaining: present.length } : {}) },
    { store: 'fence_tmp_evidence', status: tmp.some(existsSync) ? 'incomplete' : tmp.length ? 'deleted' : 'not_present' },
    { store: 'file_blobs', status: input.blobsRemaining.length ? 'incomplete' : (removed.files ? 'deleted' : 'not_present'), ...(input.blobsRemaining.length ? { items: input.blobsRemaining } : {}) });
  const [tombstones] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_purges WHERE source_id=$1 AND slug=$2', [src, slug]);
  const residuals: StoreReport[] = [];
  if (source?.local_path && context?.paths.length && needles.length) residuals.push(await gitResidualCommits(source.local_path, context.paths, needles[0]!));
  residuals.push(...outOfReach(engine).filter(r => !(r.store === 'git_history' && residuals.length)));
  residuals.push(...stores.filter(s => s.reason === 'source_prose' || s.reason === 'probed_reported'));
  const [row] = await engine.executeRaw<Pick<WriteRequest, 'id' | 'request_id' | 'state' | 'source_id' | 'outcome'>>(`SELECT id,request_id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC LIMIT 1`, [src, input.requestId]);
  return { summary: 'Removed from live stores. Residuals below are copies purge cannot reach; this is not physical erasure.',
    residuals, stores, page_tombstones: Number(tombstones?.n ?? 0),
    ...(row ? await purgeCompletion(engine, row, { stores }) : {}),
    next: ['Other pages listed under source_prose still state the purged claims; edit or purge them. gbrain pages purges list shows the tombstones.'],
    ...(engine.kind === 'postgres' ? { tell_user_to_run: { argv: ['psql', '-c', 'VACUUM (VERBOSE) pages, content_chunks, page_versions, facts, takes, persistence_requests'],
      why: 'Deleted rows stay in Postgres table pages and WAL until VACUUM and WAL recycling; the operator runs it (gbrain does not on Postgres).' } } : {}) };
}

/**
 * DX-12: `committed` once the transaction committed and effects are pending,
 * `complete` once every effect committed and no swept store reported a
 * residual, `incomplete` when an effect failed or parked or a swept store
 * still holds the claim. Out-of-reach residuals never make it incomplete.
 */
export async function purgeCompletion(engine: BrainEngine, row: Pick<WriteRequest, 'id' | 'request_id' | 'state' | 'source_id' | 'outcome'>, receipt?: Pick<PurgeReceipt, 'stores'>):
  Promise<{ completion: PurgeCompletion; effects: Array<{ kind: string; state: string; error_code: string | null }>; exit_code: number; fingerprint_probe?: Record<string, number>;
    derivation_sweep?: DerivationSweepState; derivation_sweep_reason?: DerivationStallReason | DerivationPendingReason; next?: string[] }> {
  if (row.state !== 'committed') return { completion: 'incomplete', effects: [], exit_code: 75 };
  const effects = await engine.executeRaw<{ kind: string; state: string; error_code: string | null; parked: boolean }>(`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind`, [row.id]);
  const purge = (row.outcome as { purge?: { fact_hash?: string; subject?: string } } | null)?.purge;
  let fingerprint: Record<string, number> | undefined;
  if (purge?.fact_hash) {
    const [probe] = await engine.executeRaw<{ facts: number; takes: number }>(`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=$1 AND gbrain_fact_fingerprint(fact)=$2 AND ($3='*' OR entity_slug=$3)) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND gbrain_fact_fingerprint(k.claim)=$2 AND ($3='*' OR p.slug=$3)) AS takes`,
    [row.source_id, purge.fact_hash, purge.subject ?? '*']);
    fingerprint = { facts: Number(probe?.facts ?? 0), takes: Number(probe?.takes ?? 0) };
  }
  const failed = effects.some(e => e.state === 'failed' || e.parked);
  const sweep = await derivationPurgeState(engine, row.id);
  const sweptResidual = sweep || receipt?.stores.some(s => s.status === 'incomplete') || (fingerprint && (fingerprint.facts || fingerprint.takes));
  const pending = effects.some(e => e.state !== 'committed');
  const completion: PurgeCompletion = failed || sweptResidual ? 'incomplete' : pending ? 'committed' : 'complete';
  return { completion, effects: effects.map(({ kind, state, error_code }) => ({ kind, state, error_code })),
    exit_code: completion === 'complete' ? 0 : completion === 'committed' ? 10 : 75, ...(fingerprint ? { fingerprint_probe: fingerprint } : {}),
    ...(sweep ? { derivation_sweep: sweep.state, ...(sweep.reason ? { derivation_sweep_reason: sweep.reason } : {}), next: [sweep.reason === 'scope_lock_busy'
      ? `The sweep of stored derivation results has walked to its end, but a write in the source that brings stored results into its scope (an import, sync or page edit) is still open and held the source's scope lock past the sweep's wait (derivation_sweep: pending, scope_lock_busy). Let that write finish, then continue the sweep with gbrain forget --purge --status --request-id ${row.request_id} --continue.`
      : sweep.state === 'pending'
      ? `Stored derivation results are still being swept for the claim (derivation_sweep: pending). Continue the sweep with gbrain forget --purge --status --request-id ${row.request_id} --continue until completion is complete.`
      : sweep.reason === 'paid_row_unreadable'
        ? `The sweep of stored derivation results stopped on a paid result (synopsis or conversation facts) it could not read within its statement budget (derivation_sweep: stalled, paid_row_unreadable); paid results are never deleted unread, and other sweeps go on. Retry it with gbrain forget --purge --status --request-id ${row.request_id} --continue; if it stalls again, report it with the output of gbrain doctor --json.`
        : `The sweep of stored derivation results stopped on a result it could not read or delete within its statement budget (derivation_sweep: stalled); other sweeps go on. Retry it with gbrain forget --purge --status --request-id ${row.request_id} --continue; if it stalls again, report it with the output of gbrain doctor --json.`] } : {}) };
}
