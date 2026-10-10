/**
 * #5575 write gate persistence: verdict receipts (`write_gate_receipts`) and
 * the holding table for quarantined facts and takes (`write_gate_holds`),
 * DDL in `write-gate-schema.ts`.
 *
 * Writers record inside their publication transaction (pass the `tx`), so a
 * rolled-back write leaves no orphan receipt. Only flag and quarantine
 * verdicts are recorded; `allow` and `reject` write nothing here. Owner
 * review (`gbrain trust release|drop`, `gbrain quarantine list`) reads and
 * decides holds through the list/release/drop functions; releasing a hold
 * returns its payload so the confirm path can publish it at `user_confirmed`
 * in the same transaction.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import {
  assessFactForGate, assessTakeForGate, normalizeForGate,
  type GateFactRow, type GateTakeRow, type WriteGateAssessment, type WriteGateConfig, type WriteGateInput, type WriteGateOrigin, type WriteGateReasonFamily,
} from './write-gate.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export type WriteGateTargetTable = 'pages' | 'facts' | 'takes' | 'timeline_entries' | 'write_gate_holds';
export type WriteGateHoldKind = 'fact' | 'take';
export type WriteGateHoldStatus = 'held' | 'released' | 'dropped';

/** Receipts not seen again for this long are pruned. */
export const WRITE_GATE_RECEIPT_RETENTION_DAYS = 365;

const RECORDED: ReadonlySet<string> = new Set(['flag', 'quarantine']);
const recorded = (a: WriteGateAssessment): a is WriteGateAssessment & { contentHash: string } => RECORDED.has(a.verdict) && a.contentHash !== null;

function reasonList(a: WriteGateAssessment): string[] {
  return a.hits.map(h => `${h.field}:${h.pattern}`);
}

const RECEIPT_COLUMNS = 'target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families, reasons, detector_error, request_id';
const RECEIPT_UPSERT = `ON CONFLICT (target_table, target_id, content_hash, detector_version) DO UPDATE
  SET last_seen_at = now(), verdict = EXCLUDED.verdict, tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families,
      reasons = EXCLUDED.reasons, detector_error = EXCLUDED.detector_error, request_id = COALESCE(EXCLUDED.request_id, write_gate_receipts.request_id)
  RETURNING id::text AS id`;

function receiptParams(a: WriteGateAssessment, requestId: string | null | undefined): unknown[] {
  return [a.contentHash, a.tier, a.detectorVersion, a.verdict, a.families, reasonList(a), a.detectorError, requestId ?? null];
}

/** Record a flag or quarantine verdict on a persisted row; returns the receipt id (null for allow/reject). */
export async function recordWriteGateReceipt(tx: Exec, input: {
  targetTable: WriteGateTargetTable; targetId: string | number; sourceId?: string | null; assessment: WriteGateAssessment; requestId?: string | null;
}): Promise<number | null> {
  if (!recorded(input.assessment)) return null;
  const rows = await tx.executeRaw<{ id: string }>(
    `INSERT INTO write_gate_receipts (${RECEIPT_COLUMNS})
     VALUES ($9, $10, $11, $1, $2, $3, $4, $5::text[], $6::text[], $7, $8) ${RECEIPT_UPSERT}`,
    [...receiptParams(input.assessment, input.requestId), input.targetTable, String(input.targetId), input.sourceId ?? null]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** Record a page verdict, resolving the live page id by (source_id, slug) inside the caller's transaction. */
export async function recordPageGateReceipt(tx: Exec, input: {
  slug: string; sourceId: string; assessment: WriteGateAssessment; requestId?: string | null;
}): Promise<number | null> {
  if (!recorded(input.assessment)) return null;
  const rows = await tx.executeRaw<{ id: string }>(
    `INSERT INTO write_gate_receipts (${RECEIPT_COLUMNS})
     SELECT 'pages', p.id::text, p.source_id, $1, $2, $3, $4, $5::text[], $6::text[], $7, $8
       FROM pages p WHERE p.source_id = $9 AND p.slug = $10 AND p.deleted_at IS NULL
     ${RECEIPT_UPSERT}`,
    [...receiptParams(input.assessment, input.requestId), input.sourceId, input.slug]);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * ENG-11 (L1b contract): a page rewrite the gate assessed again replaces the
 * verdict of the content it replaced, so receipts on the page for any other
 * content hash are removed (an allowed benign rewrite stops being suppressed).
 */
export async function clearStalePageGateReceipts(tx: Exec, input: { slug: string; sourceId: string; contentHash: string | null }): Promise<void> {
  await tx.executeRaw(`DELETE FROM write_gate_receipts r USING pages p
    WHERE r.target_table = 'pages' AND r.target_id = p.id::text AND p.source_id = $1 AND p.slug = $2 AND r.content_hash IS DISTINCT FROM $3`,
  [input.sourceId, input.slug, input.contentHash]);
}

/** Dedupe key for a held row: its kind plus the normalized text of every gated field. */
export function holdFingerprint(kind: WriteGateHoldKind, texts: ReadonlyArray<string | null | undefined>): string {
  return createHash('sha256').update(`${kind}\u0000${texts.map(t => normalizeForGate(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).join('\u0001')}`).digest('hex');
}

export interface WriteGateHoldInput {
  kind: WriteGateHoldKind;
  sourceId: string;
  /** The page the row would have landed on ('' when not page-bound). */
  slug?: string | null;
  /** The row exactly as the writer would have inserted it. */
  payload: Record<string, unknown>;
  /** Gated text fields of the row, for the dedupe fingerprint. */
  texts: ReadonlyArray<string | null | undefined>;
  assessment: WriteGateAssessment;
  origin?: WriteGateOrigin | null;
  requestId?: string | null;
}

/**
 * Hold a quarantined fact or take instead of inserting it, plus its receipt.
 * The same content arriving again (same source, slug, fingerprint and
 * detector version) re-opens the existing hold rather than adding a row.
 */
export async function recordWriteGateHold(tx: Exec, input: WriteGateHoldInput): Promise<{ holdId: number; receiptId: number | null }> {
  const a = input.assessment;
  const rows = await tx.executeRaw<{ id: string }>(
    `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload, write_origin, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10::text::jsonb, $11::text::jsonb, $12)
     ON CONFLICT (source_id, slug, fingerprint, detector_version) DO UPDATE
       SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = write_gate_holds.seen_count + 1,
           tier = EXCLUDED.tier, reason_families = EXCLUDED.reason_families, reasons = EXCLUDED.reasons, payload = EXCLUDED.payload,
           write_origin = EXCLUDED.write_origin, request_id = COALESCE(EXCLUDED.request_id, write_gate_holds.request_id)
     RETURNING id::text AS id`,
    [input.kind, input.sourceId, input.slug ?? '', holdFingerprint(input.kind, input.texts), a.detectorVersion, a.tier, a.families, reasonList(a),
      a.detectorError, JSON.stringify(input.payload), input.origin ? JSON.stringify(input.origin) : null, input.requestId ?? null]);
  const holdId = Number(rows[0]!.id);
  const receiptId = await recordWriteGateReceipt(tx, { targetTable: 'write_gate_holds', targetId: holdId, sourceId: input.sourceId, assessment: { ...a, verdict: 'quarantine' }, requestId: input.requestId });
  return { holdId, receiptId };
}

export interface WriteGateHold {
  id: number;
  ref: string;
  kind: WriteGateHoldKind;
  source_id: string;
  slug: string;
  tier: string;
  detector_version: number;
  detector_error: boolean;
  reason_families: WriteGateReasonFamily[];
  reasons: string[];
  payload: Record<string, unknown>;
  write_origin: WriteGateOrigin | null;
  request_id: string | null;
  status: WriteGateHoldStatus;
  seen_count: number;
  created_at: string;
  last_seen_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const HOLD_SELECT = `SELECT id::text AS id, kind, source_id, slug, tier, detector_version, detector_error, reason_families, reasons, payload, write_origin,
  request_id, status, seen_count, ${ISO('created_at')} AS created_at, ${ISO('last_seen_at')} AS last_seen_at, ${ISO('decided_at')} AS decided_at, decided_by
  FROM write_gate_holds`;

type HoldRow = Omit<WriteGateHold, 'id' | 'ref' | 'payload' | 'write_origin'> & { id: string; payload: unknown; write_origin: unknown };

function jsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function toHold(row: HoldRow): WriteGateHold {
  const id = Number(row.id);
  return {
    ...row, id, ref: `h${id}`, detector_version: Number(row.detector_version), seen_count: Number(row.seen_count),
    payload: jsonObject(row.payload) ?? {}, write_origin: jsonObject(row.write_origin) as WriteGateOrigin | null,
  };
}

/** `h12` (or `12`) -> 12; null when the ref is not a hold ref. */
export function parseHoldRef(ref: string): number | null {
  const m = /^h?(\d{1,18})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

export interface ListWriteGateHoldsOpts {
  status?: WriteGateHoldStatus | 'all';
  kind?: WriteGateHoldKind;
  sourceId?: string;
  sourceIds?: string[];
  /** Keyset: only holds with id below this (newest first). */
  beforeId?: number;
  limit?: number;
}

/** Holds, newest first; default status `held`, limit 200. */
export async function listWriteGateHolds(engine: Exec, opts: ListWriteGateHoldsOpts = {}): Promise<WriteGateHold[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const status = opts.status ?? 'held';
  if (status !== 'all') where.push(`status = ${bind(status)}`);
  if (opts.kind) where.push(`kind = ${bind(opts.kind)}`);
  if (opts.sourceIds?.length) where.push(`source_id = ANY(${bind(opts.sourceIds)}::text[])`);
  else if (opts.sourceId) where.push(`source_id = ${bind(opts.sourceId)}`);
  if (opts.beforeId !== undefined) where.push(`id < ${bind(opts.beforeId)}`);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const rows = await engine.executeRaw<HoldRow>(
    `${HOLD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${bind(limit)}`, params);
  return rows.map(toHold);
}

export async function getWriteGateHold(engine: Exec, id: number): Promise<WriteGateHold | null> {
  const rows = await engine.executeRaw<HoldRow>(`${HOLD_SELECT} WHERE id = $1`, [id]);
  return rows[0] ? toHold(rows[0]) : null;
}

async function decideHold(tx: Exec, id: number, status: Exclude<WriteGateHoldStatus, 'held'>, decidedBy: string): Promise<WriteGateHold | null> {
  const rows = await tx.executeRaw<{ id: string }>(
    `UPDATE write_gate_holds SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1 AND status = 'held' RETURNING id::text AS id`,
    [id, status, decidedBy]);
  return rows[0] ? getWriteGateHold(tx, id) : null;
}

/**
 * Mark a held row released and return it (payload included) so the caller's
 * confirm path publishes it at `user_confirmed` in the same transaction. Null
 * when the hold does not exist or was already decided. Authorization (TTY
 * confirmation or `memory_confirm`, CEO-9) is the caller's job.
 */
export function releaseWriteGateHold(tx: Exec, id: number, decidedBy: string): Promise<WriteGateHold | null> {
  return decideHold(tx, id, 'released', decidedBy);
}

/** Mark a held row dropped (kept as a decided record, payload included). Null when not held. */
export function dropWriteGateHold(tx: Exec, id: number, decidedBy: string): Promise<WriteGateHold | null> {
  return decideHold(tx, id, 'dropped', decidedBy);
}

/** Delete receipts not seen for `olderThanDays` (default 365). Holds keep their receipts while held. */
export async function pruneWriteGateReceipts(engine: Exec, olderThanDays = WRITE_GATE_RECEIPT_RETENTION_DAYS): Promise<number> {
  const rows = await engine.executeRaw<{ id: string }>(
    `DELETE FROM write_gate_receipts r
      WHERE r.last_seen_at < now() - make_interval(days => $1)
        AND NOT (r.target_table = 'write_gate_holds' AND EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.id::text = r.target_id AND h.status = 'held'))
      RETURNING r.id::text AS id`, [olderThanDays]);
  return rows.length;
}

/**
 * What a fact or take writer does with one row (B3/B4):
 *   - `insert`: write the row; when `assessment.verdict` is `flag`, call
 *     `recordFlaggedRow` with the inserted id in the same transaction.
 *   - `hold`: do not insert; call `recordWriteGateHold(tx, hold)` and return
 *     the verb error `write_held` (`writeHeldError`).
 *   - `reject`: do not insert; refuse with `writeGateRejectedError`.
 */
export interface GatedRowDecision {
  assessment: WriteGateAssessment;
  action: 'insert' | 'hold' | 'reject';
  hold: WriteGateHoldInput | null;
  requestId: string | null;
}

export interface GatedRowContext {
  sourceId: string;
  slug?: string | null;
  /** The row exactly as the writer would insert it (kept in the hold). */
  payload: Record<string, unknown>;
  input: WriteGateInput;
  cfg: WriteGateConfig;
}

function decide(kind: WriteGateHoldKind, assessment: WriteGateAssessment, texts: ReadonlyArray<string | null | undefined>, ctx: GatedRowContext): GatedRowDecision {
  const requestId = ctx.input.requestId ?? null;
  if (assessment.verdict === 'reject') return { assessment, action: 'reject', hold: null, requestId };
  if (assessment.verdict !== 'quarantine') return { assessment, action: 'insert', hold: null, requestId };
  return {
    assessment, action: 'hold', requestId,
    hold: { kind, sourceId: ctx.sourceId, slug: ctx.slug ?? '', payload: ctx.payload, texts, assessment, origin: ctx.input.origin ?? null, requestId: ctx.input.requestId ?? null },
  };
}

export function decideFactWrite(row: GateFactRow, ctx: GatedRowContext): GatedRowDecision {
  return decide('fact', assessFactForGate(row, ctx.input, ctx.cfg), [row.fact, row.context, row.value], ctx);
}

export function decideTakeWrite(row: GateTakeRow, ctx: GatedRowContext): GatedRowDecision {
  return decide('take', assessTakeForGate(row, ctx.input, ctx.cfg), [row.claim, row.source, row.evidence], ctx);
}

/** Record a flagged row's receipt after insert (no-op unless the verdict is `flag`). */
export function recordFlaggedRow(tx: Exec, decision: GatedRowDecision, target: { table: 'facts' | 'takes' | 'timeline_entries'; id: string | number; sourceId: string }): Promise<number | null> {
  if (decision.assessment.verdict !== 'flag') return Promise.resolve(null);
  return recordWriteGateReceipt(tx, { targetTable: target.table, targetId: target.id, sourceId: target.sourceId, assessment: decision.assessment, requestId: decision.requestId });
}
