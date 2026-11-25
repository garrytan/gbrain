import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

/**
 * GBRA-438 — bookkeeping GC, split out of purge with the same functions and
 * retentions: op_checkpoints and brainstorm checkpoints (7 days), batch-retry
 * audit files (30 days), volunteer events (90 days), decision receipts,
 * applied captures and retrieval feedback (their own retention settings), and
 * GST-2988's publish-redaction upkeep (git/redact-finish.ts: spooled secret
 * originals into the store, pending redactions, backup refs past 7 days, Git
 * pushes parked on publish_secret_found retried). It never deletes a page, so unattended upkeep may run it (decision C1).
 */
export async function runPhaseBookkeepingGc(engine: BrainEngine, dryRun: boolean): Promise<PhaseResult> {
  if (dryRun) {
    const rechecks = await heldWriteRechecks(engine, true);
    return { phase: 'bookkeeping_gc', status: 'ok', duration_ms: 0, summary: 'dry-run: skipped bookkeeping GC',
      details: { dry_run: true, ...(rechecks ? { held_write_rechecks: rechecks } : {}) } };
  }
  // v0.36+ folded scope item +C: GC stale op_checkpoints rows.
  // 7-day TTL is deliberately generous; any reasonable long-running op
  // finishes inside that window. Cheap (few KB per row).
  let purgedCheckpoints = 0;
  try {
    const { purgeStaleCheckpoints } = await import('../op-checkpoint.ts');
    purgedCheckpoints = await purgeStaleCheckpoints(engine, 7);
  } catch {
    // Non-fatal: op_checkpoints table may not exist yet on pre-v67 brains.
  }
  // v0.37.x — TX3 / A5: GC stale brainstorm checkpoints (filesystem-side).
  // 7-day mtime window mirrors op_checkpoints. Wrapped in try/catch
  // because the brainstorm dir may not exist on a brain that's never
  // run a brainstorm.
  let purgedBrainstormCheckpoints = 0;
  try {
    const { gcStaleCheckpoints } = await import('../brainstorm/checkpoint.ts');
    purgedBrainstormCheckpoints = gcStaleCheckpoints(7);
  } catch {
    // Non-fatal.
  }
  // v0.41.18.0 codex H-8 — actual 30-day pruning of batch-retry audit JSONL.
  // The pre-v0.41.18 plan promised this "by convention"; this is the real
  // implementation. Never throws — best-effort GC.
  let purgedBatchRetryAuditFiles = 0;
  try {
    const { pruneOldBatchRetryAuditFiles } = await import('../audit/batch-retry-audit.ts');
    purgedBatchRetryAuditFiles = pruneOldBatchRetryAuditFiles(30).removed;
  } catch {
    // Non-fatal.
  }
  // v0.43 (#2095) — 90-day GC of the volunteered-context feedback log.
  // Conversation-adjacent telemetry must never grow unbounded. Best-effort:
  // purgeStaleVolunteerEvents returns 0 on pre-v117 brains (no table).
  let purgedVolunteerEvents = 0;
  try {
    const { purgeStaleVolunteerEvents } = await import('../context/volunteer-events.ts');
    purgedVolunteerEvents = await purgeStaleVolunteerEvents(engine);
  } catch {
    // Non-fatal.
  }
  // System One: decision receipts past decide.receipts.retention_days (reported only when rows were pruned).
  let purgedDecisionReceipts = 0;
  try { purgedDecisionReceipts = await (await import('../ai/decide/store.ts')).pruneReceiptsForCycle(engine); } catch { /* pre-v179 brain */ }
  // GST-1856: applied-capture records past 90 days (ingestion/applied-captures.ts; 0 on a brain before v296).
  const purgedAppliedCaptures = await (await import('../ingestion/applied-captures.ts')).purgeStaleAppliedCaptures(engine);
  let purgedFeedback = { events: 0, weights: 0 };
  try { purgedFeedback = await (await import('../feedback/store.ts')).pruneRetrievalFeedback(engine, (await (await import('../feedback/settings.ts')).loadFeedbackSettings(engine)).eventRetentionDays); } catch { /* pre-v207 brain */ }
  let secretPublish: Record<string, number> = {};
  // Never fatal, except a capability refusal: a managed-mode read the engine claims to serve and then refuses is a bug to see.
  try { secretPublish = await (await import('../git/redact-finish.ts')).secretPublishMaintenance(engine); } catch (e) { rethrowCapabilityRefusal(e); }
  const rechecks = await heldWriteRechecks(engine, false);
  // A sweep that failed or could not see its evidence leaves held text it owes; the phase says so instead of ok.
  const sweepOwed = rechecks?.status === 'fail' || rechecks?.status === 'unknown';
  return {
    phase: 'bookkeeping_gc',
    status: sweepOwed ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `${purgedCheckpoints} stale op_checkpoint(s), ${purgedBrainstormCheckpoints} stale brainstorm checkpoint(s), ` +
      `${purgedBatchRetryAuditFiles} stale batch-retry audit file(s) and ${purgedVolunteerEvents} stale volunteer event(s)` +
      (sweepOwed ? `; the held-write recheck did not run to the end (${rechecks!.status}${rechecks!.reason ? `: ${String(rechecks!.reason)}` : ''})` : ''),
    details: {
      purged_checkpoints_count: purgedCheckpoints,
      purged_brainstorm_checkpoints_count: purgedBrainstormCheckpoints,
      purged_batch_retry_audit_files_count: purgedBatchRetryAuditFiles,
      purged_volunteer_events_count: purgedVolunteerEvents,
      ...(purgedDecisionReceipts > 0 ? { purged_decision_receipts_count: purgedDecisionReceipts } : {}),
      ...(purgedAppliedCaptures > 0 ? { purged_applied_captures_count: purgedAppliedCaptures } : {}),
      ...(purgedFeedback.events + purgedFeedback.weights > 0 ? { purged_retrieval_feedback_events_count: purgedFeedback.events, purged_retrieval_weights_count: purgedFeedback.weights } : {}),
      ...secretPublish,
      ...(rechecks ? { held_write_rechecks: rechecks } : {}),
    },
  };
}

/**
 * Held writes a purge kept for another page, checked again (write-gate-recheck.ts): the ones no page row is left for are
 * deleted with their receipts. Reported only when it found notes, was switched off, or could not run; a failure is reported,
 * never thrown, so the rest of the phase's upkeep stands.
 */
async function heldWriteRechecks(engine: BrainEngine, dryRun: boolean): Promise<Record<string, unknown> | null> {
  try {
    const { orphanSweepEnabled, sweepHoldRechecks } = await import('../write-gate-recheck.ts');
    if (!await orphanSweepEnabled(engine)) return { status: 'skipped', reason: 'disabled' };
    const result = await sweepHoldRechecks(engine, { dryRun });
    if (result.status === 'skipped' && result.reason === 'pre_schema') return null;
    return result.status === 'ok' && result.checked === 0 && !result.would_check ? null : { ...result };
  } catch (e) {
    return { status: 'fail', error: e instanceof Error ? e.message : String(e) };
  }
}
