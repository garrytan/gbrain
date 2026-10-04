/**
 * Embedding-migration operation cluster — peeled from operations.ts
 * (v0.46.x tranche 3): the #3390 provider-agnostic migrate_embeddings
 * local-only admin op, consuming the SAME orchestrator as the CLI
 * (planMigrationFlow/executeMigrationFlow — locks, retarget gate,
 * DB-verified skip, reranker companion, heartbeat, completion bookkeeping
 * are identical on both surfaces by construction). Op const stays
 * module-private; `embeddingMigrationOperations` below is spliced into the
 * canonical `operations` array in ../operations.ts at the cluster's
 * original position. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { hostOnlyError } from './op-fix.ts';

// --- #3390: provider-agnostic embedding migration ---

const migrate_embeddings: Operation = {
  name: 'migrate_embeddings',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Re-embed the brain onto a different embedding provider/model: schema dimension transition, NULL-signature invalidation, query-cache purge, resumable re-embed. Without yes=true returns the plan + cost estimate only. Local-only admin op; the primary surface is `gbrain migrate embeddings`.',
  params: {
    to: { type: 'string', required: true, description: 'Target provider:model (e.g. openai:text-embedding-3-small).' },
    dim: { type: 'number', description: "Target dimensions. Defaults to the provider recipe's declared width; required when the recipe declares none." },
    dry_run: { type: 'boolean', description: 'Plan + cost estimate only; change nothing.' },
    yes: { type: 'boolean', description: 'Confirm the re-embed spend + destructive schema change. Required for a live run.' },
    max_cost_usd: { type: 'number', description: 'Finite total paid authorization. Required for new work and must cover plan.worst_case_authorization (else refused with embedding_budget_below_worst_case before any change); requests settle to reported usage, resume preserves debits. Increase explicitly to renew.' },
    retarget: { type: 'boolean', description: 'Abandon a DIFFERENT in-flight migration target and start this one (the abandoned target is recorded in the marker history).' },
    reranker: { type: 'string', description: 'Reranker companion action: auto (default), off, keep, or an explicit provider:model (e.g. voyage:rerank-2.5). Reranker config lives on the DB plane.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true, cliOnly: { argv: ['gbrain', 'migrate', 'embeddings', '--to', '<model>'] },
  handler: async (ctx, p) => {
    // Belt-and-braces on top of localOnly (the get_recent_transcripts
    // pattern): a schema-rebuilding, money-spending op must never be
    // reachable from a remote transport even if a future dispatch path
    // forgets the localOnly filter.
    if (ctx.remote !== false) {
      const to = typeof p.to === 'string' && /^[a-z0-9_-]+:[A-Za-z0-9._/-]+$/.test(p.to) ? ['--to', p.to] : [];
      const brain = ctx.brainId && ctx.brainId !== 'host' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ctx.brainId) ? ['--brain', ctx.brainId] : [];
      throw hostOnlyError(ctx, 'permission_denied', 'migrate_embeddings is local-only. Run `gbrain migrate embeddings` on the host.',
        ['gbrain', ...brain, 'migrate', 'embeddings', ...to, '--dry-run'],
        'Re-embedding rebuilds the vector schema and spends provider money, so only the trusted CLI on the brain host runs it; the dry run prints the plan and cost first.',
        { consent: [] });
    }
    // ONE shared orchestrator with the CLI (round-2 #11): locks, retarget
    // gate, DB-verified skip, heartbeat, and completion bookkeeping are
    // identical on both surfaces by construction.
    const { planMigrationFlow, executeMigrationFlow, EMBEDDING_MIGRATION_RECOVERY: recovery } = await import('../../commands/migrate-embeddings.ts');
    const to = p.to as string;
    const dim = p.dim as number | undefined;
    const planCtx = await planMigrationFlow(ctx.engine, {
      to,
      ...(dim !== undefined && { dim }),
      ...(typeof p.reranker === 'string' && { reranker: p.reranker }),
    });
    const plan = planCtx.plan;
    // Different-target in-flight marker: the retarget decision precedes any
    // skip (mirrors the CLI ordering exactly — shared-orchestrator parity).
    if (planCtx.inflightOther && p.retarget !== true && p.dry_run !== true && !ctx.dryRun) {
      return { status: 'refused', reason: 'retarget_required', inflight: planCtx.inflightOther, plan, recovery };
    }
    if (planCtx.verify.complete && !planCtx.inflightOther && planCtx.rerankerPlan.action.kind === 'none') {
      return { status: 'skipped_no_work', plan, verified: planCtx.verify };
    }
    if (ctx.dryRun || p.dry_run === true || p.yes !== true) {
      return {
        status: p.yes === true || p.dry_run === true ? 'planned' : 'needs_confirmation',
        plan,
        verified: planCtx.verify,
      };
    }
    const result = await executeMigrationFlow(ctx.engine, planCtx, {
      to,
      maxCostUsd: p.max_cost_usd as number | undefined,
      ...(dim !== undefined && { dim }),
      ...(p.retarget === true && { retarget: true }),
      ...(typeof p.reranker === 'string' && { reranker: p.reranker }),
      quiet: true,
    });
    // Flatten the orchestrator's tagged union into the op's historical shape:
    // failures carry a `reason`, refusals carry `status:'refused'` + a reason
    // discriminator (the env refusal keeps its pre-orchestrator spelling so
    // existing consumers keying on reason:'env_override' still match).
    if (result.status === 'probe_failed') return { status: 'failed', reason: result.message, plan, recovery };
    if (result.status === 'apply_failed') return { status: 'failed', reason: result.reason, plan, recovery };
    // A held lock keeps its discriminator (holder: migration vs embed_backfill)
    // — remote callers need it to pick the right remediation, same as the CLI.
    if (result.status === 'locked') {
      return { status: 'locked', holder: result.holder, detail: result.detail, plan, recovery };
    }
    if (result.status === 'refused_env') {
      return { status: 'refused', reason: 'env_override', warning: result.warning, plan, recovery };
    }
    if (result.status === 'refused_budget') {
      return { status: 'refused', reason: result.refusal.error, ...result.refusal, plan, recovery };
    }
    if (result.status === 'refused_retarget') {
      return {
        status: 'refused',
        reason: 'retarget_required',
        inflight: result.inflight,
        plan,
        recovery,
      };
    }
    return { ...result, plan, ...(result.status === 'incomplete' && { recovery }) };
  },
  cliHints: { name: 'migrate-embeddings', hidden: true },
};

export const embeddingMigrationOperations: Operation[] = [migrate_embeddings];
