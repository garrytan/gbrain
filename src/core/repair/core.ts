/**
 * `gbrain repair <kind>` core: one scope resolver, a resumable per-kind cursor,
 * the capacity stop, and the dry-run / apply loop shared by every kind.
 *
 * Every applied item is one coordinated page write (a `put_page` bound to the
 * page's current revision), so a repair never bypasses the persistence
 * coordinator and each item commits or fails on its own. A kind that only
 * rebuilds derived projections (`safe-chunks`, `contextual-mode`) takes no admission instead: its
 * items cost no lifetime IDs or receipt bytes and never hit the capacity stop.
 * Items are processed in
 * a stable order and the cursor after the last committed item is stored in
 * `op_checkpoints` under a fingerprint of (kind, brain, sources): a rerun with
 * the same scope resumes after it, and a finished scan clears it.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { readJournalLimits, journalLimitKey } from '../persistence/limits.ts';
import { isTerminal, principalKey } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from '../embedding-pricing.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import type { RepairKindSpec } from './registry.ts';

export const REPAIR_KINDS = ['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'connector-checkpoints', 'request-indexes', 'connector-fences', 'take-supersession', 'orphan-bindings', 'embedding-effects', 'attribution-backfill', 'planner-stats', 'google-file-modes', 'stale-atoms', 'extractor-facts', 'conversation-labels', 'captured-facts', 'loop-facts', 'ontology-facts', 'orphan-children', 'failed-writes', 'frontmatter', 'fences', 'slug-conflicts', 'timeline-comments'] as const;
export type RepairKind = typeof REPAIR_KINDS[number];

export interface RepairScope { brain_id: string; source_ids: string[] }

/** A stable position in a kind's item order; items after it are pending. */
export interface RepairCursor { phase: number; id: number }

export interface RepairItem {
  cursor: RepairCursor; source_id: string; slug: string; chars: number; action: string;
  /** Kind-specific planned change, rechecked against the page before it is applied. */
  change?: { from: string | null; to: string };
  /**
   * `spends: 'llm'` kinds: this item's estimated paid-model spend (USD). A dry run sums it over the items it would
   * apply (so `--limit` lowers the estimate), and an apply stops before an item whose estimate exceeds what is left of
   * the run's allowance instead of starting a call the allowance cannot cover.
   */
  llm_usd?: number;
}

export interface RepairPlan {
  /** Operator warnings the preview prints before its items (for example an older writer that can undo the repair). */
  warnings?: string[];
  items: RepairItem[];
  /** Counts of rows the kind keeps and reports instead of repairing. */
  residuals: Record<string, number>;
  /** Preview-bound kinds: the `previewHash` an apply must pass back with `--expect`. */
  preview_hash?: string;
  /** Preview-bound kinds: every previewed item with its class, all of which the hash covers. */
  listing?: RepairListing[];
  /** Kind-specific preview detail (per-file diffs, manual fixes, next actions), rendered by the handler's `render`. */
  details?: Record<string, unknown>;
  /**
   * `spends: 'llm'` kinds: the estimated paid-model spend of the pending items (null for an unpriced model under a
   * user-set cap) and what is left under the kind's own daily cap (null when it has none).
   */
  llm?: { usd: number | null; cap_remaining_usd: number | null };
  /** Discovery kinds: when the scan the plan read last finished (`fresh_at`) and whether it is still partial. */
  scan?: { fresh_at: string | null; partial: boolean };
}

export interface RepairListing { item: string; class: string; detail?: string }

/**
 * What the run was asked to do; preview-bound kinds read `expect`, `includeAmbiguous` and the `only`/`skip` path
 * selection (`slugs` names database pages). `noLlm` keeps a `spends: 'llm'` kind to its free tiers; `maxLlmUsd` is
 * the run's paid-model allowance (it only lowers the kind's own cap). `deadline` (epoch ms) bounds a discovery scan.
 */
export interface RepairPlanOptions { apply: boolean; expect?: string; includeAmbiguous?: boolean; only?: string[]; skip?: string[]; slugs?: string[];
  noLlm?: boolean; maxLlmUsd?: number; deadline?: number;
  /** `ctx.remote !== false` of the run: a remote caller's plan never names a local path (unset reads as remote). */
  remote?: boolean }

export interface RepairHandler {
  kind: RepairKind;
  /** `projection`: items rebuild derived rows only and take no journal admission. Default `coordinated`. */
  publication?: 'coordinated' | 'projection';
  /** False for kinds whose items are bookkeeping rows, not pages: no embedding cost. */
  embeds?: boolean;
  /** Pending items after `after`, in cursor order. */
  plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null, opts?: RepairPlanOptions): Promise<RepairPlan>;
  /**
   * Apply one item; `false` when it no longer needs repair. `embed` is false
   * under --no-embed. `runId` identifies this repair run and survives a resume.
   * A kind with named per-item outcomes returns them instead of a boolean.
   * `llmAllowanceUsd` (`spends: 'llm'` kinds): what is left of the run's paid-model allowance (undefined = no run
   * cap), so the kind caps its own reservation at it. `deadline` (epoch ms) is when the run stops starting work; a
   * kind bounds its own provider calls by it. `noLlm` and `expect` repeat the run's options.
   */
  apply(ctx: OperationContext, item: RepairItem, opts?: { embed: boolean; runId?: string; llmAllowanceUsd?: number; deadline?: number; noLlm?: boolean; expect?: string }): Promise<boolean | RepairItemOutcome>;
  /** How many per-item outcomes the result lists (default 20). */
  outcomeItemsLimit?: number;
  /** Human lines for the plan's `details`; `diff` asks for every per-item diff, not one sample per class. */
  render?(details: Record<string, unknown>, opts: { diff: boolean }): string[];
  /**
   * Kind-specific result fields, computed once the dry run or apply finished (for example a verification re-check
   * of the selected scope). Runs only when the run ended without an exception.
   */
  report?(ctx: OperationContext, scope: RepairScope, result: RepairResult, opts: RepairPlanOptions): Promise<Partial<Pick<RepairResult, 'repaired' | 'remaining' | 'verification' | 'stopped'>>>;
}

/**
 * A named per-item outcome; `applied` counts it as applied, otherwise skipped. `llm_usd`: what the item actually spent
 * on a paid chat model. `stop`: the run stops after this item (for example the daily ledger refused the next call),
 * with the reason, message and fix the result reports.
 */
export interface RepairItemOutcome { applied: boolean; outcome: string; reason?: string; detail?: Record<string, unknown>; llm_usd?: number;
  stop?: { reason: string; message: string; fix?: Action } }

export interface RepairResult {
  kind: RepairKind;
  mode: 'dry_run' | 'apply';
  warnings?: string[];
  scope: RepairScope;
  affected: number;
  sample: string[];
  residuals: Record<string, number>;
  /**
   * `llm_usd` and `llm_cap_remaining_usd` are present only for `spends: 'llm'` kinds: the plan's estimate on a dry
   * run, the actual spend on an apply, and what is left under the kind's daily cap and the run's allowance.
   */
  cost: { lifetime_ids: number; receipt_bytes: number; embedding_pages: number; embedding_usd: number | null; llm_usd?: number | null; llm_cap_remaining_usd?: number | null };
  capacity: Array<{ scope: string; resource: string; used: number; limit: number; stop_at: number }>;
  resumed_from: RepairCursor | null;
  applied: number;
  skipped: number;
  complete: boolean;
  stopped?: { reason: string; message: string; fix?: Action };
  apply_command: string;
  /** Kinds with a report hook: items repaired by this run (dry run: 0). `complete` keeps its meaning (every pending item was attempted). */
  repaired?: number;
  /** Kinds with a report hook: what still needs repair after this run, counted by reason. */
  remaining?: Record<string, number>;
  /** Kinds with a report hook: the post-run re-check of the selected scope. */
  verification?: Record<string, unknown>;
  /** Discovery kinds: the scan the plan read (see RepairPlan.scan). */
  scan?: { fresh_at: string | null; partial: boolean };
  /** Preview-bound kinds' dry run: every item the preview hash covers. */
  listing?: RepairListing[];
  /** Preview-bound kinds' dry run: the hash `--apply --expect` binds to (the one `apply_command` carries). */
  preview_hash?: string;
  /** Per-outcome counts and the first items, for kinds that name outcomes. */
  outcomes?: Record<string, number>;
  outcome_items?: Array<{ item: string; outcome: string; reason?: string; detail?: Record<string, unknown>; llm_usd?: number }>;
  /** Kind-specific preview detail (see RepairPlan.details). */
  details?: Record<string, unknown>;
}

const RECEIPT_BYTES = 16_384;
const STOP_RATIO = 0.9;
const SAMPLE = 10;

/** Default: every active source. `--source` narrows to one active source. */
export async function resolveRepairScope(engine: BrainEngine, source?: string): Promise<RepairScope> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived IS NOT TRUE ${source ? 'AND id=$1' : ''} ORDER BY id`, source ? [source] : []);
  if (source && !rows.length) throw new OperationError('invalid_params', `Source '${source}' does not exist or is archived.`, 'Run `gbrain sources list` and pass an active source id.');
  return { brain_id: brain?.brain_id ?? 'host', source_ids: rows.map(row => row.id) };
}

/** A preview-bound apply keeps its cursor under its approval hash, so a new preview never resumes an older set's cursor. */
function fingerprint(kind: RepairKind, scope: RepairScope, approval?: string): string {
  return digest(['repair-v1', kind, scope.brain_id, scope.source_ids, ...(approval ? [approval] : [])]);
}

async function readCursor(engine: BrainEngine, kind: RepairKind, scope: RepairScope, approval?: string): Promise<{ cursor: RepairCursor | null; runId: string | null }> {
  const [row] = await engine.executeRaw<{ completed_keys: Array<{ cursor?: RepairCursor | null; run_id?: string }> }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='repair' AND fingerprint=$1", [fingerprint(kind, scope, approval)]);
  return { cursor: row?.completed_keys[0]?.cursor ?? null, runId: row?.completed_keys[0]?.run_id ?? null };
}

/** Stores the run's cursor and id; with neither, the run is finished and the row is cleared. */
async function writeCursor(engine: BrainEngine, kind: RepairKind, scope: RepairScope, cursor: RepairCursor | null, runId: string | null, approval?: string): Promise<void> {
  if (!cursor && !runId) {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair' AND fingerprint=$1", [fingerprint(kind, scope, approval)]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('repair',$1,$2::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [fingerprint(kind, scope, approval), JSON.stringify([{ kind, scope, cursor, run_id: runId }])]);
}

/** Cumulative journal counters this repair's admissions consume, with their 90% stop line. */
async function capacity(ctx: OperationContext) {
  // A dry run never registers a writer; an unregistered installation has consumed nothing yet.
  const principal = await requestPrincipalForContext(ctx).then(principalKey, () => 'principal:unregistered');
  const limits = await readJournalLimits(ctx.engine);
  const rows = await ctx.engine.executeRaw<{ key: string; lifetime_ids: string; terminal_bytes: string }>(
    'SELECT key,lifetime_ids::text,terminal_bytes::text FROM persistence_counters WHERE key=ANY($1::text[])', [['brain', principal]]);
  return (['brain', principal] as const).flatMap(key => {
    const row = rows.find(r => r.key === key);
    const scope = key === 'brain' ? 'brain' : 'principal';
    return ([['lifetime_ids', `${scope}LifetimeIds`], ['terminal_bytes', `${scope}TerminalBytes`]] as const).map(([resource, setting]) => ({
      scope: key, resource, used: Number(row?.[resource] ?? 0), limit: limits[setting], stop_at: Math.floor(limits[setting] * STOP_RATIO),
      config_key: journalLimitKey(setting),
    }));
  });
}

function embeddingUsd(chars: number, model: string | undefined): number | null {
  if (!model) return null;
  const price = lookupEmbeddingPrice(model);
  return price.kind === 'known' ? estimateCostFromChars(chars, price.pricePerMTok) : null;
}

/**
 * Deterministic per-item request id: a rerun after a crash replays the same
 * admission (and waits for it if still pending). An attempt that ended in a
 * terminal failure is not replayed forever; the next attempt gets a new id.
 */
export async function repairRequestId(ctx: OperationContext, kind: RepairKind, item: Pick<RepairItem, 'source_id' | 'slug'>, revision: string): Promise<string> {
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  for (let attempt = 0; ; attempt++) {
    const h = digest(['repair-request-v1', kind, item.source_id, item.slug, revision, attempt]);
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const prior = await getWriteRequest(ctx.engine, principal, id);
    if (!prior || !isTerminal(prior) || prior.state === 'committed') return id;
  }
}

function writerHeld(error: unknown): error is OperationError {
  return error instanceof OperationError && ['owner_unavailable', 'writer_lock_unavailable', 'writer_busy'].includes(error.code);
}

/**
 * `explicit`: the operator named this kind on the command line. An
 * explicit-only kind (registry `explicit_only`) refuses without it, so no
 * `--all` loop or supplied remediation step can run one. `spec` is the kind's
 * registry entry (default: the registered one).
 *
 * `maxLlmUsd` caps what a `spends: 'llm'` apply may spend on a paid chat
 * model: each item gets the remaining allowance, and once it is used up the
 * run stops (`budget_exhausted`) before the next item, resumable by rerunning
 * the apply command. The cap is metered from each item's reported `llm_usd`;
 * the core never opens a budget tracker of its own.
 */
export async function runRepair(ctx: OperationContext, handler: RepairHandler, scope: RepairScope,
  opts: { apply: boolean; limit?: number; embeddingModel?: string; sourceFlag?: string; embed?: boolean; applyArgs?: string[];
    explicit?: boolean; expect?: string; includeAmbiguous?: boolean; only?: string[]; skip?: string[]; slugs?: string[]; noLlm?: boolean;
    spec?: Pick<RepairKindSpec, 'explicit_only' | 'consent' | 'spends'>; maxLlmUsd?: number; deadline?: number; now?: () => number }): Promise<RepairResult> {
  const { repairSpec, explicitKindRequired } = await import('./registry.ts');
  const spec = opts.spec ?? repairSpec(handler.kind);
  if (spec?.explicit_only && opts.explicit !== true) throw explicitKindRequired(handler.kind);
  if (opts.apply) await initializeLocalPersistence(ctx);
  const { cursor: resumed, runId: storedRunId } = await readCursor(ctx.engine, handler.kind, scope, opts.apply ? opts.expect : undefined);
  const now = opts.now ?? Date.now;
  const planOpts: RepairPlanOptions = { apply: opts.apply, expect: opts.expect, includeAmbiguous: opts.includeAmbiguous, only: opts.only, skip: opts.skip,
    ...(opts.slugs?.length ? { slugs: opts.slugs } : {}), ...(opts.noLlm ? { noLlm: true } : {}), ...(opts.maxLlmUsd !== undefined ? { maxLlmUsd: opts.maxLlmUsd } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), remote: ctx.remote !== false };
  const plan = await handler.plan(ctx.engine, scope, resumed, planOpts);
  const pending = opts.limit !== undefined ? plan.items.slice(0, opts.limit) : plan.items;
  const counters = await capacity(ctx);
  const admits = (handler.publication ?? 'coordinated') === 'coordinated' ? pending.length : 0;
  const llm = spec?.spends === 'llm';
  const llmLeft = (spent: number): number | null => {
    const caps = [plan.llm?.cap_remaining_usd, opts.maxLlmUsd].filter((cap): cap is number => typeof cap === 'number');
    return caps.length ? Math.max(0, Math.min(...caps) - spent) : null;
  };
  const result: RepairResult = {
    kind: handler.kind, mode: opts.apply ? 'apply' : 'dry_run', scope, affected: plan.items.length,
    sample: plan.items.slice(0, SAMPLE).map(item => `${item.source_id}:${item.slug}`), residuals: plan.residuals,
    cost: { lifetime_ids: admits, receipt_bytes: admits * RECEIPT_BYTES, embedding_pages: handler.embeds === false ? 0 : pending.length,
      embedding_usd: embeddingUsd(pending.reduce((sum, item) => sum + item.chars, 0), opts.embeddingModel),
      ...(llm ? { llm_usd: opts.apply || !plan.llm ? 0 : plan.llm.usd === null ? null
        : pending.some(item => item.llm_usd !== undefined) ? pending.reduce((sum, item) => sum + (item.llm_usd ?? 0), 0) : plan.llm.usd,
      llm_cap_remaining_usd: llmLeft(0) } : {}) },
    capacity: counters.map(({ scope: key, resource, used, limit, stop_at }) => ({ scope: key, resource, used, limit, stop_at })),
    resumed_from: resumed, applied: 0, skipped: 0, complete: false, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
    apply_command: `gbrain repair ${handler.kind}${opts.sourceFlag ? ` --source ${opts.sourceFlag}` : ''}${(opts.applyArgs ?? []).map(arg => ` ${arg}`).join('')}`
      + `${[...(opts.only ?? []).flatMap(path => ['--only', path]), ...(opts.skip ?? []).flatMap(path => ['--skip', path]),
        ...(opts.slugs ?? []).flatMap(slug => ['--slug', slug])].map(arg => ` ${shellQuote([arg])}`).join('')}`
      + `${opts.includeAmbiguous ? ' --include-ambiguous' : ''}${llm && opts.noLlm ? ' --no-llm' : ''}${llm && opts.maxLlmUsd !== undefined ? ` --max-usd ${opts.maxLlmUsd}` : ''}`
      + ` --apply${plan.preview_hash ? ` --expect ${plan.preview_hash}` : ''}${spec?.consent === 'destructive' ? ' --yes' : ''}`,
    ...(plan.scan ? { scan: plan.scan } : {}),
  };
  const finish = async (): Promise<RepairResult> => {
    if (handler.report) Object.assign(result, await handler.report(ctx, scope, result, planOpts));
    return result;
  };
  if (!opts.apply) {
    if (plan.listing) result.listing = plan.listing;
    if (plan.preview_hash) result.preview_hash = plan.preview_hash;
    if (plan.details) result.details = plan.details;
    result.complete = pending.length === plan.items.length;
    return finish();
  }
  // A resumed run keeps its id, so work it authorized is replayed, not authorized twice.
  const runId = storedRunId ?? randomUUID();
  if (!storedRunId) await writeCursor(ctx.engine, handler.kind, scope, resumed, runId, opts.expect);
  let llmSpent = 0;
  for (const [index, item] of pending.entries()) {
    const remaining = pending.length - index;
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      result.stopped = { reason: 'time_budget', message: `Stopped before ${item.source_id}:${item.slug}: this run reached its time budget (${remaining} item(s) still pending). `
        + `The next run resumes; rerun \`${result.apply_command}\` to continue now.` };
      return finish();
    }
    const allowanceLeft = opts.maxLlmUsd !== undefined ? opts.maxLlmUsd - llmSpent : undefined;
    if (llm && allowanceLeft !== undefined && (llmSpent >= opts.maxLlmUsd! || (item.llm_usd !== undefined && item.llm_usd > allowanceLeft + 1e-9))) {
      result.stopped = { reason: 'budget_exhausted', message: `Stopped before ${item.source_id}:${item.slug}: this run's paid-model allowance `
        + `${llmSpent >= opts.maxLlmUsd! ? 'is used up' : `cannot cover its estimate ($${item.llm_usd!.toFixed(4)})`} `
        + `($${llmSpent.toFixed(4)} spent of $${opts.maxLlmUsd!.toFixed(4)}; ${remaining} item(s) still pending). Rerun \`${result.apply_command}\` to resume.` };
      return finish();
    }
    const full = admits ? (await capacity(ctx)).find(c => c.used + (c.resource === 'lifetime_ids' ? 1 : RECEIPT_BYTES) > c.stop_at) : undefined;
    if (full) {
      const perItem = full.resource === 'lifetime_ids' ? 1 : RECEIPT_BYTES;
      const needed = Math.ceil((full.used + remaining * perItem) / STOP_RATIO) + 1;
      result.stopped = { reason: 'capacity', message: `Stopped before crossing 90% of ${full.scope} ${full.resource} (${full.used} of ${full.limit} used; `
        + `${remaining} item(s) still need ${remaining * perItem} more). Run: gbrain config set ${full.config_key} ${needed} — then rerun \`${result.apply_command}\` to resume.` };
      return finish();
    }
    try {
      const applied = await handler.apply({ ...ctx, sourceId: item.source_id }, item, { embed: opts.embed === true, runId,
        ...(llm && opts.maxLlmUsd !== undefined ? { llmAllowanceUsd: opts.maxLlmUsd - llmSpent } : {}),
        ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), ...(opts.noLlm ? { noLlm: true } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });
      if (llm && typeof applied === 'object' && applied.llm_usd) {
        llmSpent += applied.llm_usd;
        result.cost = { ...result.cost, llm_usd: llmSpent, llm_cap_remaining_usd: llmLeft(llmSpent) };
      }
      if (typeof applied === 'object') {
        result.outcomes = { ...result.outcomes, [applied.outcome]: (result.outcomes?.[applied.outcome] ?? 0) + 1 };
        if ((result.outcome_items ??= []).length < (handler.outcomeItemsLimit ?? SAMPLE * 2)) {
          result.outcome_items.push({ item: `${item.source_id}:${item.slug}`, outcome: applied.outcome, ...(applied.reason ? { reason: applied.reason } : {}),
            ...(applied.detail ? { detail: applied.detail } : {}), ...(applied.llm_usd ? { llm_usd: applied.llm_usd } : {}) });
        }
      }
      if (typeof applied === 'object' ? applied.applied : applied) result.applied++;
      else result.skipped++;
      if (typeof applied === 'object' && applied.stop) {
        await writeCursor(ctx.engine, handler.kind, scope, item.cursor, runId, opts.expect);
        result.stopped = applied.stop;
        return finish();
      }
    } catch (error) {
      // A page edited since planning is left for the next full scan.
      if (error instanceof OperationError && error.code === 'revision_conflict') { result.skipped++; continue; }
      if (error instanceof OperationError && error.code === 'write_pending') {
        result.stopped = { reason: 'write_pending', message: `The repair of ${item.source_id}:${item.slug} was accepted and is still pending publication. `
          + `Rerun \`${result.apply_command}\` to resume; the same request is replayed.` };
        return finish();
      }
      if (!writerHeld(error)) throw error;
      result.stopped = { reason: error.code, message: `The canonical writer for source '${item.source_id}' is held (${error.code}). `
        + `Inspect it with: gbrain sources writer status ${item.source_id} — then rerun \`${result.apply_command}\` to resume.` };
      return finish();
    }
    await writeCursor(ctx.engine, handler.kind, scope, item.cursor, runId, opts.expect);
  }
  result.complete = pending.length === plan.items.length;
  if (result.complete) await writeCursor(ctx.engine, handler.kind, scope, null, null, opts.expect);
  return finish();
}

/** Cursor order shared by the kinds' SQL: (phase, id) strictly after `after`. */
export function afterCursor(item: RepairCursor, after: RepairCursor | null): boolean {
  return !after || item.phase > after.phase || (item.phase === after.phase && item.id > after.id);
}
