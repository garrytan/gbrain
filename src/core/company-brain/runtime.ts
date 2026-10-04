import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { performSync } from '../../commands/sync.ts';
import { checkApprovedSchemaForEngine } from '../schema-pack/engine-resolution.ts';
import { withRefreshingLock } from '../db-lock.ts';
import { inspectCompanyBrain, validateCompanyBrainPlan } from './inspection.ts';
import { companyBrainGraphStamp, verifyCompanyBrain } from './verification.ts';
import { loadLinkPageMetadata } from '../link-reconciliation.ts';
import { digest } from '../persistence/digest.ts';
import { assertCompanyBrainPolicy, assertCompanyBrainExtractor, companyBrainPolicyFingerprint, companyBrainRepository } from './policy.ts';
import { admitCompanyBrain, assertCompanyBrainCaller, checkCompanyBrainDestination, ingestionFence, ownerStatusFix, reinspectFix, sourceStatusFix,
  type CompanyBrainConnectInput, type CompanyBrainDestination } from './admission.ts';
import { companyBrainProfile, getCompanyBrainProfile, readCompanyBrainPlan, withCompanyBrainSync } from './profile.ts';
import type { CompanyBrainSyncContext } from './profile.ts';
import { beginSourceIngestionReceipt, getSourceIngestionReceipt, linkSourceIngestionCheckpoints, transitionSourceIngestionReceipt,
  recordSourceIngestionOutcome, type SourceIngestionReceipt, type SourceIngestionMutation } from './receipts.ts';
import { reconcileSourceLinks } from '../link-reconciliation.ts';
import { readCompanyBrainEvidence, type CompanyBrainEvidence } from './evidence.ts';

export { previewCompanyBrain, admitCompanyBrain } from './admission.ts';
export type { CompanyBrainPreview, CompanyBrainConnectInput, CompanyBrainDestination } from './admission.ts';
export interface CompanyBrainResult {
  ok: boolean;
  code: string;
  receipt: SourceIngestionReceipt;
  sync?: SyncResult;
  evidence?: CompanyBrainEvidence;
}

function resumeFix(input: CompanyBrainDestination, why: string): Action {
  return { argv: ['gbrain', 'sync', '--brain', input.brainId, '--source', input.sourceId, '--no-embed', '--no-pull'], consent: [], actor: 'agent', why, requires_exclusive: false,
    verify: { argv: ['gbrain', 'sources', 'status', '--brain', input.brainId, '--json'] } };
}

function resumeCommand(input: CompanyBrainDestination): string {
  return `gbrain sync --brain ${input.brainId} --source ${input.sourceId} --no-embed --no-pull`;
}

export async function connectCompanyBrain(engine: BrainEngine, input: CompanyBrainConnectInput): Promise<CompanyBrainResult> {
  const admitted = await admitCompanyBrain(engine, input);
  return resumeCompanyBrain(engine, input, {}, admitted);
}

export async function resumeCompanyBrain(engine: BrainEngine, input: CompanyBrainDestination, opts: SyncOpts = {}, expected?: Awaited<ReturnType<typeof admitCompanyBrain>>): Promise<CompanyBrainResult> {
  assertCompanyBrainCaller(input);
  if (opts.workingTree || opts.noSchemaPack || opts.includeGitignored || opts.skipFailed || opts.srcSubpath ||
    opts.strategy && opts.strategy !== 'markdown' || opts.exclude?.length || opts.includeHidden?.length) {
    throw opError('profile_incompatible', 'The connected source uses its approved committed selection and schema; inspect a new selection instead of overriding its sync policy.',
      `Run ${resumeCommand(input)} without working-tree, schema-pack, ignored-file, skip-failed, strategy, exclude, or subpath overrides. A different selection needs a new inspection and a separately approved connection.`,
      { fix: resumeFix(input, `Syncs source ${input.sourceId} with its approved committed selection and schema.`) });
  }
  return withRefreshingLock(engine, `company-brain:${input.sourceId}`, signal => execute(engine, input, { ...opts,
    signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal }, expected));
}

async function execute(engine: BrainEngine, input: CompanyBrainDestination, opts: SyncOpts, expected?: Awaited<ReturnType<typeof admitCompanyBrain>>): Promise<CompanyBrainResult> {
  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string; archived: boolean; config: unknown }>(
    'SELECT incarnation,local_path,archived,config FROM sources WHERE id=$1', [input.sourceId]);
  if (!source || source.archived) {
    throw opError('source_changed', 'The connected source is unavailable.',
      `Source ${input.sourceId} is not registered or is archived in brain ${input.brainId}. Check its status; an archived source must be restored, and a removed one connected again after review.`,
      { fix: sourceStatusFix(input.brainId, `Shows whether source ${input.sourceId} is registered, archived, or missing.`) });
  }
  if (opts.repoPath && realpathSync(resolve(opts.repoPath)) !== source.local_path) {
    throw opError('source_changed', 'The requested path does not match the approved source.',
      `Source ${input.sourceId} is approved for the checkout at ${source.local_path}. Sync it without a different repository path.`,
      { fix: resumeFix(input, `Syncs source ${input.sourceId} from its approved checkout.`) });
  }
  let profile = companyBrainProfile(source.config);
  if (!profile || profile.brainId !== input.brainId) {
    throw opError('destination_not_ready', 'The source does not belong to this approved company destination.',
      profile
        ? `Source ${input.sourceId} was approved for brain ${profile.brainId}, not ${input.brainId}. Run the sync with --brain ${profile.brainId}.`
        : `Source ${input.sourceId} has no company-brain approval in brain ${input.brainId}. Check its status; ordinary sources sync without the company workflow.`,
      { fix: sourceStatusFix(input.brainId, `Shows source ${input.sourceId}'s registration and any ingestion receipt.`) });
  }
  if (expected && (source.incarnation !== expected.sourceIncarnation || profile.receiptId !== expected.receiptId)) {
    throw opError('source_changed', 'The admitted source or receipt changed before execution.',
      `Request ${expected.receiptId} admitted source ${input.sourceId}, but its registration or receipt changed before indexing started. Inspect the receipt before doing anything else; do not reconnect over it.`,
      { fix: sourceStatusFix(input.brainId, `Shows source ${input.sourceId}'s current receipt so you can tell which request owns it.`) });
  }
  let receipt = await getSourceIngestionReceipt(engine, { sourceId: input.sourceId, sourceIncarnation: source.incarnation, receiptId: profile.receiptId });
  if (!receipt || receipt.outcome === 'discarded') {
    throw opError('checkpoint_missing', 'The active source receipt is missing or discarded.',
      `Source ${input.sourceId} has no active ingestion receipt, so gbrain will not resume from a different revision. Check its status; starting over means previewing removal with gbrain sources remove ${input.sourceId} --brain ${input.brainId} --dry-run and reconnecting, a destructive step the user approves.`,
      { fix: sourceStatusFix(input.brainId, `Shows source ${input.sourceId}'s receipt state (missing, discarded, or incomplete).`) });
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  assertCompanyBrainPolicy(profile, receipt, brain?.brain_id, source.local_path);
  assertCompanyBrainExtractor(receipt.extractorVersion, input);
  const policyFingerprint = companyBrainPolicyFingerprint(profile, input.sourceId);
  let plan = receipt.outcome === 'complete'
    ? await inspectCompanyBrain({ path: source.local_path, profile: 'company-brain', include: profile.selection.include, exclude: profile.selection.exclude, limits: profile.limits })
    : await readCompanyBrainPlan(engine, receipt.id);
  if (receipt.outcome !== 'complete') {
    if (plan.plan_digest !== profile.planDigest || plan.revision?.commit !== receipt.approvedRevision || plan.schema?.resolved_digest !== receipt.schemaFingerprint) {
      throw opError('plan_stale', 'The stored plan does not match the active ingestion receipt.',
        `Source ${input.sourceId}'s stored plan disagrees with receipt ${receipt.id}. Check the receipt and inspect ${source.local_path} again; do not edit stored approval fields to make them match.`,
        { fix: sourceStatusFix(input.brainId, `Shows receipt ${receipt.id}'s approved revision and outstanding phase.`) });
    }
    const validation = await validateCompanyBrainPlan(plan, { path: source.local_path, mode: 'resume' });
    if (!validation.valid) {
      throw opError(validation.code as RegistryCode, 'The approved source or schema changed; inspect it before resuming.',
        `The checkout at ${source.local_path} no longer matches approved commit ${receipt.approvedRevision} or its schema. Inspect it; gbrain never substitutes current HEAD, so a missing commit or changed schema needs a new reviewed connection.`,
        { fix: reinspectFix(source.local_path) });
    }
  }
  const schema = profile.schema;
  if (plan.revision && digest(companyBrainRepository(plan.revision)) !== digest(profile.repository)) {
    throw opError('source_changed', 'The approved repository identity changed; reconnect explicitly.',
      `The checkout at ${source.local_path} is no longer the repository approved for source ${input.sourceId}. Restore the original checkout, or preview removal with gbrain sources remove ${input.sourceId} --brain ${input.brainId} --dry-run and reconnect once the user approves.`,
      { fix: sourceStatusFix(input.brainId, `Shows source ${input.sourceId}'s approved revision and receipt.`) });
  }
  const { pack } = await checkApprovedSchemaForEngine(engine, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest },
    { sourceId: input.sourceId, remote: false });
  const fence = await ingestionFence(engine, input.sourceId);
  const mutation = (): SourceIngestionMutation => ({ receiptId: receipt!.id, sourceId: input.sourceId, sourceIncarnation: source.incarnation,
    expectedRevision: receipt!.revision, expectedPhase: receipt!.phase, fence });
  if (receipt.outcome === 'complete') {
    const fresh = plan;
    if (!fresh.ready) {
      throw opError('source_not_ready', 'The current committed source is not ready; inspect its findings before syncing.',
        `The latest commit in ${source.local_path} has blocking findings. Inspect it, fix or exclude what it reports and commit, then sync source ${input.sourceId} again; the last verified import stays in place.`,
        { fix: reinspectFix(source.local_path) });
    }
    if (fresh.revision!.commit === receipt.approvedRevision && !opts.full) return { ok: true, code: 'complete', receipt,
      evidence: await readCompanyBrainEvidence(engine, input.sourceId) };
    await checkCompanyBrainDestination(engine, { ...input, path: source.local_path, plan: fresh }, false);
    if (opts.dryRun) return { ok: true, code: 'dry_run', receipt };
    await engine.transaction(async tx => {
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      const [current] = await tx.executeRaw<{ config: unknown; local_path: string }>('SELECT config,local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid AND NOT archived FOR UPDATE', [input.sourceId, source.incarnation]);
      if (!current || companyBrainProfile(current.config)?.receiptId !== receipt!.id) {
        throw opError('source_changed', 'The source approval changed.',
          `Another connect or sync changed source ${input.sourceId}'s approval while this sync ran, and this step rolled back. Check the receipt, then run ${resumeCommand(input)} again.`,
          { fix: sourceStatusFix(input.brainId, `Shows which receipt now owns source ${input.sourceId}.`) });
      }
      assertCompanyBrainPolicy(companyBrainProfile(current.config)!, receipt!, brain.brain_id, current.local_path);
      assertCompanyBrainExtractor(receipt!.extractorVersion, input);
      const nextId = randomUUID();
      const next = await beginSourceIngestionReceipt(tx, { id: nextId, sourceId: input.sourceId, sourceIncarnation: source.incarnation,
        approvedRevision: fresh.revision!.commit, profile: 'company-brain', schemaFingerprint: fresh.schema!.resolved_digest, extractorVersion: fresh.extractor_version, policyFingerprint, fence });
      receipt = await linkSourceIngestionCheckpoints(tx, { ...mutation(), receiptId: nextId, expectedRevision: next.revision, expectedPhase: next.phase,
        checkpoints: [{ op: 'company-brain-plan', fingerprint: nextId, kind: 'manifest' }] });
      profile = { ...profile!, receiptId: nextId, planDigest: fresh.plan_digest, approvedRevision: fresh.revision!.commit };
      await tx.executeRaw("UPDATE sources SET config=jsonb_set(config,'{company_brain}',$3::text::jsonb) WHERE id=$1 AND incarnation=$2::uuid",
        [input.sourceId, source.incarnation, JSON.stringify(profile)]);
      await tx.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('company-brain-plan',$1,$2::text::jsonb)", [nextId, JSON.stringify([fresh])]);
    });
    plan = fresh;
  }
  if (opts.dryRun) return { ok: true, code: 'dry_run', receipt };
  let sync: SyncResult | undefined;
  try {
    if (receipt.phase === 'ADMITTED') receipt = await transitionSourceIngestionReceipt(engine, { ...mutation(), phase: 'CONTENT', counts: {
      eligibleFiles: plan.counts.included, skippedFiles: plan.counts.excluded + plan.counts.unsupported } });
    if (receipt.phase === 'CONTENT') {
      const context: CompanyBrainSyncContext = { sourceId: input.sourceId, sourceIncarnation: source.incarnation, receiptId: receipt.id, plan, pack,
        entries: new Map(plan.manifest.map(entry => [entry.path, entry])), policyFingerprint,
        protect: async checkpoints => { receipt = await linkSourceIngestionCheckpoints(engine, { ...mutation(), checkpoints }); } };
      sync = await withCompanyBrainSync(context,
      () => performSync(engine, { ...opts, sourceId: input.sourceId, repoPath: source.local_path, noEmbed: true, noPull: true, noExtract: true,
        workingTree: false, noSchemaPack: false, concurrency: 1 }));
      if (!['synced', 'first_sync', 'up_to_date'].includes(sync.status) || sync.failedFiles) {
        receipt = await recordSourceIngestionOutcome(engine, { ...mutation(), outcome: 'incomplete', diagnostic: 'content_incomplete',
          counts: { failedFiles: sync.failedFiles ?? 0, pendingWrites: sync.reason === 'writer_pending' ? 1 : 0 } });
        return { ok: false, code: context.failureCode ?? sync.failureCodes?.[0]?.code ?? 'content_incomplete', receipt, sync };
      }
      receipt = await transitionSourceIngestionReceipt(engine, { ...mutation(), phase: 'GRAPH', counts: { importedPages: plan.counts.included, failedFiles: 0, pendingWrites: 0 } });
    }
    if (receipt.phase === 'GRAPH' || receipt.phase === 'VERIFY' && receipt.diagnostic === 'verification_failed') {
      const graphPhase = receipt.phase;
      const key = receipt.id;
      receipt = await linkSourceIngestionCheckpoints(engine, { ...mutation(), checkpoints: [{ op: 'company-brain-graph', fingerprint: key, kind: 'graph' }] });
      const [cursor] = await engine.executeRaw<{ completed_keys: string[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='company-brain-graph' AND fingerprint=$1", [key]);
      let afterSlug = graphPhase === 'VERIFY' ? undefined : cursor?.completed_keys[0];
      while (graphPhase === 'VERIFY' || cursor?.completed_keys[1] !== 'complete') {
        opts.signal?.throwIfAborted();
        const graph = await reconcileSourceLinks(engine, input.sourceId, { pack: pack.manifest, afterSlug, limit: 250, expectedSourceIncarnation: source.incarnation });
        if (!graph.ok || graph.failures.length) {
          throw opError('graph_incomplete', 'Source relationship reconciliation is incomplete.',
            `Resume with ${resumeCommand(input)}; graph reconciliation continues from receipt ${receipt.id}'s checkpoint.`,
            { fix: resumeFix(input, `Resumes source ${input.sourceId}'s graph phase from its checkpoint.`) });
        }
        const counts = receipt.counts;
        receipt = await engine.transaction(async tx => {
          const next = await transitionSourceIngestionReceipt(tx, { ...mutation(), phase: graphPhase, counts: {
            graphPages: counts.graphPages + graph.pagesProcessed, links: counts.links + graph.linksCreated,
            unresolvedLinks: counts.unresolvedLinks + graph.unresolved.length } });
          await tx.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('company-brain-graph',$1,$2::text::jsonb) ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()", [key, JSON.stringify([graph.nextAfterSlug ?? '', graph.complete ? 'complete' : 'more'])]);
          return next;
        });
        if (graph.complete) break;
        if (!graph.nextAfterSlug || graph.nextAfterSlug === afterSlug) {
          throw opError('graph_incomplete', 'Graph reconciliation did not advance.',
            `Check source ${input.sourceId}'s receipt, then resume with ${resumeCommand(input)}; if it stalls at the same point again, run gbrain doctor --brain ${input.brainId} --json and report it to the user.`,
            { fix: sourceStatusFix(input.brainId, `Shows receipt ${receipt.id}'s graph counts and outstanding phase.`) });
        }
        afterSlug = graph.nextAfterSlug;
      }
      receipt = await transitionSourceIngestionReceipt(engine, { ...mutation(), phase: 'VERIFY' });
    }
    const verified = await verifyCompanyBrain(engine, input.sourceId, plan, pack, opts.signal);
    const failures = verified.failures;
    const [pending] = await engine.executeRaw<{ count: string }>("SELECT count(*)::text AS count FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')", [input.sourceId]);
    const pendingWrites = Number(pending?.count ?? 0);
    if (failures || pendingWrites) {
      receipt = await recordSourceIngestionOutcome(engine, { ...mutation(), outcome: 'incomplete', diagnostic: failures ? 'verification_failed' : 'pending_writes', counts: { verificationFailures: failures, pendingWrites } });
      return { ok: false, code: receipt.diagnostic!, receipt, sync };
    }
    let evidence: CompanyBrainEvidence | undefined;
    receipt = await engine.transaction(async tx => {
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE');
      if (fence.mode === 'managed') await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [fence.worktreeId]);
      await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [input.sourceId]);
      await tx.executeRaw("SELECT key FROM config WHERE key='schema_pack' FOR SHARE");
      await checkApprovedSchemaForEngine(tx, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest }, { sourceId: input.sourceId, remote: false });
      await tx.lockPageKeys(verified.metadata.map(page => ({ sourceId: input.sourceId, slug: page.slug })));
      if (digest(await loadLinkPageMetadata(tx, input.sourceId)) !== digest(verified.metadata) || await companyBrainGraphStamp(tx, input.sourceId) !== verified.graphStamp) {
        throw opError('verification_failed', 'Source content or relationships changed during verification.',
          `Another write touched source ${input.sourceId} while it was being verified, so completion was not recorded. Resume with ${resumeCommand(input)} to verify again.`,
          { fix: resumeFix(input, `Re-runs verification for source ${input.sourceId} against its approved commit.`) });
      }
      const [pending] = await tx.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering') LIMIT 1", [input.sourceId]);
      if (pending) {
        throw opError('pending_writes', 'A pending source write prevents verified completion.',
          `Source ${input.sourceId} has a queued or running write. Check the source's writer, let the write finish, then resume with ${resumeCommand(input)}.`,
          { fix: ownerStatusFix(input.sourceId) });
      }
      evidence = await readCompanyBrainEvidence(tx, input.sourceId);
      return recordSourceIngestionOutcome(tx, { ...mutation(), outcome: 'complete', contentCommitted: true, graphCommitted: true, verificationPassed: true,
        counts: { verificationFailures: 0, pendingWrites: 0, graphPages: verified.metadata.length, links: verified.links, unresolvedLinks: verified.unresolvedLinks } });
    });
    return { ok: true, code: 'complete', receipt, sync, evidence };
  } catch (error) {
    const code = error instanceof OperationError ? error.code : 'operation_failed';
    receipt = await recordSourceIngestionOutcome(engine, { ...mutation(), outcome: 'incomplete', diagnostic:
      code === 'graph_incomplete' ? 'graph_incomplete' : receipt.phase === 'VERIFY' ? 'verification_failed' : 'interrupted' });
    return { ok: false, code, receipt, sync };
  }
}

export async function performCompanyBrainSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  const profile = await getCompanyBrainProfile(engine, opts.sourceId!);
  if (!profile) {
    throw opError('profile_incompatible', 'The source company profile is missing.',
      `Source ${opts.sourceId} has no company-brain approval, so it cannot be synced as a company source. Check its registration in source status.`,
      { fix: readFix(`Shows source ${opts.sourceId}'s registration and any ingestion receipt.`, { argv: ['gbrain', 'sources', 'status', '--json'] }) });
  }
  const result = await resumeCompanyBrain(engine, { brainId: profile.brainId, sourceId: opts.sourceId!, remote: false }, opts);
  return { fromCommit: null, toCommit: result.receipt.approvedRevision,
    added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], ...result.sync,
    ...(!result.ok ? { status: 'blocked_by_failures' as const, failedFiles: Math.max(1, result.receipt.counts.failedFiles), failureCodes: [{ code: result.code, count: 1 }] } : { status: opts.dryRun ? 'dry_run' as const : 'synced' as const }) };
}
