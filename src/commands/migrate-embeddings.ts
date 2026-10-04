import type { BrainEngine } from '../core/engine.ts';
import { currentExitCode } from '../core/cli-force-exit.ts';
import { consentGate, engineConsentEnv } from '../core/consent-cli.ts';
import { serr, slog } from '../core/console-prefix.ts';
import {
  planEmbeddingMigration,
  applyEmbeddingMigration,
  completeEmbeddingMigration,
  reconcilePageSignatures,
  verifyMigrationComplete,
  readMigrationState,
  detectEnvPresence,
  detectEnvOverride,
  envFullyPinsTarget,
  migrationSignature,
  renderResumeCommand,
  formatEnvOverrideWarning,
  resolveRerankerPlan,
  applyRerankerAction,
  readMigrationStatus,
  verifySearchRoundTrip,
  MIGRATION_STATE_KEY,
  DEFERRED_ANN_TABLES,
  type EmbeddingMigrationPlan,
  type MigrationVerify,
  type MigrationState,
  type EnvOverrideWarning,
  type RerankerPlan,
  type VerifySearchOutcome,
} from '../core/embedding-migration.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../core/db-lock.ts';
import { embedBackfillLockId, EMBED_BACKFILL_LOCK_TTL_MIN } from '../core/embed-backfill-lock.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS, hnswIndexExpected } from '../core/vector-index.ts';
import { annIndexValidity, buildDeferredAnnIndexes, canonicalChunkAnnIndex, mergeDeferredAnnIndexes, parseDeferredAnnIndexes } from '../core/embedding-ann-build.ts';
import { redactPgUrl } from '../core/url-redact.ts';
import { runEmbedCore, type EmbedResult, type parsePaceArgs } from './embed.ts';
import { parseMigrateEmbeddingsFlags } from '../core/embedding-migration-cli.ts';
export { parseMigrateEmbeddingsFlags, type MigrateEmbeddingsFlags } from '../core/embedding-migration-cli.ts';
import { prepareEmbeddingProjections } from '../core/embedding-readiness.ts';
import { assertRetainedEmbeddingRebuildability } from '../core/embedding-migration-retention.ts';
import { embedStaleFacts } from '../core/embed-facts.ts';
import { countStaleFactEmbeddings } from '../core/facts/embedding-identity.ts';
import { authorizeMigrationBudget, assertMigrationLeases, ceilCents, MigrationBudgetRefusal, type MigrationBudgetRefusalDetails, type MigrationWorstCase } from '../core/embedding-migration-budget.ts';
import { planMigrationWorstCase, MIGRATION_PROBE_TEXT, RERANKER_PROBE } from '../core/embedding-migration-worst-case.ts';
import { withAIInvocationGuard } from '../core/ai/invocation-guard.ts';

/**
 * Brain-wide migration lock (round-2 #4): serializes whole migrations so two
 * concurrent runs can't race marker writes + DDL through the read-then-write
 * window (per-source embed locks don't cover empty brains, which lock zero
 * sources). Same DbLock machinery + TTL as the embed backfill locks.
 */
export const GLOBAL_MIGRATION_LOCK_ID = 'gbrain-embedding-migration';

export const EMBEDDING_MIGRATION_RECOVERY = {
  status_command: 'gbrain migrate embeddings --status --json',
  docs: 'https://github.com/garrytan/gbrain/blob/master/docs/guides/embedding-migration.md#recovery',
  partial_state: 'Previously committed progress and authorization debits may remain.',
  action: 'Inspect the selected brain using the same --brain selection before retrying. Do not blindly retry or reset the migration marker.',
  authorization: 'Increasing --max-cost-usd renews authorization for a larger total cap; it does not reset prior debits.',
} as const;

function printHelp(): void {
  process.stdout.write(`Usage: gbrain migrate embeddings --to <provider:model> [flags]

Re-embed the whole brain onto a different embedding provider/model. Handles
dimension changes (schema transition), pages without a recorded embedding
signature (#3391), the query cache, and resume-after-kill.
This operation is brain-wide: --source and --slugs are unsupported.

Flags:
  --to <provider:model>   Target embedding model (e.g. openai:text-embedding-3-small).
  --dim <N>               Target dimensions. Defaults to the provider recipe's
                          declared width; required when the recipe declares none.
  --dry-run               Plan + cost estimate only; change nothing.
  --yes                   The user's approval (paid + destructive); without it a
                          non-interactive run changes nothing and exits 3.
  --max-cost-usd <USD>    Total durable authorization; must cover the printed worst case (or the run
                          refuses before any change). Requests settle to reported usage; raise to renew.
  --json                  Machine-readable envelope on stdout.
  --no-embed              Apply schema + config + invalidation, but skip the
                          re-embed pass. Inspect --status, then rerun this migration
                          without --no-embed using the same cap; prior debits remain.
  --batch-size <N>        Stale-chunk batch size, integer 1..10000 (default 2000).
  --pace[=mode]           DB-contention pacing for the re-embed (off|gentle|balanced|aggressive).
  --pace-max-concurrency <N>  Positive integer pacing cap; also accepts =N.
  --ignore-env-override   Proceed even when GBRAIN_EMBEDDING_* env vars would
                          override the target at runtime (you know why).
  --retarget              Abandon a DIFFERENT in-flight migration target and
                          start this one (the refusal message names both the
                          resume and retarget commands).
  --reranker <v>          Reranker companion action: auto (default; switch to
                          the target provider's reranker when the current one
                          is exposed by this migration), off (disable
                          reranking), keep (leave it), or an explicit
                          provider:model (e.g. voyage:rerank-2.5). Reranker
                          config lives on the DB plane, unlike embedding
                          config (file/env planes).
  --status                Read-only migration status: config planes (env/file/DB,
                          key PRESENCE only), column widths, NULL censuses,
                          signature census, in-flight marker + exact resume
                          command, last completion + smoke-check outcome.
  --help                  Show this help.

A killed run may retain committed progress and debits. Inspect the selected brain
before resuming: ${EMBEDDING_MIGRATION_RECOVERY.status_command}
Only documented controls are accepted. --timeout and work/scope restrictions are
unsupported. Use separate values except for the documented --pace forms and globals.
Recovery guide: ${EMBEDDING_MIGRATION_RECOVERY.docs}
`);
}

function renderPlan(ctx: MigrationPlanContext): string {
  const { plan, verify, envPresence, envMatchesTarget, identity, concurrentWriters } = ctx;
  const lines: string[] = [];
  lines.push('Embedding migration plan');
  // Wrong-brain visibility: which database this run is actually pointed at.
  lines.push(`  Brain: ${identity.engine} (${identity.target}); scope: brain-wide (all sources)`);
  lines.push(`  From: ${plan.from_model} (${plan.from_dims}d${plan.column_dims !== null && plan.column_dims !== plan.from_dims ? `; column is actually ${plan.column_dims}d` : ''})`);
  lines.push(`  To:   ${plan.to_model} (${plan.to_dims}d)`);
  lines.push(`  Work: ${plan.chunks_to_embed} chunks to embed, ${plan.chunks_to_restamp} to restamp, ${plan.facts_to_embed ?? 0} active facts, ${plan.takes_to_embed ?? 0} active takes; ${plan.blocked_projection_pages ?? 0} projection-blocked pages.`);
  lines.push('  Paid authorization: --max-cost-usd is a durable total cap; each attempt reserves its maximum input size and settles to reported usage; unknown prices refuse.');
  // DB-reality census: what pages say they were embedded with (env can lie
  // about From; the census cannot).
  if (plan.signature_census.length > 0) {
    const census = plan.signature_census
      .map((c) => `${c.signature ?? '(none recorded)'}: ${c.pages}`)
      .join(', ');
    lines.push(`  Page signatures: ${census}`);
  }
  if (envPresence.present) {
    if (envMatchesTarget) {
      lines.push('  NOTICE: GBRAIN_EMBEDDING_* env vars pin this target and override the file');
      lines.push('          plane at runtime. The migration also writes the file plane — keep the');
      lines.push('          env in sync (or unset it) so every gbrain process agrees.');
    } else {
      lines.push('  WARNING: GBRAIN_EMBEDDING_* env vars are set and do not fully pin the target —');
      lines.push('          a live run refuses when they contradict it (see the env-override box).');
    }
  }
  if (plan.dim_change) {
    const hasVectors = plan.column_dims !== null;
    if (hasVectors) {
      lines.push(`  DESTRUCTIVE: the embedding column is rebuilt at ${plan.to_dims}d, which DELETES`);
      lines.push('          every stored embedding vector in this brain. They are not recoverable —');
      lines.push('          going back to the old provider means paying for a second full re-embed.');
      lines.push('          Until the re-embed finishes, semantic search is degraded to lexical-only.');
      lines.push(`          The query cache and fact embeddings are rebuilt at ${plan.to_dims}d too`);
      lines.push('          (cache refills on next query; active facts are repaired by this migration).');
    } else {
      // Absent/unreadable column: nothing stored to lose, but the DDL still
      // runs — say so instead of silently skipping the warning (dim-honesty).
      lines.push(`  Schema: the embedding column will be (re)built at ${plan.to_dims}d (no stored`);
      lines.push('          vectors were detected, so nothing is deleted).');
    }
    if (plan.to_dims > PGVECTOR_HNSW_VECTOR_MAX_DIMS) {
      lines.push(`  Note: pgvector HNSW indexes cap at ${PGVECTOR_HNSW_VECTOR_MAX_DIMS}d — at ${plan.to_dims}d no ANN index is`);
      lines.push('          created and vector search runs as an exact scan (slower on large brains).');
    }
  }
  if (ctx.customSearchColumn) {
    lines.push(`  WARNING: search_embedding_column is '${ctx.customSearchColumn}', not 'embedding'. This migration`);
    lines.push("          rebuilds the default 'embedding' column only — the read path keeps using");
    lines.push(`          '${ctx.customSearchColumn}' (see doctor's embedding_column_registry check).`);
  }
  lines.push(`  Chunks to re-embed: ${plan.chunks_to_embed}${plan.null_signature_chunks > 0 ? ` (includes ${plan.null_signature_chunks} on pages with no recorded embedding signature)` : ''}`);
  if (plan.chunks_to_restamp > 0) {
    lines.push(`  Chunks to restamp: ${plan.chunks_to_restamp} (their vectors are already in the target space;`);
    lines.push('          only the page signature is updated, with no provider call or cost).');
  }
  if (plan.false_stamped_chunks > 0) {
    lines.push(`  False stamps: ${plan.false_stamped_chunks} embedded chunk(s) carry a non-target model under pages`);
    lines.push('          already stamped with the target signature — the run clears those stamps');
    lines.push('          and re-embeds them (chunk model is the ground truth, not the page stamp).');
  }
  if (plan.synopsis_tier_pages > 0) {
    lines.push(`  Context tier: ${plan.synopsis_tier_pages} page(s) currently embedded at the per_chunk_synopsis`);
    lines.push('          tier will re-embed at the TITLE tier (a retrieval-quality downgrade for');
    lines.push('          those pages; tier-preserving re-embed is a filed follow-up).');
  }
  lines.push(
    plan.price_known
      ? `  Estimated cost: $${plan.est_cost_usd.toFixed(2)} (${plan.total_chars} chars at the ${plan.to_model} rate)`
      : `  Estimated cost: unknown — no pricing entry for ${plan.to_model}. Check the provider's pricing before proceeding.`,
  );
  const worst = plan.worst_case_authorization;
  lines.push(worst.usd === null
    ? `  Worst-case authorization: unknown (${worst.requests} request(s); no price for ${plan.to_model}); paid dispatch refuses until priced.`
    : `  Worst-case authorization: $${ceilCents(worst.usd).toFixed(2)} (${worst.requests} request(s) at maximum input size; retries and batch splits settle from the same headroom).`);
  const unpricedReranker = worst.unpriced_models.filter(m => m !== plan.to_model);
  if (worst.usd !== null && unpricedReranker.length) {
    lines.push(`  WARNING: reranker ${unpricedReranker.join(', ')} has no price; its probe refuses without dispatch and the switch is reported as failed. The worst case above covers embeddings only.`);
  }
  if (worst.usd !== null && worst.prior_debited_usd > 0) {
    lines.push(`  Prior debits: $${worst.prior_debited_usd.toFixed(4)} retained; --max-cost-usd must be at least $${ceilCents(worst.usd + worst.prior_debited_usd).toFixed(2)}.`);
  }
  if (plan.resuming) {
    lines.push('  Resuming: a prior migration to this target was interrupted; continuing it.');
  }
  if (concurrentWriters.workers > 0 || concurrentWriters.embedJobs > 0) {
    lines.push(`  WARNING: ${concurrentWriters.workers} live minion worker(s) and ${concurrentWriters.embedJobs} waiting/running`);
    lines.push('          embed job(s) detected. Generic embed/cycle jobs do not take the migration');
    lines.push('          locks — stop the worker (or let the queue drain) first, or their writes');
    lines.push('          will be counted stale by the final census and re-embedded.');
  }
  const rr = ctx.rerankerPlan;
  if (rr.action.kind === 'switch') {
    lines.push(`  Also switching search.reranker.model -> ${rr.action.to} (DB plane — unlike`);
    lines.push('          embedding config, which lives in the file plane). Probed live before the write.');
  } else if (rr.action.kind === 'disable') {
    lines.push('  Also disabling reranking (search.reranker.enabled false).');
  } else if (rr.action.suggestion !== null) {
    lines.push(`  ACTION: the target provider ships no reranker; the exposed reranker stays on`);
    lines.push(`          ${rr.exposed?.model ?? 'the current model'}. Switch or disable it yourself:`);
    lines.push(`            gbrain config set search.reranker.model ${rr.action.suggestion}`);
    lines.push('            gbrain config set search.reranker.enabled false');
  } else if (plan.reranker_warning) {
    lines.push(`  WARNING: ${plan.reranker_warning}`);
  }
  if (!verify.complete && verify.blockers.length > 0) {
    lines.push('  Outstanding work:');
    for (const b of verify.blockers) lines.push(`    - ${b}`);
  }
  return lines.join('\n');
}

/** One home for the retarget-refusal copy (pre-plan gate + in-lock gate). */
function printRetargetRefusal(state: MigrationState): void {
  serr(`Refusing: a migration to ${state.to_model} (${state.to_dims}d) started ${state.started_at} is still in flight.`);
  serr(`  Resume it:   ${renderResumeCommand(state)}`);
  serr(`  Abandon it:  re-run this command with --retarget (the abandoned target is recorded in the marker history)`);
}

/** One home for the dense schema/invalidation/cache summary line. */
function renderApplySummary(
  result: { schema_transitioned: boolean; pinned_repaired: string[]; invalidated: number; cache_cleared: number },
  plan: EmbeddingMigrationPlan,
): string {
  const schema = result.schema_transitioned
    ? `rebuilt at ${plan.to_dims}d`
    : result.pinned_repaired.length > 0
      ? `repaired (${result.pinned_repaired.join(', ')})`
      : 'unchanged';
  return `  [migrate] schema ${schema}; ${result.invalidated} chunk(s) invalidated; query cache purged (${result.cache_cleared} row(s)).`;
}

function renderRerankerOutcome(outcome: RerankerOutcome): string[] {
  switch (outcome.action) {
    case 'switched':
      return [`  [migrate] reranker switched to ${outcome.to} (DB plane; query cache purged with it).`];
    case 'disabled':
      return ['  [migrate] reranking disabled (search.reranker.enabled false).'];
    case 'switch_failed':
      return [
        `  [migrate] reranker NOT switched — the live probe failed; the previous config was kept:`,
        `            ${outcome.reason ?? 'unknown reason'}`,
        `            Fix the key/model and re-run, or: gbrain config set search.reranker.model ${outcome.to}`,
      ];
    case 'suggested':
      return [
        '  [migrate] ACTION: the exposed reranker was NOT changed (target ships none). Switch or disable it:',
        ...(outcome.suggestion ? [`            gbrain config set search.reranker.model ${outcome.suggestion}`] : []),
        '            gbrain config set search.reranker.enabled false',
      ];
    default:
      return [];
  }
}

/**
 * One tiny embed against the TARGET provider, BEFORE any mutation: validates
 * the API key, the model id, and dimension support in a single call, so a bad
 * target fails with the brain untouched instead of after the column is
 * dropped. Shared by the CLI and the `migrate_embeddings` op (the op used to
 * skip it, which let `yes:true` drop the column against a bad key).
 */
export async function probeTargetProvider(
  toModel: string,
  toDims: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { embed } = await import('../core/ai/gateway.ts');
    const vecs = await embed([MIGRATION_PROBE_TEXT], {
      embeddingModel: toModel,
      dimensions: toDims,
    });
    const got = vecs[0]?.length ?? 0;
    if (vecs.length !== 1 || got !== toDims || !vecs[0].every(Number.isFinite)) {
      return {
        ok: false,
        message: `Target provider returned ${got}-dim vectors, expected ${toDims}. Pass a valid --dim for ${toModel}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: `Preflight embed against ${toModel} failed; no migration invalidation performed. Any authorized request debit is retained for safe resume. Check provider configuration and migration status before retrying.`,
    };
  }
}

/**
 * One tiny rerank call against the TARGET reranker BEFORE the config write
 * (round-2 #11-adjacent C11): an embedding migration must not enable a
 * reranker that can't answer — that would leave every search paying the
 * fail-open timeout. Probe failure keeps the old config and is REPORTED,
 * never silent.
 */
export async function probeTargetReranker(
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { rerank } = await import('../core/ai/gateway.ts');
    const results = await rerank({
      query: RERANKER_PROBE.query,
      documents: [...RERANKER_PROBE.documents],
      model,
      timeoutMs: 8000,
    });
    if (!Array.isArray(results) || results.length === 0) {
      return { ok: false, message: `Reranker probe against ${model} returned no results.` };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: `Reranker probe against ${model} failed. Previous configuration was retained; inspect provider configuration before retrying.`,
    };
  }
}

/**
 * Persist the target model+dims to the FILE plane and reconfigure the
 * in-process gateway. The gateway reads file/env config, not the DB plane —
 * without this the re-embed would silently run against the OLD provider.
 * Shared by the CLI command and the `migrate_embeddings` op handler.
 */
export async function persistEmbeddingFileConfig(
  toModel: string,
  toDims: number,
): Promise<void> {
  const { loadConfig, loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
  const { configureGateway } = await import('../core/ai/gateway.ts');
  const { buildGatewayConfig } = await import('../core/ai/build-gateway-config.ts');
  // Round-2 #2: read the FILE plane, not env-merged loadConfig(). Persisting
  // the merged view wrote env-sourced API keys/DB URLs into
  // ~/.gbrain/config.json as a side effect of every migration.
  const fileCfg = loadConfigFileOnly();
  if (!fileCfg) {
    // No file plane. Env-canonical deployments (containers/CI where
    // GBRAIN_EMBEDDING_* IS the durable config, possibly with a read-only
    // HOME) are legitimate: when env already pins the exact target, there is
    // nothing to persist — proceed on env alone. The DB plane still gets the
    // target (apply step 4) so doctor agrees.
    // Full pinning required: a dims-only env var must not count (the model
    // would be unpinned and the next process falls back to the legacy
    // default — the #1421 class). envFullyPinsTarget requires the MODEL var.
    const envPinsTarget = envFullyPinsTarget(toModel, toDims);
    if (envPinsTarget) {
      serr('  [migrate] no ~/.gbrain/config.json — env-canonical mode: GBRAIN_EMBEDDING_* pins the target; keep it set for every gbrain process.');
      const merged = loadConfig();
      if (merged) configureGateway(buildGatewayConfig(merged));
      return;
    }
    // REFUSE rather than warn-and-proceed. Without a file plane to write, the
    // switch would not survive this process: the next `gbrain` invocation
    // reads file/env config, sees the OLD provider, and re-embeds the brain
    // back into the old space (paying twice) — or fails outright against a
    // column that is now the new width. Thrown from inside
    // applyEmbeddingMigration's try, so it surfaces as status: 'failed'
    // BEFORE the config/cache steps and the caller exits non-zero.
    throw new Error(
      'No ~/.gbrain/config.json found — refusing to migrate.\n' +
      '  The embed pipeline reads file/env config, so without a file plane this switch\n' +
      '  would not survive the process and the next run would re-embed into the old space.\n' +
      '  Fix: run `gbrain init` (or set GBRAIN_EMBEDDING_MODEL + GBRAIN_EMBEDDING_DIMENSIONS\n' +
      '  in the environment of every gbrain process) and re-run.',
    );
  }
  fileCfg.embedding_model = toModel;
  fileCfg.embedding_dimensions = toDims;
  saveConfig(fileCfg);
  // Reconfigure the in-process gateway from the MERGED view (env still wins
  // at runtime; when env is set it matches the target — the ≠ case was
  // refused before apply).
  const merged = loadConfig();
  configureGateway(buildGatewayConfig(merged ?? fileCfg));
}

// ============================================================================
// Shared orchestrator (round-2 #11): ONE flow consumed by BOTH the CLI
// command and the `migrate_embeddings` op handler, so hardening (locks,
// retarget, verified skip, heartbeat, completion bookkeeping) can never
// exist on one surface and not the other.
// ============================================================================

export interface MigrationFlowOpts {
  maxCostUsd?: number;
  to: string;
  dim?: number;
  ignoreEnvOverride?: boolean;
  retarget?: boolean;
  /** auto (default) | off | keep | <provider:model> — see resolveRerankerPlan. */
  reranker?: string;
  noEmbed?: boolean;
  batchSize?: number;
  pace?: ReturnType<typeof parsePaceArgs>;
  quiet?: boolean;
  onProgress?: (done: number, total: number, embedded: number) => void;
}

/** Outcome of the reranker companion step, reported never silent. */
export interface RerankerOutcome {
  action: 'switched' | 'disabled' | 'switch_failed' | 'suggested' | 'none';
  to?: string;
  reason?: string;
  suggestion?: string | null;
}

/** The plan plus its worst-case authorization (#5680) and the same target's retained debits. */
export type MigrationPlan = EmbeddingMigrationPlan & { worst_case_authorization: MigrationWorstCase & { prior_debited_usd: number } };

export interface MigrationPlanContext {
  plan: MigrationPlan;
  verify: MigrationVerify;
  envPresence: ReturnType<typeof detectEnvPresence>;
  /** env is set AND exactly pins the target (the notice-and-proceed case). */
  envMatchesTarget: boolean;
  /** A live marker for a DIFFERENT target (the --retarget decision), if any. */
  inflightOther: MigrationState | null;
  /** The reranker companion decision (D8). */
  rerankerPlan: RerankerPlan;
  /** Which brain/DB this run is actually pointed at (wrong-brain visibility). */
  identity: { engine: string; target: string };
  /** Quiesce-lite: live embed writers that are NOT under the migration locks. */
  concurrentWriters: { workers: number; embedJobs: number };
  /** Non-default search_embedding_column, if configured (read-path caveat). */
  customSearchColumn: string | null;
}

export type MigrationFlowResult =
  | { status: 'locked'; holder: 'migration' | 'embed_backfill'; detail: string }
  | { status: 'refused_retarget'; inflight: MigrationState }
  | { status: 'refused_env'; warning: EnvOverrideWarning }
  | { status: 'probe_failed'; message: string }
  | { status: 'apply_failed'; reason: string }
  | { status: 'refused_budget'; refusal: MigrationBudgetRefusalDetails }
  | {
      status: 'applied_no_embed';
      invalidated: number; cache_cleared: number;
      schema_transitioned: boolean; pinned_repaired: string[];
      reranker: RerankerOutcome;
    }
  | {
      status: 'completed';
      embedded: number; remaining: 0; signatures_reconciled: number;
      invalidated: number; cache_cleared: number;
      schema_transitioned: boolean; pinned_repaired: string[];
      reranker: RerankerOutcome;
      verify_search: VerifySearchOutcome;
    }
  | {
      status: 'incomplete';
      embedded: number; remaining: number; signatures_reconciled: number;
      invalidated: number; cache_cleared: number;
      schema_transitioned: boolean; pinned_repaired: string[];
      reranker: RerankerOutcome;
      lock_skipped?: boolean; lock_lost?: boolean;
    };

/**
 * Read-only planning context: the plan, the DB-reality convergence verdict,
 * env/config-plane resolution, brain identity, and the concurrent-writer
 * census. Never mutates anything.
 */
export async function planMigrationFlow(
  engine: BrainEngine,
  opts: Pick<MigrationFlowOpts, 'to' | 'dim' | 'reranker'>,
): Promise<MigrationPlanContext> {
  // From-state as the gateway resolved it (file/env config + defaults) —
  // display only; nothing load-bearing trusts it (D2).
  let fromModel: string | undefined;
  let fromDims: number | undefined;
  try {
    const { getEmbeddingModel, getEmbeddingDimensions } = await import('../core/ai/gateway.ts');
    fromModel = getEmbeddingModel();
    fromDims = getEmbeddingDimensions();
  } catch { /* gateway unconfigured — plan falls back to shipped defaults */ }

  const plan = await planEmbeddingMigration(engine, {
    to: opts.to,
    ...(opts.dim !== undefined && { dim: opts.dim }),
    ...(fromModel !== undefined && { fromModel }),
    ...(fromDims !== undefined && { fromDims }),
  });

  const envPresence = detectEnvPresence();
  // FULL pinning (model var required): feeds the env-canonical verify
  // conjunct and the notice copy — a dims-only env var neither pins the
  // target nor may fake convergence on a no-file-plane brain.
  const envMatchesTarget = envFullyPinsTarget(plan.to_model, plan.to_dims);

  // File plane read WITHOUT env merge — verify must not be poisonable.
  let filePlane: { model?: string | null; dims?: number | null } | null = null;
  try {
    const { loadConfigFileOnly } = await import('../core/config.ts');
    const fileCfg = loadConfigFileOnly();
    filePlane = fileCfg
      ? { model: fileCfg.embedding_model ?? null, dims: fileCfg.embedding_dimensions ?? null }
      : null;
  } catch { /* unreadable file plane = absent */ }

  const verify = await verifyMigrationComplete(engine, {
    toModel: plan.to_model,
    toDims: plan.to_dims,
  }, { filePlane, envMatchesTarget, envPresent: envPresence.present });

  // Live marker for a DIFFERENT target: the caller's --retarget decision.
  const marker = await readMigrationState(engine);
  const inflightOther = marker.state
    && (marker.state.to_model !== plan.to_model || marker.state.to_dims !== plan.to_dims)
    ? marker.state
    : null;

  // Reranker companion decision (D8) — throws a paste-ready message on an
  // invalid explicit --reranker value BEFORE anything destructive can run.
  const rerankerPlan = await resolveRerankerPlan(engine, plan.from_model, plan.to_model, opts.reranker);
  const worstCase = await planMigrationWorstCase(engine, plan, { rerankerModel: rerankerPlan.action.kind === 'switch' ? rerankerPlan.action.to : undefined });
  const priorDebitedUsd = marker.state && !inflightOther ? marker.state.budget?.debited_usd ?? 0 : 0;

  // Brain/DB identity (round-1 C1): make wrong-brain routing visible in every
  // transcript. Redacted — never print a raw connection string.
  let identity = { engine: 'unknown', target: 'unknown' };
  try {
    const { loadConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (cfg?.database_url) identity = { engine: 'postgres', target: redactPgUrl(cfg.database_url) };
    else if (cfg?.database_path) identity = { engine: 'pglite', target: cfg.database_path };
    else identity = { engine: cfg?.engine ?? 'pglite', target: 'default path' };
  } catch { /* identity is informational */ }

  // Quiesce-lite census (round-1 C2 / round-2 #3): embed writers outside the
  // migration locks. Report, don't block — the completion census is the
  // correctness backstop; this is the operator's "stop the worker first" cue.
  let concurrentWriters = { workers: 0, embedJobs: 0 };
  try {
    const { readWorkers } = await import('../core/minions/worker-registry.ts');
    const workers = readWorkers().length;
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM minion_jobs
        WHERE status IN ('waiting', 'running')
          AND name IN ('embed', 'embed-catch-up', 'embed-backfill')`,
    );
    concurrentWriters = { workers, embedJobs: Number(rows[0]?.n ?? 0) };
  } catch { /* census is informational */ }

  // Custom read column (v2-deferred write side): the migration rebuilds the
  // default `embedding` column; a brain reading from another column needs to
  // know its read path is NOT what this run re-embeds.
  let customSearchColumn: string | null = null;
  try {
    const col = await engine.getConfig('search_embedding_column');
    if (col && col !== 'embedding') customSearchColumn = col;
  } catch { /* informational */ }

  return { plan: { ...plan, worst_case_authorization: { ...worstCase, prior_debited_usd: priorDebitedUsd } },
    verify, envPresence, envMatchesTarget, inflightOther, rerankerPlan, identity, concurrentWriters, customSearchColumn };
}

/**
 * The consented, destructive half. Callers run planMigrationFlow first, get
 * user consent (CLI confirm / op yes:true), then call this. Lock ordering:
 * global migration lock → all-source embed locks (sorted, archived included)
 * → probe → apply → drain (heldLocks + heartbeat) → reconcile → complete.
 */
export async function executeMigrationFlow(
  engine: BrainEngine,
  ctx: MigrationPlanContext,
  opts: MigrationFlowOpts,
): Promise<MigrationFlowResult> {
  const { plan } = ctx;

  // Global migration lock FIRST (round-2 #4): two migrations must serialize
  // even on empty brains (zero source locks) and across retarget decisions.
  let globalLock: DbLockHandle | null = null;
  try {
    globalLock = await tryAcquireDbLock(engine, GLOBAL_MIGRATION_LOCK_ID, EMBED_BACKFILL_LOCK_TTL_MIN);
  } catch {
    globalLock = null; // lock subsystem down — treated as held (fail closed for a destructive op)
  }
  if (!globalLock) {
    return {
      status: 'locked',
      holder: 'migration',
      detail: 'another embedding migration holds the brain-wide migration lock (or the lock subsystem is unavailable)',
    };
  }

  const heldLocks: DbLockHandle[] = [globalLock];
  const controller = new AbortController();
  let expectedSources: string | undefined;
  let lost = false;
  let renewing: Promise<void> | undefined;
  const assertOwned = async (tx?: BrainEngine) => {
    if (!tx && renewing) await renewing;
    if (lost) throw new Error('Migration lock lease lost; durable work retained. Inspect --status before resuming.');
    if (tx) await assertMigrationLeases(tx, heldLocks);
    else for (const lock of heldLocks) {
      if (!await lock.refresh({ signal: AbortSignal.timeout(30_000) })) { lost = true; controller.abort(); throw new Error('Migration lock lease lost; further mutations refused.'); }
    }
    if (expectedSources !== undefined) {
      if (tx) await tx.executeRaw('LOCK TABLE sources IN SHARE MODE');
      const sources = await (tx ?? engine).executeRaw('SELECT id,incarnation::text,archived FROM sources ORDER BY id');
      if (JSON.stringify(sources) !== expectedSources) throw new Error('Source census changed (including archive state); migration paused before further work. Inspect --status; use gbrain sources restore <id> deliberately only if restoring an archived source is intended.');
    }
  };
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = assertOwned().catch(() => { lost = true; controller.abort(); }).finally(() => { renewing = undefined; });
  }, 15_000);
  try {
    // Retarget gate UNDER the global lock (no read-then-write race).
    const marker = await readMigrationState(engine);
    if (
      marker.state
      && (marker.state.to_model !== plan.to_model || marker.state.to_dims !== plan.to_dims)
      && !opts.retarget
    ) {
      return { status: 'refused_retarget', inflight: marker.state };
    }

    // All-source embed locks, sorted, ARCHIVED INCLUDED (round-2 #4: the
    // drain walks archived sources' chunks too — lock set must match).
    let sourceIds: string[] = [];
    try {
      const rows = await engine.listAllSources({ includeArchived: true });
      sourceIds = rows.map((r) => r.id).sort();
    } catch { return { status: 'apply_failed', reason: 'Source census unavailable; no migration or paid work performed. Restore database access and retry.' }; }
    for (const sid of sourceIds) {
      let lock: DbLockHandle | null = null;
      try {
        lock = await tryAcquireDbLock(engine, embedBackfillLockId(sid), EMBED_BACKFILL_LOCK_TTL_MIN);
      } catch {
        lock = null;
      }
      if (!lock) {
        return {
          status: 'locked',
          holder: 'embed_backfill',
          detail: `an embed backfill holds the lock for source "${sid}" (check \`gbrain jobs list\`; a hard-killed run's lock expires within ${EMBED_BACKFILL_LOCK_TTL_MIN} minutes)`,
        };
      }
      heldLocks.push(lock);
    }

    const lockedCensus = await engine.executeRaw<{ id: string; incarnation: string; archived: boolean }>('SELECT id,incarnation::text,archived FROM sources ORDER BY id');
    if (JSON.stringify(lockedCensus.map(s => s.id)) !== JSON.stringify(sourceIds)) {
      return { status: 'apply_failed', reason: 'Source census changed while acquiring locks; no embedding work performed. Retry the scoped preview.' };
    }
    expectedSources = JSON.stringify(lockedCensus);
    await assertOwned();
    const envWarning = detectEnvOverride(plan.to_model, plan.to_dims);
    if (envWarning.triggered && !opts.ignoreEnvOverride) return { status: 'refused_env', warning: envWarning };
    const { loadConfigFileOnly } = await import('../core/config.ts');
    const runtimeConfig = loadConfigFileOnly();
    if (!runtimeConfig && !envFullyPinsTarget(plan.to_model, plan.to_dims)) {
      return { status: 'apply_failed', reason: 'No ~/.gbrain/config.json found — refusing to migrate before invalidation. Initialize the selected brain or persist target model and dimensions in its environment.' };
    }
    const disabled = await engine.getConfig('embedding_disabled');
    if (runtimeConfig?.embedding_disabled || disabled !== null && disabled !== 'false') {
      return { status: 'apply_failed', reason: 'Embedding is disabled or its policy is invalid; no provider requests or migration invalidation performed. Review the selected brain embedding configuration before retrying.' };
    }
    await engine.transaction(async tx => { await assertOwned(tx); await assertRetainedEmbeddingRebuildability(tx, plan.to_dims, plan.to_model, plan); });
    const rerankerModel = ctx.rerankerPlan.action.kind === 'switch' ? ctx.rerankerPlan.action.to : undefined;
    let debit: Awaited<ReturnType<typeof authorizeMigrationBudget>>;
    try {
      debit = await authorizeMigrationBudget(engine, plan, opts.maxCostUsd, heldLocks, rerankerModel,
        await planMigrationWorstCase(engine, plan, { rerankerModel }));
    } catch (error) {
      if (error instanceof MigrationBudgetRefusal) return { status: 'refused_budget', refusal: error.details };
      throw error;
    }
    return await withAIInvocationGuard(async call => {
      await assertOwned();
      const permit = await debit(call);
      return { settle: async usage => { await permit.settle(usage); await assertOwned(); } };
    }, async () => {
    const probe = await probeTargetProvider(plan.to_model, plan.to_dims);
    if (!probe.ok) return { status: 'probe_failed', message: probe.message };

    await assertOwned();
    const readiness = await prepareEmbeddingProjections(engine, { repair: true, assertOwned });
    if (readiness.blocked) return { status: 'apply_failed', reason: `projection_blocked: ${readiness.blocked} page(s) remain; no migration-wide embedding invalidation performed. Canonical projection recovery may have made durable progress. Inspect blockers before retrying: archived sources require deliberate gbrain sources restore <id>; unsupported media requires its source importer. See docs/guides/embedding-migration.md#recovery.` };

    const applied = await applyEmbeddingMigration(engine, plan, {
      ignoreEnvOverride: opts.ignoreEnvOverride,
      persistConfig: (m, d) => persistEmbeddingFileConfig(m, d),
      assertOwned,
    });
    if (applied.status === 'refused') return { status: 'refused_env', warning: applied.warning };
    if (applied.status === 'failed') return { status: 'apply_failed', reason: applied.reason };

    // Reranker companion step (D8/C11): probe live, then config write +
    // cache purge in one transaction. Probe failure keeps the old config and
    // is reported — never fails the whole migration, never silent.
    let reranker: RerankerOutcome = { action: 'none' };
    const rrAction = ctx.rerankerPlan.action;
    if (rrAction.kind === 'switch') {
      const rrProbe = await probeTargetReranker(rrAction.to);
      if (rrProbe.ok) {
        await applyRerankerAction(engine, rrAction, assertOwned);
        reranker = { action: 'switched', to: rrAction.to };
      } else {
        reranker = { action: 'switch_failed', to: rrAction.to, reason: rrProbe.message };
      }
    } else if (rrAction.kind === 'disable') {
      await applyRerankerAction(engine, rrAction, assertOwned);
      reranker = { action: 'disabled' };
    } else if (rrAction.suggestion !== null) {
      // auto found exposure but the target ships no reranker: never silently
      // enable a third provider's paid service — surface the exact command.
      reranker = { action: 'suggested', suggestion: rrAction.suggestion };
    }

    if (opts.noEmbed) {
      return {
        status: 'applied_no_embed',
        invalidated: applied.invalidated,
        cache_cleared: applied.cache_cleared,
        schema_transitioned: applied.schema_transitioned,
        pinned_repaired: applied.pinned_repaired,
        reranker,
      };
    }

    // Re-embed drain. heldLocks: the drain must not re-acquire (and fail
    // against) our own locks; it heartbeats them instead (lock-loss aborts).
    const embedResult: EmbedResult = await runEmbedCore(engine, {
      stale: true,
      catchUp: true,
      singleFlight: true,
      includeNullSignature: true,
      takes: true,
      quiet: opts.quiet,
      heldLocks,
      assertOwned,
      signal: controller.signal,
      ...(opts.batchSize !== undefined && { batchSize: opts.batchSize }),
      ...(opts.pace && { pace: opts.pace }),
      ...(opts.onProgress && { onProgress: opts.onProgress }),
    });

    await assertOwned();
    let embeddedFacts = 0;
    for (const sourceId of sourceIds) {
      const [active] = await engine.executeRaw('SELECT id FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
      if (!active) continue;
      await assertOwned();
      const facts = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: opts.maxCostUsd ?? marker.state?.budget?.max_cost_usd ?? 0, maxFacts: 10_000, signal: controller.signal, assertOwned });
      embeddedFacts += facts.embedded;
      if (facts.failures) break;
    }
    await assertOwned();
    const reconciled = await engine.transaction(async tx => {
      await assertOwned(tx);
      return reconcilePageSignatures(tx, plan);
    });
    const remainingChunks = await engine.countStaleChunks({
      signature: migrationSignature(plan.to_model, plan.to_dims),
      includeNullSignature: true,
    });
    const remainingFacts = await countStaleFactEmbeddings(engine, plan.to_model, plan.to_dims);
    const remainingTakes = await engine.countStaleTakes({ model: plan.to_model, dims: plan.to_dims });
    const finalReadiness = await prepareEmbeddingProjections(engine);
    const finalSources = (await engine.listAllSources({ includeArchived: true })).map(s => s.id).sort();
    const sourceChanged = JSON.stringify(sourceIds) !== JSON.stringify(finalSources);
    const configChanged = await engine.getConfig('embedding_model') !== plan.to_model
      || Number(await engine.getConfig('embedding_dimensions')) !== plan.to_dims;
    const chunkless = await engine.countChunklessPagesWithContent();
    const remaining = remainingChunks + remainingFacts.count + remainingTakes + finalReadiness.blocked + chunkless + (sourceChanged || configChanged ? 1 : 0);

    const base = {
      embedded: embedResult.embedded + embeddedFacts,
      facts_embedded: embeddedFacts,
      facts_remaining: remainingFacts.count,
      takes_embedded: embedResult.takes?.embedded ?? 0,
      takes_remaining: remainingTakes,
      blocked_projection_pages: finalReadiness.blocked,
      signatures_reconciled: reconciled,
      invalidated: applied.invalidated,
      cache_cleared: applied.cache_cleared,
      schema_transitioned: applied.schema_transitioned,
      pinned_repaired: applied.pinned_repaired,
      reranker,
    };
    if (remaining === 0 && !embedResult.lock_lost) {
      // #5088: ANN indexes are built only now, after the drain, and before the marker clears.
      await buildMigrationAnnIndexes(engine, plan.to_dims, assertOwned);
      // Completion smoke check (D11): warn-don't-block self-retrieval. The
      // outcome is stamped into the completion marker (content-free) so
      // `--status` can READ it later without re-spending on live probes.
      const verifySearch = await verifySearchRoundTrip(engine, { samples: 3 });
      await assertOwned();
      const { loadConfigFileOnly } = await import('../core/config.ts');
      const file = loadConfigFileOnly();
      const verified = await verifyMigrationComplete(engine, { toModel: plan.to_model, toDims: plan.to_dims }, {
        ignoreMarker: true,
        filePlane: file ? { model: file.embedding_model, dims: file.embedding_dimensions } : null,
        envMatchesTarget: envFullyPinsTarget(plan.to_model, plan.to_dims), envPresent: detectEnvPresence().present,
      });
      if (!verified.complete) return { status: 'incomplete', remaining: Math.max(1,
        verified.details.stale_wide + (verified.details.stale_facts ?? 0) + (verified.details.stale_takes ?? 0) + (verified.details.blocked_projection_pages ?? 0)), ...base };
      await assertOwned();
      await completeEmbeddingMigration(engine, plan, {
        verify_search: { status: verifySearch.status, samples: verifySearch.samples },
        ...(reranker.action !== 'none' && { reranker }),
        ...(plan.synopsis_tier_pages > 0 && { context_tier_downgraded_pages: plan.synopsis_tier_pages }),
      }, async tx => {
        await assertOwned(tx);
        await tx.executeRaw('LOCK TABLE pages,content_chunks,facts,config IN SHARE MODE');
        if (await tx.getConfig('embedding_model') !== plan.to_model
          || Number(await tx.getConfig('embedding_dimensions')) !== plan.to_dims) {
          throw new Error('Embedding configuration changed before completion; migration remains resumable.');
        }
        const final = await verifyMigrationComplete(tx, { toModel: plan.to_model, toDims: plan.to_dims }, {
          ignoreMarker: true,
          filePlane: file ? { model: file.embedding_model, dims: file.embedding_dimensions } : null,
          envMatchesTarget: envFullyPinsTarget(plan.to_model, plan.to_dims), envPresent: detectEnvPresence().present,
        });
        if (!final.complete) throw new Error('Migration work changed before completion; progress retained. Inspect --status and resume.');
      });
      return { status: 'completed', remaining: 0, verify_search: verifySearch, ...base };
    }
    return {
      status: 'incomplete',
      remaining,
      ...base,
      ...(embedResult.lock_skipped && { lock_skipped: true }),
      ...(embedResult.lock_lost && { lock_lost: true }),
    };
    });
  } catch (error) {
    return { status: 'apply_failed', reason: error instanceof Error ? error.message : 'Migration stopped; inspect --status before resuming.' };
  } finally {
    clearInterval(heartbeat);
    await renewing;
    for (const h of heldLocks.reverse()) {
      try { await h.release(); } catch { /* best-effort; TTL is the backstop */ }
    }
  }
}

/**
 * #5088: build the marker's deferred ANN indexes, plus the canonical chunk
 * index when the cap policy expects it and it is missing or INVALID. Each
 * built index leaves the marker in its own transaction, so a kill resumes.
 */
async function buildMigrationAnnIndexes(engine: BrainEngine, targetDims: number, assertOwned: (tx?: BrainEngine) => Promise<void>): Promise<void> {
  const canonical = canonicalChunkAnnIndex();
  const expected = hnswIndexExpected('vector', targetDims) && await annIndexValidity(engine, canonical.name) !== true ? [canonical] : [];
  await buildDeferredAnnIndexes(engine, {
    targetDims,
    readPending: async () => mergeDeferredAnnIndexes(parseDeferredAnnIndexes((await readMigrationState(engine)).state?.deferred_ann_indexes, DEFERRED_ANN_TABLES), expected),
    writePending: pending => engine.transaction(async tx => {
      await assertOwned(tx);
      const raw = await tx.getConfig(MIGRATION_STATE_KEY);
      if (raw) await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify({ ...JSON.parse(raw) as MigrationState, deferred_ann_indexes: pending }));
    }),
    assertOwned: () => assertOwned(),
  });
}

export interface RunMigrateEmbeddingsOpts {
  /** Test seams. */
  confirm?: (question: string) => Promise<boolean>;
  isTTY?: boolean;
  exit?: (code: number) => never;
}

/**
 * Consent gate (A4): effects paid + destructive. `spend.posture=tokenmax`
 * covers only the paid part; the schema rebuild (existing vectors are
 * dropped, retrieval is degraded until the re-embed finishes) still needs
 * `--yes`. Spend stays bounded by the migration's own durable authorization
 * (`--max-cost-usd` must cover the printed worst case), so the consent cap is
 * not threaded into the run. No plan hash: the brain-wide target is fully
 * named by the argv, and a resume re-runs the same command. Resolves false
 * after a printed refusal.
 */
async function migrateConsent(engine: BrainEngine, args: string[], flags: ReturnType<typeof parseMigrateEmbeddingsFlags>,
  plan: MigrationPlan, opts: RunMigrateEmbeddingsOpts): Promise<boolean> {
  if (!flags.yes) {
    const { resolveSpendPosture } = await import('../core/spend-posture.ts');
    if (await resolveSpendPosture(engine) === 'tokenmax') {
      serr('  [migrate] spend.posture=tokenmax: the cost estimate above is informational; the destructive rebuild still needs the user\'s approval.');
    }
  }
  const priceNote = plan.price_known ? `about $${plan.est_cost_usd.toFixed(2)}` : 'an unpriced amount';
  const worstCase = plan.worst_case_authorization.usd;
  const auth = await consentGate({
    command: 'migrate embeddings',
    effects: ['paid', 'destructive'],
    actor: 'agent',
    what: `Move the brain's embeddings to ${flags.to}${flags.dim !== undefined ? ` (${flags.dim}d)` : ''}`,
    why: `Re-embeds ${plan.chunks_to_embed} chunk(s), ${plan.facts_to_embed ?? 0} fact(s) and ${plan.takes_to_embed ?? 0} take(s) with ${flags.to} (${priceNote}) so search runs in the new model's vector space; pages and facts are kept.`,
    risk: 'Rebuilds the embedding column in place: existing vectors are dropped and vector search is degraded until the re-embed finishes '
      + `(a killed run resumes with the same command; status: ${EMBEDDING_MIGRATION_RECOVERY.status_command}). `
      + `Spends up to the --max-cost-usd authorization${worstCase !== null ? ` (worst case $${worstCase.toFixed(2)})` : ''} with the target provider.`,
    user_message: `Switch your brain's embeddings to ${flags.to}? It re-embeds ${plan.chunks_to_embed} chunk(s) for ${priceNote}`
      + `${worstCase !== null ? ` (at most $${worstCase.toFixed(2)})` : ''}; search is degraded until it finishes. Your pages and facts are kept.`,
    argv: ['gbrain', 'migrate', 'embeddings', ...args.filter(a => a !== '--yes')],
    preview_argv: ['gbrain', 'migrate', 'embeddings', ...args.filter(a => a !== '--yes' && a !== '--json'), '--dry-run', '--json'],
    est_usd: plan.price_known ? plan.est_cost_usd : null,
    args,
  }, {
    json: flags.json,
    env: engineConsentEnv(engine, {
      configuredCapUsd: flags.maxCostUsd ?? 0,
      note: () => {},
      ...(opts.isTTY !== undefined ? { interactive: opts.isTTY } : {}),
      ...(opts.confirm ? { readLine: async ({ prompt }: { prompt: string }) => ({ kind: 'line' as const, text: (await opts.confirm!(prompt)) ? 'y' : 'n' }) } : {}),
    }),
  });
  return auth !== null;
}

export async function runMigrateEmbeddings(
  engine: BrainEngine,
  args: string[],
  opts: RunMigrateEmbeddingsOpts = {},
): Promise<void> {
  // Explicit `never` annotation so TS control-flow analysis treats every
  // exit() call as terminal (required for narrowing after the guard blocks).
  const exit: (code: number) => never = code => {
    if (code !== 0) for (const line of Object.values(EMBEDDING_MIGRATION_RECOVERY)) serr(`  Recovery: ${line}`);
    return (opts.exit ?? ((value: number) => process.exit(value)))(code);
  };
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    exit(0);
  }
  const flags = parseMigrateEmbeddingsFlags(args);

  // ── Read-only status surface (D6). No env refusal (it REPORTS env), no
  // mutation, no spend — the mid-incident "where am I?" command.
  if (args.includes('--status')) {
    const report = await readMigrationStatus(engine);
    const envPresence = detectEnvPresence();
    // API-key PRESENCE only — never values (Section 3).
    const keyPresence: Record<string, boolean> = {};
    for (const k of ['VOYAGE_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
      keyPresence[k] = Boolean(process.env[k]);
    }
    let filePlane: { model?: string | null; dims?: number | null } | null = null;
    let identity = { engine: 'unknown', target: 'unknown' };
    try {
      const { loadConfigFileOnly, loadConfig } = await import('../core/config.ts');
      const fileCfg = loadConfigFileOnly();
      filePlane = fileCfg
        ? { model: fileCfg.embedding_model ?? null, dims: fileCfg.embedding_dimensions ?? null }
        : null;
      const cfg = loadConfig();
      if (cfg?.database_url) identity = { engine: 'postgres', target: redactPgUrl(cfg.database_url) };
      else if (cfg?.database_path) identity = { engine: 'pglite', target: cfg.database_path };
      else identity = { engine: cfg?.engine ?? 'pglite', target: 'default path' };
    } catch { /* informational */ }

    const resumeCmd = report.marker.kind === 'live'
      ? renderResumeCommand(report.marker.state)
      : null;

    if (flags.json) {
      console.log(JSON.stringify({
        status: 'status',
        identity,
        env: { present: envPresence.present, model: envPresence.model, dims: envPresence.dims },
        keys: keyPresence,
        file_plane: filePlane,
        ...report,
        resume_command: resumeCmd,
      }, null, 2));
      exit(0);
    }

    console.log('Embedding migration status');
    console.log(`  Brain: ${identity.engine} (${identity.target}); scope: brain-wide (all sources)`);
    console.log(`  Env plane:  GBRAIN_EMBEDDING_MODEL=${envPresence.model ?? '(unset)'} GBRAIN_EMBEDDING_DIMENSIONS=${envPresence.dims ?? '(unset)'}`);
    console.log(`  Keys:       ${Object.entries(keyPresence).map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`).join(' ')}`);
    console.log(`  File plane: ${filePlane ? `${filePlane.model ?? '(none)'} @ ${filePlane.dims ?? '?'}d` : '(no ~/.gbrain/config.json)'}`);
    console.log(`  DB plane:   ${report.db_plane.model ?? '(none)'} @ ${report.db_plane.dims ?? '?'}d`);
    console.log(`  Column:     content_chunks.embedding ${report.column_dims === null ? 'absent/unreadable' : `${report.column_dims}d`}${report.pinned_widths.map((p) => `; ${p.table} ${p.dims === null ? '?' : `${p.dims}d`}`).join('')}`);
    console.log(`  Vectors:    ${report.missing_embeddings ?? '?'} chunk(s) missing; ${report.chunkless_pages ?? '?'} contentful page(s) without chunks; facts pending: ${report.facts_pending ?? 'n/a'}; takes pending: ${report.takes_pending ?? 'n/a'}`);
    console.log(`  Projection: ${report.blocked_projection_pages ?? '?'} page(s) blocked; bounded canonical recovery runs before invalidation.`);
    if (report.embed_skip_null_chunks !== null && report.embed_skip_null_chunks > 0) {
      console.log(`  Embed-skip: ${report.embed_skip_null_chunks} chunk(s) on embed_skip pages have NULL vectors — excluded from re-embedding by design (remove the frontmatter marker to re-embed them)`);
    }
    if (report.signature_census.length > 0) {
      console.log(`  Signatures: ${report.signature_census.map((c) => `${c.signature ?? '(none recorded)'}: ${c.pages}`).join(', ')}`);
    }
    if (report.synopsis_tier_pages !== null && report.synopsis_tier_pages > 0) {
      console.log(`  Context tier: ${report.synopsis_tier_pages} page(s) at per_chunk_synopsis (a migration re-embeds them at title tier)`);
    }
    if (report.stale_vs_target.target) {
      const fs = report.stale_vs_target.false_stamped;
      console.log(`  Target:     ${report.stale_vs_target.target} — ${report.stale_vs_target.stale ?? '?'} chunk(s) not yet in that space${fs !== null && fs > 0 ? `; ${fs} chunk(s) falsely stamped with the target signature (chunk model disagrees — a run re-embeds them)` : ''}`);
    }
    switch (report.marker.kind) {
      case 'live': {
        const s = report.marker.state;
        if (s.budget) console.log(`  Budget:     $${s.budget.debited_usd} conservatively debited of $${s.budget.max_cost_usd} authorized; ${s.budget.requests} dispatched/reserved request(s).`);
        console.log(`  Migration:  IN FLIGHT to ${s.to_model} (${s.to_dims}d), started ${s.started_at}${s.retargeted_at ? `, retargeted ${s.retargeted_at}` : ''}`);
        if (s.superseded && s.superseded.length > 0) {
          console.log(`              abandoned targets: ${s.superseded.map((x) => `${x.to_model} (${x.to_dims}d, started ${x.started_at})`).join('; ')}`);
        }
        console.log(`  Resume:     ${resumeCmd}`);
        break;
      }
      case 'corrupt':
        console.log(`  Migration:  state marker is CORRUPT (raw: ${report.marker.raw_prefix}) — re-running a migration rewrites it`);
        break;
      default:
        console.log('  Migration:  none in flight');
    }
    if (report.completed) {
      const c = report.completed;
      console.log(`  Last completed: to ${String(c.to_model)} (${String(c.to_dims)}d) at ${String(c.completed_at)}${c.verify_search ? `; smoke check: ${String((c.verify_search as { status?: unknown }).status)}` : ''}`);
    }
    exit(0);
  }

  if (!flags.to) {
    serr('Missing --to <provider:model>. Example: gbrain migrate embeddings --to openai:text-embedding-3-small');
    serr('Run with --help for all flags.');
    exit(1);
  }

  let ctx: MigrationPlanContext;
  try {
    ctx = await planMigrationFlow(engine, {
      to: flags.to!,
      ...(flags.dim !== undefined && { dim: flags.dim }),
      ...(flags.reranker !== undefined && { reranker: flags.reranker }),
    });
  } catch (e) {
    serr(e instanceof Error ? e.message : String(e));
    exit(1);
    return; // unreachable; keeps TS happy for injected exit seams
  }
  const plan = ctx.plan;

  if (flags.json) {
    // Human plan goes to stderr so stdout stays JSON-clean.
    serr(renderPlan(ctx));
  } else {
    console.log(renderPlan(ctx));
  }

  // Different-target in-flight marker: the --retarget decision comes BEFORE
  // any skip — a converged brain with a live foreign marker still needs the
  // user to resume it or explicitly abandon it.
  if (ctx.inflightOther && !flags.retarget && !flags.dryRun) {
    const s = ctx.inflightOther;
    if (flags.json) console.log(JSON.stringify({ status: 'refused', reason: 'retarget_required', inflight: s, plan, recovery: EMBEDDING_MIGRATION_RECOVERY }, null, 2));
    printRetargetRefusal(s);
    exit(1);
  }

  // DB-reality skip (D2): "nothing to migrate" ONLY when every convergence
  // conjunct verifies against the database + the un-merged file plane, no
  // foreign marker is pending a retarget decision, AND no reranker companion
  // action is pending (a resolved switch/disable executes as a config-only
  // completion even on a converged brain — round-2 #6). The old
  // three-conjunct skip trusted `from_model`, which env vars poison.
  if (ctx.verify.complete && !ctx.inflightOther && ctx.rerankerPlan.action.kind === 'none') {
    if (flags.json) console.log(JSON.stringify({ status: 'skipped_no_work', plan, verified: ctx.verify }, null, 2));
    else console.log('Nothing to migrate — brain is verified on the target model (schema, vectors, signatures, config).');
    exit(0);
  }

  if (flags.dryRun) {
    if (flags.json) console.log(JSON.stringify({ status: 'planned', plan, verified: ctx.verify }, null, 2));
    exit(0);
  }

  if (!(await migrateConsent(engine, args, flags, plan, opts))) return (opts.exit ?? ((value: number) => process.exit(value)))(currentExitCode());

  // ── Execute: locks → probe → apply → drain → reconcile → complete, all in
  // the shared orchestrator (identical semantics on the op path).
  const { createProgress } = await import('../core/progress.ts');
  const { getCliOptions, cliOptsToProgressOptions } = await import('../core/cli-options.ts');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let progressStarted = false;
  const result = await executeMigrationFlow(engine, ctx, {
    to: flags.to!,
    ...(flags.dim !== undefined && { dim: flags.dim }),
    ignoreEnvOverride: flags.ignoreEnvOverride,
    retarget: flags.retarget,
    ...(flags.reranker !== undefined && { reranker: flags.reranker }),
    noEmbed: flags.noEmbed,
    maxCostUsd: flags.maxCostUsd,
    quiet: flags.json,
    ...(flags.batchSize !== undefined && { batchSize: flags.batchSize }),
    ...(flags.pace && { pace: flags.pace }),
    onProgress: (done, total) => {
      if (!progressStarted) {
        progress.start('migrate.reembed', total);
        progressStarted = true;
      }
      progress.tick(1);
    },
  });
  if (progressStarted) progress.finish();

  // Refusals normalize to the op-envelope shape ({status:'refused', reason})
  // in their own cases below; everything else gets the generic envelope.
  if (flags.json && result.status !== 'refused_env' && result.status !== 'refused_retarget' && result.status !== 'refused_budget') {
    console.log(JSON.stringify({ ...result, plan,
      ...(result.status !== 'completed' && result.status !== 'applied_no_embed' && { recovery: EMBEDDING_MIGRATION_RECOVERY }),
    }, null, 2));
  }

  switch (result.status) {
    case 'locked': {
      if (result.holder === 'migration') {
        serr(`Migration refused: ${result.detail}.`);
        serr(`If a previous migration was killed hard, its lock expires within ${EMBED_BACKFILL_LOCK_TTL_MIN} minutes — re-run then.`);
      } else {
        serr(`Migration paused before any change: ${result.detail}.`);
        serr('Let the backfill finish (or stop the worker), then re-run the same command.');
      }
      exit(1);
      break;
    }
    case 'refused_retarget': {
      if (flags.json) {
        console.log(JSON.stringify({ status: 'refused', reason: 'retarget_required', inflight: result.inflight, plan, recovery: EMBEDDING_MIGRATION_RECOVERY }, null, 2));
      } else {
        printRetargetRefusal(result.inflight);
      }
      exit(1);
      break;
    }
    case 'refused_env': {
      if (flags.json) {
        console.log(JSON.stringify({ status: 'refused', reason: 'env_override', warning: result.warning, plan, recovery: EMBEDDING_MIGRATION_RECOVERY }, null, 2));
      } else {
        serr(formatEnvOverrideWarning(result.warning));
      }
      exit(1);
      break;
    }
    case 'refused_budget': {
      if (flags.json) {
        console.log(JSON.stringify({ status: 'refused', reason: result.refusal.error, ...result.refusal, plan, recovery: EMBEDDING_MIGRATION_RECOVERY }, null, 2));
      }
      serr(result.refusal.message);
      serr(`  Docs: ${result.refusal.docs}`);
      exit(1);
      break;
    }
    case 'probe_failed': {
      serr(result.message);
      exit(1);
      break;
    }
    case 'apply_failed': {
      serr(`Migration apply failed: ${result.reason}`);
      exit(1);
      break;
    }
    case 'applied_no_embed': {
      serr(renderApplySummary(result, plan));
      for (const line of renderRerankerOutcome(result.reranker)) serr(line);
      if (!flags.json) console.log('Config + schema migrated. Re-embed deferred — run: gbrain embed --stale --catch-up --include-null-signature');
      exit(0);
      break;
    }
    case 'completed': {
      serr(renderApplySummary(result, plan));
      if (result.signatures_reconciled > 0) {
        serr(`  [migrate] reconciled the embedding signature on ${result.signatures_reconciled} fully-embedded page(s) (batch-boundary pages).`);
      }
      for (const line of renderRerankerOutcome(result.reranker)) serr(line);
      // Honestly labeled: a smoke check (self-retrieval), not a recall eval —
      // BrainBench owns retrieval quality.
      if (result.verify_search.status === 'pass') {
        serr(`  [migrate] smoke check (self-retrieval, not a recall eval): pass (${result.verify_search.samples.length} sample(s)).`);
      } else if (result.verify_search.status === 'warn') {
        const bad = result.verify_search.samples.filter((s) => s.status !== 'hit');
        serr(`  [migrate] smoke check: WARN (${result.verify_search.reason_code ?? 'miss'}) — ${bad.map((s) => `page ${s.page_id}: ${s.status}${s.reason_code ? ` (${s.reason_code})` : ''}`).join('; ') || 'no samples'}.`);
        serr('            Search still completed the migration; investigate with `gbrain search` / doctor if quality looks off.');
      } else {
        serr(`  [migrate] smoke check: skipped (${result.verify_search.reason_code ?? 'n/a'}).`);
      }
      if (plan.synopsis_tier_pages > 0) {
        serr(`  [migrate] context tier: ${plan.synopsis_tier_pages} page(s) re-embedded at the title tier (was per_chunk_synopsis).`);
      }
      if (!flags.json) {
        slog(`Migration complete: ${result.embedded} chunk(s) embedded on ${plan.to_model} (${plan.to_dims}d).`);
      }
      exit(0);
      break;
    }
    case 'incomplete': {
      for (const line of renderRerankerOutcome(result.reranker)) serr(line);
      if (result.lock_lost) {
        serr(`Migration aborted: the single-flight lock was lost mid-drain (stolen or the heartbeat kept failing).`);
        serr(`${result.remaining} chunk(s) still stale; partial progress is banked. Re-run the same command once the other holder finishes.`);
      } else if (result.lock_skipped) {
        // E2E-observed failure mode: a hard-killed (SIGKILL/crash) migration
        // leaves its single-flight embed lock behind, and every immediate
        // re-run "resumes" without embedding anything. Say so — "re-run to
        // resume" would be a lie until the lock expires.
        serr(`Migration paused: ${result.remaining} chunk(s) still stale, and the re-embed was SKIPPED because`);
        serr('another embed backfill holds the per-source lock. If that is a live run (check');
        serr('`gbrain jobs list`), let it finish. If a previous migration was killed hard, its lock');
        serr(`expires after at most ${EMBED_BACKFILL_LOCK_TTL_MIN} minutes — re-run the same command then.`);
      } else {
        serr(`Migration incomplete: ${result.remaining} chunk(s) still stale (embed failures or an interrupted run).`);
        serr('Re-run the same command to resume — completed chunks are never re-embedded.');
      }
      exit(1);
      break;
    }
  }
}

/** Re-export for the op handler + tests. */
export { MIGRATION_STATE_KEY };
