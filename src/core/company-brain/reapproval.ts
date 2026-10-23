import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { syncLockId, withRefreshingLock } from '../db-lock.ts';
import { opError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { registerLocalWriter } from '../persistence/identity.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { lockTopologyPrincipal, lockTopologyRows, topologyPrincipal, withTopologyLocks } from '../persistence/topology-locks.ts';
import { priorTopologyChange, recordTopologyChange, type TopologyChange } from '../persistence/topology-receipts.ts';
import { topologyTransaction } from '../persistence/topology-transaction.ts';
import { retireManagedSyncOrphan } from '../persistence/managed-sync-orphans.ts';
import { clearManagedSyncFailure } from '../sync-failure-ledger.ts';
import { assertCompanyBrainCaller, checkCompanyBrainDestination, ingestionFence, ownerStatusFix, reinspectFix,
  sourceStatusFix, unwrapCompanyBrainPlan, type CompanyBrainConnectInput, type CompanyBrainPreview } from './admission.ts';
import { validateCompanyBrainPlan } from './inspection.ts';
import { readCompanyBrainPlan } from './profile.ts';
import { assertCompanyBrainExtractor, assertCompanyBrainPolicy, companyBrainPolicyFingerprint, companyBrainProfile,
  companyBrainRepository, type CompanyBrainProfile } from './policy.ts';
import { beginSourceIngestionReceipt, discardSourceIngestionReceipt, getSourceIngestionReceipt,
  linkSourceIngestionCheckpoints, type SourceIngestionReceipt } from './receipts.ts';

type ReplacementInput = CompanyBrainConnectInput & { replaceIncomplete?: string };
type ValidInput = ReplacementInput & { replaceIncomplete: string; requestId: string };
type ReplacementPreview = CompanyBrainPreview & { replacingReceiptId: string };
type Admission = { receiptId: string; sourceIncarnation: string };
interface Source { incarnation: string; local_path: string; archived: boolean; config: unknown }

function inputForReplacement(input: ReplacementInput): ValidInput {
  assertCompanyBrainCaller(input);
  if (!input.replaceIncomplete || !isWriteRequestId(input.replaceIncomplete) || !input.requestId ||
      !isWriteRequestId(input.requestId) || input.requestId === input.replaceIncomplete) {
    throw opError('invalid_params', 'Replacement requires the incomplete receipt UUID and a different request UUID.',
      'Pass --replace-incomplete with the receipt being replaced, and reuse the new --request-id only for this identical reviewed replacement.');
  }
  return { ...input, plan: unwrapCompanyBrainPlan(input.plan), replaceIncomplete: input.replaceIncomplete, requestId: input.requestId };
}

function replacementIntent(input: ValidInput) {
  return { operation: 'company-brain-replace', brainId: input.brainId, sourceId: input.sourceId,
    path: resolve(input.path), replacedReceiptId: input.replaceIncomplete, planDigest: input.plan.plan_digest };
}

function changed(input: ValidInput, message: string): never {
  throw opError('source_changed', message,
    'Read the source receipt and inspect the corrected committed source again. Nothing was replaced; do not edit approval or checkpoint records.',
    { fix: sourceStatusFix(input.brainId, `Shows source ${input.sourceId}'s current receipt and registration.`) });
}

async function sourceAndProfile(engine: BrainEngine, input: ValidInput) {
  const [source] = await engine.executeRaw<Source>('SELECT incarnation,local_path,archived,config FROM sources WHERE id=$1', [input.sourceId]);
  if (!source || source.archived || resolve(input.path) !== source.local_path || input.plan.revision?.root !== source.local_path) {
    changed(input, 'The replacement must name the same active source and checkout.');
  }
  const profile = companyBrainProfile(source.config);
  if (!profile || profile.brainId !== input.brainId) changed(input, 'The source is not the selected company-brain registration.');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) changed(input, 'The destination brain is no longer initialized.');
  return { source, profile, databaseId: brain.brain_id };
}

async function validatePlan(input: ValidInput, mode: 'apply' | 'resume'): Promise<void> {
  const validation = await validateCompanyBrainPlan(input.plan, { path: input.path, mode });
  if (!validation.valid) throw opError('plan_stale', 'The corrected source no longer matches the reviewed replacement plan.',
    'Inspect the corrected committed source again with the original include/exclude selection, review the new plan, and retry with a new request ID.',
    { fix: reinspectFix(input.path) });
}

/** Replays the exact lifecycle request before testing whether its old receipt is still incomplete. */
async function replay(engine: BrainEngine, input: ValidInput, prior: TopologyChange): Promise<Admission> {
  const { source, profile, databaseId } = await sourceAndProfile(engine, input);
  if (prior.state !== 'committed' || prior.operation !== 'company-brain-replace' || prior.source_id !== input.sourceId ||
      prior.source_incarnation !== source.incarnation || prior.outcome?.receipt_id !== input.requestId || profile.receiptId !== input.requestId) {
    changed(input, 'The replacement request no longer names this source\'s active approval.');
  }
  const receipt = await getSourceIngestionReceipt(engine, { sourceId: input.sourceId, sourceIncarnation: source.incarnation, receiptId: input.requestId });
  if (!receipt || receipt.outcome === 'discarded' || profile.planDigest !== input.plan.plan_digest) changed(input, 'The replacement receipt or its reviewed plan changed.');
  assertCompanyBrainPolicy(profile, receipt, databaseId, source.local_path);
  assertCompanyBrainExtractor(receipt.extractorVersion, input);
  await ingestionFence(engine, input.sourceId);
  await validatePlan(input, 'resume');
  return { receiptId: receipt.id, sourceIncarnation: source.incarnation };
}

/** Refuse rather than cancel any writer or effect, including work on a shared canonical worktree. */
async function assertQuiescent(engine: BrainEngine, input: ValidInput, worktrees: string[]): Promise<void> {
  const [pending] = await engine.executeRaw(`SELECT 1 FROM persistence_requests
    WHERE (source_id=$1 OR worktree_id=ANY($2::uuid[]))
      AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL)
    UNION ALL SELECT 1 FROM persistence_effects
    WHERE (source_id=$1 OR worktree_id=ANY($2::uuid[]))
      AND (state IN ('queued','running') OR recovery IS NOT NULL)
    UNION ALL SELECT 1 FROM persistence_topology_changes
    WHERE (source_id=$1 OR worktree_ids && $2::uuid[]) AND (state='recovering' OR recovery IS NOT NULL) LIMIT 1`,
  [input.sourceId, worktrees]);
  if (pending) throw opError('write_pending', 'The source must be quiescent before replacing an incomplete approval.',
    'Let its registered owner finish or recover pending writes and effects, then retry this identical replacement request. No queued work was cancelled.',
    { fix: ownerStatusFix(input.sourceId) });
}

async function inspectReplacement(engine: BrainEngine, input: ValidInput) {
  const { source, profile, databaseId } = await sourceAndProfile(engine, input);
  if (profile.receiptId !== input.replaceIncomplete) changed(input, 'The named incomplete receipt is no longer the active approval.');
  const receipt = await getSourceIngestionReceipt(engine, { sourceId: input.sourceId, sourceIncarnation: source.incarnation, receiptId: input.replaceIncomplete });
  if (!receipt || receipt.outcome !== 'incomplete') changed(input, 'Only an active incomplete receipt can be replaced.');
  assertCompanyBrainPolicy(profile, receipt, databaseId, source.local_path);
  assertCompanyBrainExtractor(receipt.extractorVersion, input);
  await validatePlan(input, 'apply');
  const oldPlan = await readCompanyBrainPlan(engine, receipt.id);
  if (oldPlan.plan_digest !== profile.planDigest || oldPlan.revision?.commit !== receipt.approvedRevision) {
    changed(input, 'The incomplete receipt\'s stored plan does not match its approval.');
  }
  const schema = input.plan.schema!;
  if (schema.name !== 'company-brain') changed(input, 'Replacement requires the same company-brain schema.');
  const nextProfile: CompanyBrainProfile = { ...profile, receiptId: input.requestId, planDigest: input.plan.plan_digest,
    approvedRevision: input.plan.revision!.commit, repository: companyBrainRepository(input.plan.revision!),
    selection: input.plan.selection, limits: input.plan.limits, schema: { ...schema, name: 'company-brain' }, extractorVersion: input.plan.extractor_version };
  if (companyBrainPolicyFingerprint(nextProfile, input.sourceId) !== receipt.policyFingerprint ||
      digest(input.plan.audience_requirements) !== digest(oldPlan.audience_requirements)) {
    throw opError('profile_incompatible', 'Replacement cannot change the approved repository, selection, limits, schema or audience policy.',
      'Inspect the corrected commit with the original policy. Changes to source policy or access need a separately reviewed source-administration workflow.');
  }
  const preview = await checkCompanyBrainDestination(engine, input, false);
  const fence = await ingestionFence(engine, input.sourceId);
  await assertQuiescent(engine, input, fence.mode === 'managed' ? [fence.worktreeId] : []);
  return { source, receipt, nextProfile, preview, fence };
}

export async function previewCompanyBrainReplacement(engine: BrainEngine, value: ReplacementInput): Promise<ReplacementPreview> {
  const input = inputForReplacement(value);
  const principal = await topologyPrincipal(engine);
  const prior = await priorTopologyChange(engine, principal, input.requestId, replacementIntent(input));
  if (prior) {
    const admitted = await replay(engine, input, prior);
    return { ...await checkCompanyBrainDestination(engine, input, false), replacingReceiptId: input.replaceIncomplete,
      replayed: true, receiptId: admitted.receiptId };
  }
  const { preview } = await inspectReplacement(engine, input);
  return { ...preview, replacingReceiptId: input.replaceIncomplete };
}

/** Only this receipt's blocked cursor is retired; approval and source history remain. */
async function retireReceiptCursors(tx: BrainEngine, input: ValidInput, receipt: SourceIngestionReceipt,
  fence: (tx: BrainEngine) => Promise<void>): Promise<string[]> {
  const cursors = await tx.executeRaw<{ key: string; header: { companyReceiptId?: string; runId?: string } }>(
    `SELECT fingerprint AS key,completed_keys->0 AS header FROM op_checkpoints
      WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
        AND COALESCE(completed_keys->0->>'done','false')<>'true' FOR UPDATE`, [input.sourceId, receipt.sourceIncarnation]);
  const owned = new Set(receipt.checkpointRefs.filter(ref => ref.op === 'managed-sync' && ref.kind === 'managed_cursor').map(ref => ref.fingerprint));
  const manifests = new Set(receipt.checkpointRefs.filter(ref => ref.op === 'managed-sync-manifest' && ref.kind === 'manifest').map(ref => ref.fingerprint));
  for (const cursor of cursors) {
    if (cursor.header.companyReceiptId !== receipt.id || !owned.has(cursor.key) ||
        typeof cursor.header.runId !== 'string' || !manifests.has(cursor.header.runId)) {
      changed(input, 'An unfinished sync cursor is not owned by the incomplete receipt being replaced.');
    }
    const retired = await retireManagedSyncOrphan(tx, { kind: 'unfinished_cursor', cursor_key: cursor.key,
      run_id: cursor.header.runId, source_id: input.sourceId, source_incarnation: receipt.sourceIncarnation,
      reason: 'superseded_by_adoption' }, fence, { clearMirror: false });
    if (!retired.cursor) throw opError('write_pending', 'The incomplete receipt\'s cursor changed before retirement.',
      'Nothing was replaced. Wait for the active owner, then retry the same request ID.', { fix: ownerStatusFix(input.sourceId) });
  }
  return cursors.map(cursor => cursor.key);
}

export async function replaceCompanyBrainReceipt(engine: BrainEngine, value: ReplacementInput): Promise<Admission> {
  const input = inputForReplacement(value);
  await registerLocalWriter(engine, 'cli');
  const principal = await topologyPrincipal(engine);
  const intent = replacementIntent(input);
  const companyLock = `company-brain:${input.sourceId}`;
  const drainLock = syncLockId(input.sourceId);
  return withRefreshingLock(engine, companyLock, (companySignal, companyHandle) =>
    withRefreshingLock(engine, drainLock, (drainSignal, drainHandle) => {
      const fence = async (tx: BrainEngine) => {
        companySignal.throwIfAborted(); drainSignal.throwIfAborted();
        const held = await tx.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE ttl_expires_at>now()
          AND ((id=$1 AND acquisition_token=$2::uuid) OR (id=$3 AND acquisition_token=$4::uuid)) FOR SHARE`,
        [companyLock, companyHandle.acquisitionToken, drainLock, drainHandle.acquisitionToken]);
        if (held.length !== 2) throw opError('write_pending', 'Replacement lost its company or sync lease.',
          'Nothing was replaced. Retry the same request ID after the current owner finishes.');
      };
      return withTopologyLocks(engine, input.sourceId, async bindings => {
        let retiredKeys: string[] = [];
        const result = await topologyTransaction(engine, async tx => {
          await lockTopologyRows(tx, input.sourceId, bindings);
          await lockTopologyPrincipal(tx, principal);
          await fence(tx);
          const prior = await priorTopologyChange(tx, principal, input.requestId, intent);
          if (prior) return replay(tx, input, prior);
          const state = await inspectReplacement(tx, input);
          const worktrees = bindings.map(binding => binding.worktree_id);
          await assertQuiescent(tx, input, worktrees);
          retiredKeys = await retireReceiptCursors(tx, input, state.receipt, fence);
          await discardSourceIngestionReceipt(tx, { sourceId: input.sourceId, sourceIncarnation: state.source.incarnation,
            receiptId: state.receipt.id, expectedRevision: state.receipt.revision, expectedPhase: state.receipt.phase, fence: state.fence });
          const next = await beginSourceIngestionReceipt(tx, { id: input.requestId, sourceId: input.sourceId,
            sourceIncarnation: state.source.incarnation, approvedRevision: input.plan.revision!.commit, profile: 'company-brain',
            schemaFingerprint: input.plan.schema!.resolved_digest, extractorVersion: input.plan.extractor_version,
            policyFingerprint: state.receipt.policyFingerprint!, fence: state.fence, lifecycleRequestIds: [input.requestId] });
          await linkSourceIngestionCheckpoints(tx, { sourceId: input.sourceId, sourceIncarnation: state.source.incarnation,
            receiptId: next.id, expectedRevision: next.revision, expectedPhase: next.phase, fence: state.fence, checkpoints: [
              { op: 'company-brain-plan', fingerprint: next.id, kind: 'manifest' },
              { op: 'company-brain-replacement', fingerprint: next.id, kind: 'manifest' },
            ] });
          await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES
            ('company-brain-plan',$1,$2::text::jsonb),('company-brain-replacement',$1,$3::text::jsonb)`,
          [next.id, JSON.stringify([input.plan]), JSON.stringify([state.receipt.id])]);
          const [updated] = await tx.executeRaw<{ config: unknown }>("UPDATE sources SET config=jsonb_set(config,'{company_brain}',$3::text::jsonb) WHERE id=$1 AND incarnation=$2::uuid RETURNING config",
            [input.sourceId, state.source.incarnation, JSON.stringify(state.nextProfile)]);
          if (!updated || companyBrainProfile(updated.config)?.receiptId !== next.id) changed(input, 'The source could not bind the replacement receipt.');
          await recordTopologyChange(tx, { principal, requestId: input.requestId, intent, operation: 'company-brain-replace',
            sourceId: input.sourceId, incarnation: state.source.incarnation, worktrees },
          { source_id: input.sourceId, source_incarnation: state.source.incarnation, receipt_id: next.id, replaced_receipt_id: state.receipt.id });
          return { receiptId: next.id, sourceIncarnation: state.source.incarnation };
        });
        // The DB rows are authoritative. Never clear their compatibility mirror
        // before the enclosing receipt/source transaction actually commits.
        for (const key of retiredKeys) try { clearManagedSyncFailure(key); } catch { /* compatibility mirror only */ }
        return result;
      }, input.plan.revision?.git_root);
    }));
}
