// v0.40.6.0 Schema Cathedral v3 — pack mutation audit JSONL.
//
// Every `withMutation` call (and every refused mutation) emits one line
// to `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl`. The audit lets:
//   - `gbrain doctor` detect anomalous mutation patterns (Phase 9)
//   - `schema_pack_writability` doctor check surface failure events
//   - operators forensically trace who mutated what and when
//
// Privacy posture (D20 + codex C10):
//   Type names are SHA-8 redacted by default. Path prefixes are
//   truncated to the first path segment only. Matches
//   `candidate-audit.ts:7-22` privacy contract — both files write under
//   `~/.gbrain/audit/` and a single leaked screenshot of either could
//   otherwise reveal sensitive taxonomy (mental_health_diagnosis,
//   patients/oncology/, contracts/litigation/, etc.).
//
//   Opt out of redaction with `GBRAIN_SCHEMA_AUDIT_VERBOSE=1` (same env
//   gate as candidate-audit so operators flip both surfaces together).
//
// Failure logging: we log both success and failure events so the Phase 9
// `schema_pack_writability` check has signal to read (codex C11 — the
// pre-fix plan only audited successes, leaving the doctor check unable
// to surface PACK_READONLY failures).
//
// Best-effort writes: stderr warn on disk failure, never throws.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isoWeekFilename, resolveAuditDir } from '../audit-week-file.ts';
import { isAuditVerbose } from './candidate-audit.ts';

export type MutationOp =
  | 'add_type'
  | 'remove_type'
  | 'update_type'
  | 'add_alias'
  | 'remove_alias'
  | 'add_prefix'
  | 'remove_prefix'
  | 'add_link_type'
  | 'remove_link_type'
  | 'set_extractable'
  | 'set_expert_routing';

export type MutationActor = 'cli' | `mcp:${string}` | 'autopilot' | 'test';

export type MutationOutcome = 'success' | 'failure';

export interface MutationAuditRecord {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Which primitive ran. */
  op: MutationOp;
  /** Pack name (NEVER redacted — pack names are user-chosen and non-PII). */
  pack: string;
  /** SHA-8 of the affected type name by default; raw when verbose env set. */
  type_or_hash: string | null;
  /** Whether `type_or_hash` is the raw type (verbose) or a sha8 hash. */
  type_redacted: boolean;
  /** First path segment only, e.g. 'people'. Null when op didn't touch a prefix. */
  prefix_first_seg: string | null;
  /** 'cli' | 'mcp:<clientId8>' | 'autopilot' | 'test'. */
  actor: MutationActor;
  /** Outcome of the mutation attempt. */
  outcome: MutationOutcome;
  /** When outcome=failure: short error code (e.g. 'PACK_READONLY'). */
  reason: string | null;
  /** Pack identity sha8 before mutation (null on failures that never read). */
  prev_sha8: string | null;
  /** Pack identity sha8 after mutation (null on failures). */
  new_sha8: string | null;
  /** Atomic batch identity — set when the mutation is part of a batched
   *  `schema_apply_mutations` call so an auditor can reconstruct the
   *  whole transaction. Null for single-mutation calls. */
  batch_id: string | null;
}

export interface LogMutationOpts {
  op: MutationOp;
  pack: string;
  /** Affected type name, if any. */
  type?: string;
  /** Affected prefix (full path, will be redacted to first segment). */
  prefix?: string;
  actor: MutationActor;
  prev_sha8?: string;
  new_sha8?: string;
  batch_id?: string;
}

export interface LogMutationFailureOpts extends LogMutationOpts {
  /** Short error code, e.g. 'PACK_READONLY' | 'LOCK_BUSY' | 'INVALID_RESULT'. */
  reason: string;
}

/** sha-256 → 8 hex chars. Matches candidate-audit.ts redaction. */
async function sha8(value: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function computeMutateAuditPath(now: Date = new Date()): string {
  return join(resolveAuditDir(), isoWeekFilename('schema-mutations', now));
}

async function buildRecord(
  opts: LogMutationOpts,
  outcome: MutationOutcome,
  reason: string | null,
): Promise<MutationAuditRecord> {
  const verbose = isAuditVerbose();
  let typeField: string | null = null;
  if (opts.type !== undefined) {
    typeField = verbose ? opts.type : await sha8(opts.type);
  }
  const prefixField =
    opts.prefix !== undefined && opts.prefix.length > 0
      ? (opts.prefix.split('/')[0] ?? '')
      : null;
  return {
    ts: new Date().toISOString(),
    op: opts.op,
    pack: opts.pack,
    type_or_hash: typeField,
    type_redacted: !verbose,
    prefix_first_seg: prefixField,
    actor: opts.actor,
    outcome,
    reason,
    prev_sha8: opts.prev_sha8 ?? null,
    new_sha8: opts.new_sha8 ?? null,
    batch_id: opts.batch_id ?? null,
  };
}

function appendBestEffort(path: string, record: MutationAuditRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    process.stderr.write(`[schema-mutations-audit] write failed: ${(e as Error).message}\n`);
  }
}

/** Log a successful mutation. Best-effort; never throws. */
export async function logMutationSuccess(opts: LogMutationOpts): Promise<void> {
  const record = await buildRecord(opts, 'success', null);
  appendBestEffort(computeMutateAuditPath(), record);
}

/** Log a failed mutation. Best-effort; never throws. */
export async function logMutationFailure(opts: LogMutationFailureOpts): Promise<void> {
  const record = await buildRecord(opts, 'failure', opts.reason);
  appendBestEffort(computeMutateAuditPath(), record);
}

/**
 * Read mutation audit entries across the last N days. Skips malformed
 * lines silently (audit is best-effort).
 */
export function readRecentMutations(daysBack = 30): MutationAuditRecord[] {
  const auditDir = resolveAuditDir();
  if (!existsSync(auditDir)) return [];
  const cutoffIso = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();
  const records: MutationAuditRecord[] = [];
  for (const name of readdirSync(auditDir)) {
    if (!name.startsWith('schema-mutations-') || !name.endsWith('.jsonl')) continue;
    let content: string;
    try {
      content = readFileSync(join(auditDir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MutationAuditRecord;
        if (r.ts >= cutoffIso) records.push(r);
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return records;
}

export interface MutationSummary {
  total: number;
  by_op: Partial<Record<MutationOp, number>>;
  by_outcome: { success: number; failure: number };
  by_pack: Record<string, number>;
  by_reason: Record<string, number>;
  by_actor: Record<string, number>;
}

/**
 * Aggregate mutation records for cross-surface parity. Both `gbrain
 * doctor` (Phase 9) and `gbrain schema audit` (future surface) MUST
 * consume from this helper so the two display sites never drift.
 */
export function summarizeMutations(records: MutationAuditRecord[]): MutationSummary {
  const summary: MutationSummary = {
    total: records.length,
    by_op: {},
    by_outcome: { success: 0, failure: 0 },
    by_pack: {},
    by_reason: {},
    by_actor: {},
  };
  for (const r of records) {
    summary.by_op[r.op] = (summary.by_op[r.op] ?? 0) + 1;
    if (r.outcome === 'success') summary.by_outcome.success++;
    else summary.by_outcome.failure++;
    summary.by_pack[r.pack] = (summary.by_pack[r.pack] ?? 0) + 1;
    if (r.reason) summary.by_reason[r.reason] = (summary.by_reason[r.reason] ?? 0) + 1;
    // Bucket actor classes: cli | mcp | autopilot | test
    const actorBucket = r.actor.startsWith('mcp:') ? 'mcp' : r.actor;
    summary.by_actor[actorBucket] = (summary.by_actor[actorBucket] ?? 0) + 1;
  }
  return summary;
}
