import type { BrainEngine } from '../engine.ts';
import { isValidSourceId } from '../source-id.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { OperationError } from '../ops/contract.ts';

export type SourceIngestionPhase = 'ADMITTED' | 'CONTENT' | 'GRAPH' | 'VERIFY' | 'COMPLETE';
export type SourceIngestionDiagnostic = 'interrupted' | 'content_incomplete' | 'graph_incomplete' | 'verification_failed' | 'pending_writes' | 'source_changed' | 'checkpoint_missing' | 'operation_failed';
export interface SourceIngestionCounts {
  eligibleFiles: number;
  importedPages: number;
  skippedFiles: number;
  failedFiles: number;
  graphPages: number;
  links: number;
  unresolvedLinks: number;
  pendingWrites: number;
  verificationFailures: number;
}
export interface SourceIngestionCheckpoint {
  op: string;
  fingerprint: string;
  kind: 'content' | 'manifest' | 'managed_cursor' | 'graph' | 'verify';
}
export type SourceIngestionFence = { mode: 'unmanaged' } | {
  mode: 'managed';
  worktreeId: string;
  ownerHostId: string;
  ownerEpoch: string | number;
  topologyGeneration: string | number;
};
export interface SourceIngestionScope {
  sourceId: string;
  sourceIncarnation: string;
}
export interface SourceIngestionIdentity extends SourceIngestionScope {
  id: string;
  approvedRevision: string;
  profile: string;
  schemaFingerprint: string;
  extractorVersion: string;
  policyFingerprint: string | null;
}
export interface SourceIngestionReceipt extends SourceIngestionIdentity {
  revision: number;
  phase: SourceIngestionPhase;
  outcome: 'incomplete' | 'complete' | 'discarded';
  counts: SourceIngestionCounts;
  lifecycleRequestIds: string[];
  checkpointRefs: SourceIngestionCheckpoint[];
  diagnostic: SourceIngestionDiagnostic | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  discardedAt: string | null;
}
export interface BeginSourceIngestionReceiptInput extends SourceIngestionIdentity {
  policyFingerprint: string;
  fence: SourceIngestionFence;
  lifecycleRequestIds?: string[];
}
export interface SourceIngestionMutation extends SourceIngestionScope {
  receiptId: string;
  expectedRevision: number;
  expectedPhase: SourceIngestionPhase;
  fence: SourceIngestionFence;
}
export type SourceIngestionState =
  | { state: 'never_connected' | 'missing'; receipt: null }
  | { state: SourceIngestionReceipt['outcome']; receipt: SourceIngestionReceipt };

const phases: SourceIngestionPhase[] = ['ADMITTED', 'CONTENT', 'GRAPH', 'VERIFY', 'COMPLETE'];
const diagnostics = new Set<SourceIngestionDiagnostic>(['interrupted', 'content_incomplete', 'graph_incomplete', 'verification_failed', 'pending_writes', 'source_changed', 'checkpoint_missing', 'operation_failed']);
const emptyCounts: SourceIngestionCounts = { eligibleFiles: 0, importedPages: 0, skippedFiles: 0, failedFiles: 0, graphPages: 0, links: 0, unresolvedLinks: 0, pendingWrites: 0, verificationFailures: 0 };
const columns = `id, source_id AS "sourceId", source_incarnation AS "sourceIncarnation", approved_revision AS "approvedRevision",
  profile, schema_fingerprint AS "schemaFingerprint", extractor_version AS "extractorVersion", policy_fingerprint AS "policyFingerprint", revision, phase, outcome, counts,
  lifecycle_request_ids AS "lifecycleRequestIds", checkpoint_refs AS "checkpointRefs", diagnostic,
  created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt", discarded_at AS "discardedAt"`;
type ReceiptRow = Omit<SourceIngestionReceipt, 'createdAt' | 'updatedAt' | 'completedAt' | 'discardedAt'> & {
  createdAt: string | Date; updatedAt: string | Date; completedAt: string | Date | null; discardedAt: string | Date | null;
};

function fail(code: string, message: string): never { throw new OperationError(code, message); }
function iso(value: string | Date): string { return new Date(value).toISOString(); }
function receipt(row: ReceiptRow): SourceIngestionReceipt {
  return { ...row, counts: { ...emptyCounts, ...row.counts }, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    completedAt: row.completedAt === null ? null : iso(row.completedAt), discardedAt: row.discardedAt === null ? null : iso(row.discardedAt) };
}
function validateScope(scope: SourceIngestionScope): void {
  if (!isValidSourceId(scope.sourceId) || !isWriteRequestId(scope.sourceIncarnation)) fail('invalid_receipt', 'A valid source ID and incarnation are required.');
}
function validateId(id: string): void {
  if (!isWriteRequestId(id)) fail('invalid_receipt', 'Receipt and request IDs must be UUIDs.');
}
function validatedCounts(counts: Partial<SourceIngestionCounts>): Partial<SourceIngestionCounts> {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) fail('invalid_receipt', 'Receipt counts must be numeric counters.');
  for (const [key, value] of Object.entries(counts)) {
    if (!Object.hasOwn(emptyCounts, key) || !Number.isSafeInteger(value) || value < 0) fail('invalid_receipt', 'Receipt counts must be known nonnegative safe integers.');
  }
  return counts;
}
function validatedRequests(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length > 128) fail('invalid_receipt', 'At most 128 lifecycle request references are permitted.');
  ids.forEach(validateId);
  return [...new Set(ids)].sort();
}
function sanitizedDiagnostic(value: unknown): SourceIngestionDiagnostic {
  return diagnostics.has(value as SourceIngestionDiagnostic) ? value as SourceIngestionDiagnostic : 'operation_failed';
}

async function lockScope(tx: BrainEngine, input: SourceIngestionScope & { fence: SourceIngestionFence }): Promise<void> {
  validateScope(input);
  const [brain] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR SHARE');
  if (!input.fence || !['managed', 'unmanaged'].includes(input.fence.mode)) fail('receipt_fence_required', 'An explicit ingestion authority fence is required.');
  if (brain?.enabled && input.fence.mode !== 'managed') fail('receipt_fence_required', 'Managed ingestion requires its worktree owner and topology fence.');
  if (input.fence.mode === 'managed') {
    const f = input.fence;
    if (!isWriteRequestId(f.worktreeId) || !isWriteRequestId(f.ownerHostId) || !/^[0-9]+$/.test(String(f.ownerEpoch)) || !/^[0-9]+$/.test(String(f.topologyGeneration))) {
      fail('invalid_receipt', 'Invalid managed owner or topology fence.');
    }
    const [owner] = await tx.executeRaw(`SELECT id FROM persistence_worktrees WHERE id=$1::uuid AND owner_host_id=$2::uuid
      AND owner_epoch=$3::bigint AND topology_generation=$4::bigint AND state='active' FOR SHARE`,
    [f.worktreeId, f.ownerHostId, String(f.ownerEpoch), String(f.topologyGeneration)]);
    if (!owner) fail('receipt_fence_changed', 'The managed owner or topology changed.');
  }
  const [source] = await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND incarnation=$2::uuid AND NOT archived FOR SHARE', [input.sourceId, input.sourceIncarnation]);
  if (!source) fail('source_changed', 'The source is missing, archived, or has a different incarnation.');
  const [binding] = await tx.executeRaw<{ worktree_id: string; source_incarnation: string; topology_generation: string | number }>(
    'SELECT worktree_id, source_incarnation, topology_generation FROM persistence_source_bindings WHERE source_id=$1 FOR SHARE', [input.sourceId]);
  if (input.fence.mode === 'unmanaged') {
    if (binding) fail('receipt_fence_required', 'A bound source requires its managed owner and topology fence.');
  } else if (!binding || binding.worktree_id !== input.fence.worktreeId || binding.source_incarnation !== input.sourceIncarnation
    || String(binding.topology_generation) !== String(input.fence.topologyGeneration)) {
    fail('receipt_fence_changed', 'The managed source binding changed.');
  }
}

export async function getSourceIngestionReceipt(db: BrainEngine, input: SourceIngestionScope & { receiptId: string }): Promise<SourceIngestionReceipt | null> {
  validateScope(input);
  validateId(input.receiptId);
  const [row] = await db.executeRaw<ReceiptRow>(`SELECT ${columns} FROM source_ingestion_receipts
    WHERE id=$1::uuid AND source_id=$2 AND source_incarnation=$3::uuid
    AND EXISTS (SELECT 1 FROM sources WHERE id=$2 AND incarnation=$3::uuid)`, [input.receiptId, input.sourceId, input.sourceIncarnation]);
  return row ? receipt(row) : null;
}

export async function readSourceIngestionState(db: BrainEngine, input: SourceIngestionScope & { receiptId: string | null }): Promise<SourceIngestionState> {
  validateScope(input);
  const [source] = await db.executeRaw('SELECT id FROM sources WHERE id=$1 AND incarnation=$2::uuid', [input.sourceId, input.sourceIncarnation]);
  if (!source) return { state: 'missing', receipt: null };
  if (input.receiptId === null) return { state: 'never_connected', receipt: null };
  const found = await getSourceIngestionReceipt(db, { ...input, receiptId: input.receiptId });
  return found ? { state: found.outcome, receipt: found } : { state: 'missing', receipt: null };
}

export async function beginSourceIngestionReceipt(db: BrainEngine, input: BeginSourceIngestionReceiptInput): Promise<SourceIngestionReceipt> {
  validateId(input.id);
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.approvedRevision) || !/^[a-f0-9]{64}$/.test(input.schemaFingerprint) || !/^[a-f0-9]{64}$/.test(input.policyFingerprint)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.profile) || !/^[a-zA-Z0-9][a-zA-Z0-9._+:-]{0,127}$/.test(input.extractorVersion)) {
    fail('invalid_receipt', 'Receipts require a full approved revision, resolved-schema SHA-256, profile ID, and extractor version.');
  }
  const requests = validatedRequests(input.lifecycleRequestIds ?? []);
  return db.transaction(async tx => {
    await lockScope(tx, input);
    const [inserted] = await tx.executeRaw<ReceiptRow>(`INSERT INTO source_ingestion_receipts
      (id, source_id, source_incarnation, approved_revision, profile, schema_fingerprint, extractor_version, lifecycle_request_ids, policy_fingerprint)
      VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8::uuid[],$9) ON CONFLICT (id) DO NOTHING RETURNING ${columns}`,
    [input.id, input.sourceId, input.sourceIncarnation, input.approvedRevision, input.profile, input.schemaFingerprint, input.extractorVersion, requests, input.policyFingerprint]);
    if (inserted) return receipt(inserted);
    const prior = await getSourceIngestionReceipt(tx, { ...input, receiptId: input.id });
    if (!prior || prior.approvedRevision !== input.approvedRevision || prior.profile !== input.profile || prior.schemaFingerprint !== input.schemaFingerprint
      || prior.extractorVersion !== input.extractorVersion || prior.policyFingerprint !== input.policyFingerprint || requests.some(id => !prior.lifecycleRequestIds.includes(id))) {
      fail('receipt_identity_mismatch', 'The receipt ID is already bound to different approved ingestion metadata.');
    }
    return prior;
  });
}

async function mutate(db: BrainEngine, input: SourceIngestionMutation, change: (prior: SourceIngestionReceipt) => SourceIngestionReceipt): Promise<SourceIngestionReceipt> {
  validateId(input.receiptId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !phases.includes(input.expectedPhase)) fail('invalid_receipt', 'An expected receipt revision and phase are required.');
  return db.transaction(async tx => {
    await lockScope(tx, input);
    const [row] = await tx.executeRaw<ReceiptRow>(`SELECT ${columns} FROM source_ingestion_receipts
      WHERE id=$1::uuid AND source_id=$2 AND source_incarnation=$3::uuid FOR UPDATE`, [input.receiptId, input.sourceId, input.sourceIncarnation]);
    if (!row || row.revision !== input.expectedRevision || row.phase !== input.expectedPhase || row.outcome !== 'incomplete') fail('receipt_conflict', 'The receipt revision, phase, or outcome changed. Reload before retrying.');
    const next = change(receipt(row));
    const [updated] = await tx.executeRaw<ReceiptRow>(`UPDATE source_ingestion_receipts SET revision=revision+1, phase=$5, outcome=$6,
      counts=$7::text::jsonb, lifecycle_request_ids=$8::uuid[], checkpoint_refs=$9::text::jsonb, diagnostic=$10, updated_at=now(),
      completed_at=CASE WHEN $6='complete' THEN now() ELSE NULL END, discarded_at=CASE WHEN $6='discarded' THEN now() ELSE NULL END
      WHERE id=$1::uuid AND source_id=$2 AND source_incarnation=$3::uuid AND revision=$4 AND phase=$11 AND outcome='incomplete' RETURNING ${columns}`,
    [input.receiptId, input.sourceId, input.sourceIncarnation, input.expectedRevision, next.phase, next.outcome, JSON.stringify(next.counts),
      next.lifecycleRequestIds, JSON.stringify(next.checkpointRefs), next.diagnostic, input.expectedPhase]);
    if (!updated) fail('receipt_conflict', 'The receipt changed before the update committed.');
    return receipt(updated);
  });
}

export async function transitionSourceIngestionReceipt(db: BrainEngine, input: SourceIngestionMutation & {
  phase: Exclude<SourceIngestionPhase, 'COMPLETE'>;
  counts?: Partial<SourceIngestionCounts>;
  lifecycleRequestIds?: string[];
}): Promise<SourceIngestionReceipt> {
  const counts = validatedCounts(input.counts ?? {});
  return mutate(db, input, prior => {
    const delta = phases.indexOf(input.phase) - phases.indexOf(prior.phase);
    if (!phases.includes(input.phase) || (input.phase as SourceIngestionPhase) === 'COMPLETE' || delta < 0 || delta > 1) fail('invalid_receipt_transition', 'Advance at most one ingestion phase, or update the current phase.');
    return { ...prior, phase: input.phase, counts: { ...prior.counts, ...counts }, diagnostic: null,
      lifecycleRequestIds: validatedRequests([...prior.lifecycleRequestIds, ...(input.lifecycleRequestIds ?? [])]) };
  });
}

export async function linkSourceIngestionCheckpoints(db: BrainEngine, input: SourceIngestionMutation & { checkpoints: SourceIngestionCheckpoint[] }): Promise<SourceIngestionReceipt> {
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length > 32) fail('invalid_receipt', 'At most 32 checkpoint references are permitted.');
  const checkpoints = input.checkpoints.map(ref => {
    if (!ref || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(ref.op) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(ref.fingerprint)
      || !['content', 'manifest', 'managed_cursor', 'graph', 'verify'].includes(ref.kind)) fail('invalid_receipt', 'Checkpoint references must contain only bounded operation identities.');
    return { op: ref.op, fingerprint: ref.fingerprint, kind: ref.kind };
  });
  return mutate(db, input, prior => {
    const refs = new Map(prior.checkpointRefs.map(ref => [JSON.stringify([ref.op, ref.fingerprint]), ref]));
    for (const ref of checkpoints) refs.set(JSON.stringify([ref.op, ref.fingerprint]), ref);
    if (refs.size > 32) fail('invalid_receipt', 'At most 32 checkpoint references are permitted.');
    return { ...prior, checkpointRefs: [...refs.values()] };
  });
}

export async function recordSourceIngestionOutcome(db: BrainEngine, input: SourceIngestionMutation & {
  counts?: Partial<SourceIngestionCounts>;
} & ({ outcome: 'complete'; contentCommitted: true; graphCommitted: true; verificationPassed: true } |
  { outcome: 'incomplete'; diagnostic: SourceIngestionDiagnostic })): Promise<SourceIngestionReceipt> {
  const counts = validatedCounts(input.counts ?? {});
  return mutate(db, input, prior => {
    const next = { ...prior, counts: { ...prior.counts, ...counts } };
    if (input.outcome === 'incomplete') return { ...next, diagnostic: sanitizedDiagnostic(input.diagnostic) };
    if (input.outcome !== 'complete' || prior.phase !== 'VERIFY' || input.contentCommitted !== true || input.graphCommitted !== true || input.verificationPassed !== true
      || next.counts.failedFiles > 0 || next.counts.pendingWrites > 0 || next.counts.verificationFailures > 0) fail('invalid_receipt_transition', 'Completion requires verified content and graph commits with no failed or pending writes.');
    return { ...next, phase: 'COMPLETE', outcome: 'complete', diagnostic: null };
  });
}

export async function discardSourceIngestionReceipt(db: BrainEngine, input: SourceIngestionMutation): Promise<SourceIngestionReceipt> {
  return mutate(db, input, prior => ({ ...prior, outcome: 'discarded', diagnostic: null }));
}

export async function pruneSourceIngestionReceipts(db: BrainEngine): Promise<number> {
  const rows = await db.executeRaw<{ count: string }>(`WITH deleted AS (
    DELETE FROM source_ingestion_receipts r WHERE r.outcome='complete' AND r.completed_at < now() - interval '90 days'
      AND EXISTS (SELECT 1 FROM source_ingestion_receipts newer WHERE newer.source_id=r.source_id AND newer.source_incarnation=r.source_incarnation
        AND newer.outcome='complete' AND (newer.completed_at,newer.id) > (r.completed_at,r.id)) RETURNING 1
    ) SELECT count(*)::text AS count FROM deleted`);
  return Number(rows[0]?.count ?? 0);
}
