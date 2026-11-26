/**
 * Trust: the write gate's verdict receipts (`write_gate_receipts`) and its holding table for quarantined facts and
 * takes (`write_gate_holds`), DDL in write-gate-schema.ts. Each function runs the statement its caller
 * (write-gate-store.ts, eligibility/explain.ts, trust/review.ts) ran through `executeRaw`, with the same
 * statements and parameters (composed with sqlFragment); only its home moved. Statements that also read facts, takes or the
 * purge ledgers stay with their callers.
 */
import type { SqlExecutor } from './executor.ts';
import { joinFragments, sqlFragment, type SqlFragment } from './fragment.ts';
import type { LegacyUnscopedRead } from './brands.ts';

/** The verdict fields of a receipt (only flag and quarantine verdicts are recorded). */
export interface WriteGateReceiptFields {
  content_hash: string;
  tier: string;
  detector_version: number;
  verdict: 'flag' | 'quarantine';
  reason_families: readonly string[];
  reasons: readonly string[];
  detector_error: boolean;
  request_id: string | null;
}

/** A receipt on a persisted row. */
export interface WriteGateReceiptInput extends WriteGateReceiptFields {
  target_table: 'pages' | 'facts' | 'takes' | 'timeline_entries' | 'write_gate_holds';
  target_id: string;
  source_id: string | null;
}

/** A receipt as the owner's explain and review surfaces read it. */
export interface WriteGateReceiptRow {
  id: number;
  verdict: string;
  reason_families: string[];
  detector_version: number;
  tier: string;
  created_at: Date;
  last_seen_at: Date;
}

/** A held fact or take, as the writer would have inserted it. */
export interface WriteGateHoldRowInput {
  kind: 'fact' | 'take';
  source_id: string;
  slug: string;
  fingerprint: string;
  detector_version: number;
  tier: string;
  reason_families: readonly string[];
  reasons: readonly string[];
  detector_error: boolean;
  payload: Record<string, unknown>;
  write_origin: Record<string, unknown> | null;
  request_id: string | null;
  /** The page's permanent id when the producer read it before gating; else the page at (source, slug) is looked up in the INSERT. */
  page_id?: number | null;
}

/** A hold row. */
export interface WriteGateHoldRow {
  id: number;
  kind: 'fact' | 'take';
  source_id: string;
  slug: string;
  /** The page's permanent id; null for a hold no page was tied to (it matches by slug, or by `page_candidates`). */
  page_id: number | null;
  /** Pages an upgrade could not choose between; null for every hold a writer recorded. */
  page_candidates: number[] | null;
  tier: string;
  detector_version: number;
  detector_error: boolean;
  reason_families: string[];
  reasons: string[];
  payload: Record<string, unknown>;
  write_origin: Record<string, unknown> | null;
  request_id: string | null;
  status: 'held' | 'released' | 'dropped';
  seen_count: number;
  created_at: Date;
  last_seen_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

/** Hold listing filters; newest first. */
export interface WriteGateHoldListOpts {
  /** `held`, `released`, `dropped` or `all`. */
  status: 'held' | 'released' | 'dropped' | 'all';
  kind?: 'fact' | 'take';
  /** When non-empty, wins over `sourceId`. */
  sourceIds?: readonly string[];
  sourceId?: string;
  /** Keyset: only holds with id below this. */
  beforeId?: number;
  /** 1..1000 (callers clamp). */
  limit: number;
}

const RECEIPT_COLUMNS = sqlFragment`target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families, reasons, detector_error, request_id`;
const RECEIPT_UPSERT = sqlFragment`ON CONFLICT (target_table, target_id, content_hash, detector_version) DO UPDATE
  SET last_seen_at = now(), verdict = EXCLUDED.verdict, tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families,
      reasons = EXCLUDED.reasons, detector_error = EXCLUDED.detector_error, request_id = COALESCE(EXCLUDED.request_id, write_gate_receipts.request_id)
  RETURNING id::text AS id`;

function receiptValues(r: WriteGateReceiptFields): SqlFragment {
  return sqlFragment`${r.content_hash}, ${r.tier}, ${r.detector_version}, ${r.verdict}, ${[...r.reason_families]}::text[], ${[...r.reasons]}::text[], ${r.detector_error}, ${r.request_id}`;
}

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

function jsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

export async function upsertWriteGateReceipt(exec: SqlExecutor, input: WriteGateReceiptInput): Promise<number> {
  const { rows } = await exec.run<{ id: string }>(sqlFragment`INSERT INTO write_gate_receipts (${RECEIPT_COLUMNS})
     VALUES (${input.target_table}, ${input.target_id}, ${input.source_id}, ${receiptValues(input)}) ${RECEIPT_UPSERT}`);
  return Number(rows[0]!.id);
}

export async function listWriteGateReceiptsFor(exec: LegacyUnscopedRead, targetTable: string, targetId: string, limit: number): Promise<WriteGateReceiptRow[]> {
  const rows = await exec.executeRaw<Record<string, unknown>>(
    `SELECT id::text AS id, verdict, reason_families, detector_version, tier, created_at, last_seen_at
       FROM write_gate_receipts WHERE target_table = $1 AND target_id = $2 ORDER BY last_seen_at DESC, id DESC LIMIT $3`,
    [targetTable, targetId, limit]);
  return rows.map(r => ({
    id: Number(r.id), verdict: String(r.verdict), reason_families: (r.reason_families as string[] | null) ?? [],
    detector_version: Number(r.detector_version), tier: String(r.tier), created_at: asDate(r.created_at), last_seen_at: asDate(r.last_seen_at),
  }));
}

// The three statements of write-gate-store.ts `recordWriteGateHold`, as the same text master's #10200 sends (each is one literal: $1..$12 are the hold's own
// values, the last column is the page id or NULL; a reopened hold takes the slug with the payload; the two dedupe keys are disjoint, write-gate-schema.ts).
const HOLD_BOUND_BY_ID = `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload, write_origin, request_id, page_id) SELECT $1::text, $2::text, $3::text, $4::text, $5::integer, $6::text, $7::text[], $8::text[], $9::boolean, $10::text::jsonb, $11::text::jsonb, $12::text, p.id FROM pages p WHERE p.id = $13::bigint AND p.source_id = $2 ON CONFLICT (source_id, page_id, fingerprint, detector_version) WHERE page_id IS NOT NULL DO UPDATE
       SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = write_gate_holds.seen_count + 1,
           slug = EXCLUDED.slug, tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families, reasons = EXCLUDED.reasons, payload = EXCLUDED.payload,
           write_origin = EXCLUDED.write_origin, request_id = COALESCE(EXCLUDED.request_id, write_gate_holds.request_id)
     RETURNING id::text AS id`;
const HOLD_BOUND_BY_SLUG = `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload, write_origin, request_id, page_id) SELECT $1::text, $2::text, $3::text, $4::text, $5::integer, $6::text, $7::text[], $8::text[], $9::boolean, $10::text::jsonb, $11::text::jsonb, $12::text, p.id FROM pages p WHERE p.source_id = $2 AND p.slug = $3 ON CONFLICT (source_id, page_id, fingerprint, detector_version) WHERE page_id IS NOT NULL DO UPDATE
       SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = write_gate_holds.seen_count + 1,
           slug = EXCLUDED.slug, tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families, reasons = EXCLUDED.reasons, payload = EXCLUDED.payload,
           write_origin = EXCLUDED.write_origin, request_id = COALESCE(EXCLUDED.request_id, write_gate_holds.request_id)
     RETURNING id::text AS id`;
const HOLD_UNBOUND = `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload, write_origin, request_id, page_id) VALUES ($1::text, $2::text, $3::text, $4::text, $5::integer, $6::text, $7::text[], $8::text[], $9::boolean, $10::text::jsonb, $11::text::jsonb, $12::text, NULL) ON CONFLICT (source_id, slug, fingerprint, detector_version) WHERE page_id IS NULL AND page_candidates IS NULL DO UPDATE
       SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = write_gate_holds.seen_count + 1,
           slug = EXCLUDED.slug, tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families, reasons = EXCLUDED.reasons, payload = EXCLUDED.payload,
           write_origin = EXCLUDED.write_origin, request_id = COALESCE(EXCLUDED.request_id, write_gate_holds.request_id)
     RETURNING id::text AS id`;

/** The statements of write-gate-store.ts `recordWriteGateHold`, in the same order: bound by the given page id, bound by the page at (source, slug), else unbound. */
export async function upsertWriteGateHold(exec: SqlExecutor, input: WriteGateHoldRowInput): Promise<number> {
  const values = [input.kind, input.source_id, input.slug, input.fingerprint, input.detector_version, input.tier, [...input.reason_families], [...input.reasons],
    input.detector_error, JSON.stringify(input.payload), input.write_origin ? JSON.stringify(input.write_origin) : null, input.request_id];
  let rows: Array<{ id: string }> = [];
  if (input.page_id != null) rows = await exec.executeRaw<{ id: string }>(HOLD_BOUND_BY_ID, [...values, input.page_id]);
  if (!rows.length && input.slug !== '') rows = await exec.executeRaw<{ id: string }>(HOLD_BOUND_BY_SLUG, values);
  if (!rows.length) rows = await exec.executeRaw<{ id: string }>(HOLD_UNBOUND, values);
  return Number(rows[0]!.id);
}

const HOLD_SELECT = sqlFragment`SELECT id::text AS id, kind, source_id, slug, page_id::text AS page_id, page_candidates::text[] AS page_candidates, tier, detector_version, detector_error, reason_families, reasons, payload, write_origin,
  request_id, status, seen_count, created_at, last_seen_at, decided_at, decided_by
  FROM write_gate_holds`;

function toHoldRow(r: Record<string, unknown>): WriteGateHoldRow {
  return {
    id: Number(r.id), kind: r.kind as WriteGateHoldRow['kind'], source_id: String(r.source_id), slug: String(r.slug),
    page_id: r.page_id == null ? null : Number(r.page_id), page_candidates: (r.page_candidates as string[] | null)?.map(Number) ?? null, tier: String(r.tier),
    detector_version: Number(r.detector_version), detector_error: Boolean(r.detector_error),
    reason_families: (r.reason_families as string[] | null) ?? [], reasons: (r.reasons as string[] | null) ?? [],
    payload: jsonObject(r.payload) ?? {}, write_origin: jsonObject(r.write_origin), request_id: (r.request_id as string | null) ?? null,
    status: r.status as WriteGateHoldRow['status'], seen_count: Number(r.seen_count),
    created_at: asDate(r.created_at), last_seen_at: asDate(r.last_seen_at), decided_at: r.decided_at == null ? null : asDate(r.decided_at),
    decided_by: (r.decided_by as string | null) ?? null,
  };
}

export async function listWriteGateHoldRows(exec: LegacyUnscopedRead, opts: WriteGateHoldListOpts): Promise<WriteGateHoldRow[]> {
  const where: SqlFragment[] = [];
  if (opts.status !== 'all') where.push(sqlFragment`status = ${opts.status}`);
  if (opts.kind) where.push(sqlFragment`kind = ${opts.kind}`);
  if (opts.sourceIds?.length) where.push(sqlFragment`source_id = ANY(${[...opts.sourceIds]}::text[])`);
  else if (opts.sourceId) where.push(sqlFragment`source_id = ${opts.sourceId}`);
  if (opts.beforeId !== undefined) where.push(sqlFragment`id < ${opts.beforeId}`);
  const filter = where.length ? sqlFragment`WHERE ${joinFragments(where, ' AND ')}` : sqlFragment``;
  const { rows } = await exec.run<Record<string, unknown>>(sqlFragment`${HOLD_SELECT} ${filter} ORDER BY id DESC LIMIT ${opts.limit}`);
  return rows.map(toHoldRow);
}

export async function getWriteGateHoldRow(exec: LegacyUnscopedRead, id: number): Promise<WriteGateHoldRow | null> {
  const { rows } = await exec.run<Record<string, unknown>>(sqlFragment`${HOLD_SELECT} WHERE id = ${id}`);
  return rows[0] ? toHoldRow(rows[0]) : null;
}

