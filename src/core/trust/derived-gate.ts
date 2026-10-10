/**
 * The row-level write gate for derivers (#5575 B3, ENG-18): the gate input
 * is exactly the tier the deriver declared (trust/taint.ts). Each writer
 * calls decideFactWrite / decideTakeWrite / assessTimelineForGate itself
 * (write-gate-store.ts, write-gate.ts); these helpers read the gate config
 * once per run and apply one decision inside the writer's transaction.
 * A deriver never throws for one row: a held row goes to write_gate_holds, a
 * rejected row is skipped and counted.
 */
import type { BrainEngine } from '../engine.ts';
import { loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, type WriteGateConfig, type WriteGateInput } from '../write-gate.ts';
import { recordFlaggedRow, recordWriteGateHold, recordWriteGateReceipt, type GatedRowDecision } from '../write-gate-store.ts';
import type { WriteGateAssessment } from '../write-gate.ts';
import type { WriteTrust } from './tier.ts';

/** `write_gate.*` as the import path reads it; unreadable values fall back to the defaults, never `off`. */
export async function derivedGateConfig(engine: BrainEngine): Promise<WriteGateConfig> {
  return (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG;
}

/** The gate input for a declared derivation. */
export function derivedGateInput(trust: WriteTrust, requestId?: string | null): WriteGateInput {
  return { tier: trust.tier, origin: trust.origin, requestId: requestId ?? trust.origin?.request_id ?? null };
}

/** What one run's gate did, for the run result. */
export interface GateTally { flagged: number; held: number; rejected: number }
export const emptyGateTally = (): GateTally => ({ flagged: 0, held: 0, rejected: 0 });
/** Sums two tallies; undefined while nothing was flagged, held or rejected (a run result shows the field only when the gate acted). */
export function mergeGateTally(into: GateTally | undefined, from: GateTally | undefined): GateTally | undefined {
  const sum = { flagged: (into?.flagged ?? 0) + (from?.flagged ?? 0), held: (into?.held ?? 0) + (from?.held ?? 0), rejected: (into?.rejected ?? 0) + (from?.rejected ?? 0) };
  return sum.flagged || sum.held || sum.rejected ? sum : undefined;
}

/**
 * Applies one decision inside the writer's transaction: `insert` runs the
 * insert and records the flag receipt on the new row; `hold` records the hold
 * instead of inserting; `reject` writes nothing. Returns the inserted id.
 */
export async function applyGateDecision(tx: BrainEngine, decision: GatedRowDecision, target: { table: 'facts' | 'takes'; sourceId: string },
  insert: () => Promise<number | null>, tally?: GateTally): Promise<number | null> {
  if (decision.action === 'reject') { if (tally) tally.rejected++; return null; }
  if (decision.action === 'hold') { await recordWriteGateHold(tx, decision.hold!); if (tally) tally.held++; return null; }
  const id = await insert();
  if (id !== null && await recordFlaggedRow(tx, decision, { table: target.table, id, sourceId: target.sourceId }) !== null && tally) tally.flagged++;
  return id;
}

/** Whether a timeline row's assessment lets it be written: timeline rows have no hold store, so quarantine and reject skip the row. */
export function timelineRowAllowed(assessment: WriteGateAssessment): boolean {
  return assessment.verdict === 'allow' || assessment.verdict === 'flag';
}

/**
 * Records a flagged timeline row's receipt after its insert, in the same
 * transaction. Batch inserts return no ids, so the row is found by its
 * natural key (page, date, summary, source).
 */
export async function recordTimelineFlag(tx: BrainEngine, assessment: WriteGateAssessment,
  row: { slug: string; source_id?: string; date: string; summary: string; source?: string | null }, requestId?: string | null): Promise<void> {
  if (assessment.verdict !== 'flag') return;
  const sourceId = row.source_id ?? 'default';
  const [entry] = await tx.executeRaw<{ id: number }>(`SELECT te.id FROM timeline_entries te JOIN pages p ON p.id=te.page_id
    WHERE p.source_id=$1 AND p.slug=$2 AND te.date=$3::date AND te.summary=$4 AND COALESCE(te.source,'')=COALESCE($5,'') ORDER BY te.id DESC LIMIT 1`,
  [sourceId, row.slug, row.date, row.summary, row.source ?? null]);
  if (entry) await recordWriteGateReceipt(tx, { targetTable: 'timeline_entries', targetId: Number(entry.id), sourceId, assessment, requestId });
}
