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
 *
 * Every item failure is classified by `classifyItemFailure` (item-failure.ts,
 * GBRA-130) through one `ItemRun` per run. An accepted, still pending write is
 * progress and is checked first; a held writer stops the run with its writer
 * status; any other run-scoped failure (a lost connection, a failed
 * transaction, an abort) is rethrown. Every item-scoped failure is a per-item
 * verdict: it is recorded in `failed[]` with the kind's preview as its fix,
 * left as it was, and the loop continues without a cursor write for it. A
 * later success writes a higher cursor, so a resumed run does not retry it;
 * the next full scan (a run with no stored cursor, which every completed run
 * leaves behind, and so does a limited run that ended with only item
 * failures) does, the same way a `revision_conflict` item is retried. When
 * most items fail the breaker stops the run with `item_failures_systemic` and
 * the kind's `onItemFailures` hook is not called. An apply bound to an
 * approved preview (`--expect`) is the operator's answer to one exact set:
 * only `REPAIR_ITEM_FAILURE_CODES` continue it, and any other failure is
 * thrown with its own code (a refused choice, a conflict, a crash).
 */
import { withAdmissionOrigin } from '../persistence/admission-origin.ts';
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
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import type { RepairKindSpec } from './registry.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { repairAdmissionWindow, repairPublicationOwner, settleRepairReceipts, type PendingRepair } from './settle.ts';
import { RECEIPT_RESERVATION_FLOOR } from '../persistence/receipt-bytes.ts';
import { readFix } from '../ops/op-fix.ts';
import { classifyItemFailure, ItemRun, type ItemFailure } from '../item-failure.ts';
import type { ProgressReporter } from '../progress.ts';
import type { GenerationsSelection } from '../generations/repair.ts';

export const REPAIR_KINDS = ['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'connector-checkpoints', 'request-indexes', 'connector-fences', 'take-supersession', 'accepted-takes', 'orphan-bindings', 'embedding-effects', 'attribution-backfill', 'planner-stats', 'google-file-modes', 'stale-atoms', 'atoms-restore', 'extractor-facts', 'conversation-labels', 'captured-facts', 'redacted-facts', 'loop-facts', 'ontology-facts', 'facts-rehome', 'consolidate-ties', 'duplicate-facts', 'orphan-children', 'failed-writes', 'split-facts', 'frontmatter', 'fences', 'slug-conflicts', 'timeline-comments', 'timeline-order', 'managed-sync-orphans', 'content-receipt-root', 'frontmatter-keys', 'file-drift', 'stuck-recovery', 'ghost-pages', 'origin-twins', 'receipt-compaction', 'aliases', 'rename-identity', 'overwritten-edits', 'legacy-twins', 'missing-tables', 'url-clone-fences', 'segmented-mirror', 'uncommitted-deletions', 'generations', 'fact-claim-dates', 'provenance'] as const;
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
  /** `duplicate-facts` (#7043): also retire copies of a claim that sit on other entities than the kept row. */
  includeCrossEntity?: boolean;
  noLlm?: boolean; maxLlmUsd?: number; deadline?: number;
  /** `ctx.remote !== false` of the run: a remote caller's plan never names a local path (unset reads as remote). */
  remote?: boolean;
  /** `file-drift` (#6643): the side that wins, conflict receipt ids, every still-drifted page, and the one drift class kept. */
  prefer?: 'file' | 'database'; requests?: string[]; allDrifted?: boolean; driftClass?: string;
  /** #6712 PR 2 `file-drift`: only pages whose newest drift conflict is at or after this concrete instant (ISO; `--since`, parsed by `since.ts`). */
  since?: string;
  /** #6712 PR 4b `file-drift`: the source's held `file_drift` pages, of one side and (for `deleted`) one state. */
  held?: boolean; side?: string; state?: string;
  /** GBRA-133 `file-drift --held --side deleted --state file_gone`: only holds of this deletion provenance (`--provenance`). */
  provenance?: string;
  /** `file-drift --held`: the window starts after the held file this `next_cursor` names (`--cursor`); `progress` reports the preview's pages, and an apply's items, on stderr. */
  cursor?: string; progress?: ProgressReporter;
  /** `stuck-recovery`: the version an apply keeps, and the one request a run selects. */
  keep?: 'prior' | 'disk' | 'withdrawn'; requestId?: string;
  /** `receipt-compaction` (#6696 A9): the age (`72h`, `30d`), failures too, and compaction inside the retention window. */
  olderThan?: string; includeFailures?: boolean; force?: boolean;
  /** `rename-identity` (#6729): the old slug that disambiguates a pair (`--from`), and the close disposition (`--close`). */
  from?: string; close?: boolean;
  /** `uncommitted-deletions` (#7130): the preview window starts below this page id (`--after`). */
  afterPage?: number;
  /** `visibility`: the preview window's size (`--limit`); an apply still stops after `--limit` items. */
  limit?: number;
  /** `generations` (GBRA-161): the ledger kind, mode and selectors (`--kind`, `--mode`, `--run`/`--since`/`--key`/`--generation`/`--held`). */
  generations?: GenerationsSelection;
  /** `fact-claim-dates` (#7247): the bulk-loaded UTC day to repair (`--day`) instead of the detected ones. */
  day?: string }

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
  /**
   * The items whose apply threw an item-scoped failure this run, with the classified failure. Called once before the
   * result is reported, never for a run the breaker stopped (`item_failures_systemic`) or one a run-scoped error ended.
   */
  onItemFailures?(ctx: OperationContext, failures: ReadonlyArray<{ item: RepairItem; failure: ItemFailure }>): Promise<void>;
}

/**
 * A named per-item outcome; `applied` counts it as applied, otherwise skipped. `llm_usd`: what the item actually spent
 * on a paid chat model. `stop`: the run stops after this item (for example the daily ledger refused the next call),
 * with the reason, message and fix the result reports.
 */
export interface RepairItemOutcome { applied: boolean; outcome: string; reason?: string; detail?: Record<string, unknown>; llm_usd?: number;
  stop?: { reason: string; message: string; fix?: Action };
  /** The item-scoped error behind a held outcome: counted by the run's breaker like a thrown item failure. */
  failure?: unknown }

/**
 * Refusal codes a kind may treat as one item's verdict inside its own apply (ghost-pages extends them). The core records
 * every item-scoped failure the same way (`classifyItemFailure`); these codes are a subset of that, and the only
 * failures an apply bound to `--expect` continues past.
 * `page_body_segmented`: the item's page stores its body in segments and the kind rewrites the whole body as one string.
 */
export const REPAIR_ITEM_FAILURE_CODES: ReadonlySet<string> = new Set(['invalid_params', 'source_changed', 'page_body_segmented']);

/**
 * An item whose apply failed item-scoped; its page, file and rows are exactly as before. The next full scan retries it.
 * `fix` previews the kind for the item's source (read-only), which lists the item again with its current state.
 */
export interface RepairFailedItem { item: string; source_id: string; slug: string; reason: string; message: string; retry: 'next_full_scan'; fix?: Action }

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
  /** Items that failed item-scoped and were left unchanged; `complete` still means every pending item was attempted. */
  failed: RepairFailedItem[];
  complete: boolean;
  /** `code`: with reason `error` (a kind that threw inside a multi-kind loop), the classified error code. */
  stopped?: { reason: string; message: string; fix?: Action; code?: string };
  /** #6543 (D1): accepted repairs still unpublished when the run stopped; the cursor stays before the first, and a rerun replays the same requests. */
  pending?: Array<{ item: string; request_id: string }>;
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

/** Cumulative journal counters this repair's admissions consume, with their 90% stop line (also the keep_db policy's headroom gate). */
export async function capacity(ctx: OperationContext) {
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
 * An item's cursor is part of the id, so two items that write the same page at
 * the same revision (two facts of one page) never share one: the second item
 * of a run is admitted while the first is still pending, and reusing the
 * first's id for a different write is refused as idempotency_conflict.
 */
export async function repairRequestId(ctx: OperationContext, kind: RepairKind, item: Pick<RepairItem, 'source_id' | 'slug'> & { cursor?: RepairCursor }, revision: string): Promise<string> {
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  for (let attempt = 0; ; attempt++) {
    const h = digest(item.cursor ? ['repair-request-v2', kind, item.source_id, item.slug, revision, item.cursor.phase, item.cursor.id, attempt]
      : ['repair-request-v1', kind, item.source_id, item.slug, revision, attempt]);
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
    explicit?: boolean; expect?: string; includeAmbiguous?: boolean; includeCrossEntity?: boolean; only?: string[]; skip?: string[]; slugs?: string[]; noLlm?: boolean;
    prefer?: 'file' | 'database'; requests?: string[]; allDrifted?: boolean; driftClass?: string; since?: string; held?: boolean; side?: string; state?: string;
    provenance?: string; cursor?: string; progress?: ProgressReporter;
    keep?: 'prior' | 'disk' | 'withdrawn'; requestId?: string; olderThan?: string; includeFailures?: boolean; force?: boolean; from?: string; close?: boolean; afterPage?: number; generations?: GenerationsSelection; day?: string;
    spec?: Pick<RepairKindSpec, 'explicit_only' | 'consent' | 'spends'>; maxLlmUsd?: number; deadline?: number; now?: () => number;
    /** GBRA-133: the CLI's termination signal; the apply stops before the next item with a result instead of dying mid-run. */
    stop?: AbortSignal;
    /** GBRA-133: the CLI's apply records a database refusal as a stop with a result; other callers (cycle, remediation) keep the rethrow. */
    recordDatabaseStops?: boolean;
    /** Test seam: who publishes this run's admissions (default: this process's consumer, else a live full one on this host). */
    publicationOwner?: () => Promise<{ alive: boolean; owner: string }> }): Promise<RepairResult> {
  // #6696 (A5): an approved local repair is the operator's own write; a maintenance cycle's background scope still wins.
  return withAdmissionOrigin('interactive', () => runRepairScoped(ctx, handler, scope, opts));
}

async function runRepairScoped(ctx: OperationContext, handler: RepairHandler, scope: RepairScope,
  opts: Parameters<typeof runRepair>[3]): Promise<RepairResult> {
  const { repairSpec, explicitKindRequired } = await import('./registry.ts');
  const spec = opts.spec ?? repairSpec(handler.kind);
  if (spec?.explicit_only && opts.explicit !== true) throw explicitKindRequired(handler.kind);
  if (opts.apply) await initializeLocalPersistence(ctx);
  const { cursor: resumed, runId: storedRunId } = await readCursor(ctx.engine, handler.kind, scope, opts.apply ? opts.expect : undefined);
  const now = opts.now ?? Date.now;
  const planOpts: RepairPlanOptions = { apply: opts.apply, expect: opts.expect, includeAmbiguous: opts.includeAmbiguous, only: opts.only, skip: opts.skip,
    ...(opts.includeCrossEntity ? { includeCrossEntity: true } : {}),
    ...(opts.slugs?.length ? { slugs: opts.slugs } : {}), ...(opts.noLlm ? { noLlm: true } : {}), ...(opts.maxLlmUsd !== undefined ? { maxLlmUsd: opts.maxLlmUsd } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), remote: ctx.remote !== false,
    ...(opts.prefer ? { prefer: opts.prefer } : {}), ...(opts.requests?.length ? { requests: opts.requests } : {}),
    ...(opts.allDrifted ? { allDrifted: true } : {}), ...(opts.driftClass ? { driftClass: opts.driftClass } : {}), ...(opts.since ? { since: opts.since } : {}),
    ...(opts.held ? { held: true } : {}), ...(opts.side ? { side: opts.side } : {}), ...(opts.state ? { state: opts.state } : {}),
    ...(opts.provenance ? { provenance: opts.provenance } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}), ...(opts.progress ? { progress: opts.progress } : {}),
    ...(opts.keep ? { keep: opts.keep } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.olderThan ? { olderThan: opts.olderThan } : {}), ...(opts.includeFailures ? { includeFailures: true } : {}), ...(opts.force ? { force: true } : {}),
    ...(opts.from ? { from: opts.from } : {}), ...(opts.close ? { close: true } : {}), ...(opts.afterPage !== undefined ? { afterPage: opts.afterPage } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.generations ? { generations: opts.generations } : {}),
    ...(opts.day ? { day: opts.day } : {}) };
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
    cost: { lifetime_ids: admits, receipt_bytes: admits * RECEIPT_RESERVATION_FLOOR, embedding_pages: handler.embeds === false ? 0 : pending.length,
      embedding_usd: embeddingUsd(pending.reduce((sum, item) => sum + item.chars, 0), opts.embeddingModel),
      ...(llm ? { llm_usd: opts.apply || !plan.llm ? 0 : plan.llm.usd === null ? null
        : pending.some(item => item.llm_usd !== undefined) ? pending.reduce((sum, item) => sum + (item.llm_usd ?? 0), 0) : plan.llm.usd,
      llm_cap_remaining_usd: llmLeft(0) } : {}) },
    capacity: counters.map(({ scope: key, resource, used, limit, stop_at }) => ({ scope: key, resource, used, limit, stop_at })),
    resumed_from: resumed, applied: 0, skipped: 0, failed: [], complete: false, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
    apply_command: `gbrain repair ${handler.kind}${opts.sourceFlag ? ` --source ${opts.sourceFlag}` : ''}${(opts.applyArgs ?? []).map(arg => ` ${arg}`).join('')}`
      + `${opts.requestId ? ` --request-id ${opts.requestId}` : ''}${opts.keep ? ` --keep ${opts.keep}` : ''}`
      + `${[...(opts.only ?? []).flatMap(path => ['--only', path]), ...(opts.skip ?? []).flatMap(path => ['--skip', path]),
        ...(opts.slugs ?? []).flatMap(slug => ['--slug', slug]), ...(opts.from ? ['--from', opts.from] : []), ...(opts.close ? ['--close'] : []),
        ...(opts.requests ?? []).flatMap(id => ['--request', id]),
        ...(opts.allDrifted ? ['--all-drifted'] : []), ...(opts.driftClass ? ['--class', opts.driftClass] : []), ...(opts.since ? ['--since', opts.since] : []),
        ...(opts.held ? ['--held'] : []), ...(opts.side ? ['--side', opts.side] : []), ...(opts.state ? ['--state', opts.state] : []),
        ...(opts.provenance ? ['--provenance', opts.provenance] : []), ...(opts.cursor ? ['--cursor', opts.cursor] : []),
        ...(opts.prefer ? ['--prefer', opts.prefer] : [])].map(arg => ` ${shellQuote([arg])}`).join('')}`
      + `${opts.includeAmbiguous ? ' --include-ambiguous' : ''}${opts.includeCrossEntity ? ' --include-cross-entity' : ''}${llm && opts.noLlm ? ' --no-llm' : ''}${llm && opts.maxLlmUsd !== undefined ? ` --max-usd ${opts.maxLlmUsd}` : ''}`
      + ` --apply${plan.preview_hash ? ` --expect ${plan.preview_hash}` : ''}${spec?.consent === 'destructive' ? ' --yes' : ''}`,
    ...(plan.scan ? { scan: plan.scan } : {}),
  };
  const items = new ItemRun('repair.apply_items');
  const failedItems: Array<{ item: RepairItem; failure: ItemFailure }> = [];
  const finish = async (): Promise<RepairResult> => {
    if (failedItems.length && handler.onItemFailures && result.stopped?.reason !== 'item_failures_systemic') await handler.onItemFailures(ctx, failedItems);
    if (handler.report) Object.assign(result, await handler.report(ctx, scope, result, planOpts));
    if (opts.apply) opts.progress?.finish();
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
  // #6543 (D1): accepted-but-pending items; the cursor stays before the first of them, and every stop settles them first.
  const unresolved: PendingRepair[] = [];
  const settleMs = ctx.writeWaitMs ?? 5_000, window = admits ? await repairAdmissionWindow(ctx.engine) : 1;
  let latest: RepairCursor | null = null;
  const cursorNow = () => unresolved.length ? unresolved[0].index ? pending[unresolved[0].index - 1].cursor : resumed : latest;
  const advance = (cursor: RepairCursor) => { latest = cursor; return writeCursor(ctx.engine, handler.kind, scope, cursorNow(), runId, opts.expect); };
  const settle = async (target: number): Promise<boolean> => {
    if (!unresolved.length) return true;
    for (const done of await settleRepairReceipts(ctx.engine, unresolved, target, settleMs, now)) {
      unresolved.splice(unresolved.findIndex(open => open.request_id === done.request_id), 1);
      if (done.state === 'committed') {
        result.applied++;
        if (result.outcomes) result.outcomes = { ...result.outcomes, committed_after_wait: (result.outcomes.committed_after_wait ?? 0) + 1 };
      } else if (done.error_code === 'revision_conflict') result.skipped++;
      else result.failed.push({ item: `${done.item.source_id}:${done.item.slug}`, source_id: done.item.source_id, slug: done.item.slug, reason: done.error_code ?? done.state,
        message: redactConnectionInfo(done.error_message ?? `The write ended ${done.state}.`), retry: 'next_full_scan' });
    }
    if (latest) await writeCursor(ctx.engine, handler.kind, scope, cursorNow(), runId, opts.expect);
    return unresolved.length <= target;
  };
  const pendingStop = (why: string) => {
    result.pending = unresolved.map(({ item, request_id }) => ({ item: `${item.source_id}:${item.slug}`, request_id }));
    const [first] = unresolved;
    return { reason: 'write_pending', message: (unresolved.length === 1 ? `The repair of ${first.item.source_id}:${first.item.slug} was accepted and is still pending publication`
      : `${unresolved.length} repairs were accepted and are still pending publication (first: ${first.item.source_id}:${first.item.slug})`)
      + `${why}. Rerun \`${result.apply_command}\` to resume; the same ${unresolved.length === 1 ? 'request is' : 'requests are'} replayed.` };
  };
  const stopAfterSettle = async (stopped: NonNullable<RepairResult['stopped']>): Promise<RepairResult> => {
    if (!await settle(0)) stopped = { ...stopped, message: `${stopped.message} ${pendingStop('').message}` };
    result.stopped = stopped;
    return finish();
  };
  if (opts.apply) opts.progress?.start(`repair.${handler.kind}.apply`, pending.length);
  for (const [index, item] of pending.entries()) {
    const remaining = pending.length - index;
    opts.progress?.tick(1, `${item.source_id}:${item.slug}`);
    // A preview-bound kind may retire its approved set with its last item, so every earlier receipt settles before that item runs.
    const lastApproved = !!opts.expect && index === plan.items.length - 1;
    // An item on a page this run's pending write is still changing waits for it, so it writes the page's new revision.
    const samePage = unresolved.some(open => open.item.source_id === item.source_id && open.item.slug === item.slug);
    if (unresolved.length && (unresolved.length >= window || lastApproved || samePage) && !await settle(lastApproved || samePage ? 0 : window - 1)) {
      result.stopped = pendingStop(settleMs ? `; nothing published for ${Math.round(settleMs / 1000)}s` : '');
      return finish();
    }
    if (opts.stop?.aborted) {
      return stopAfterSettle({ reason: 'interrupted', message: `Stopped before ${item.source_id}:${item.slug}: this process received ${String(opts.stop.reason ?? 'a termination signal')} `
        + `(${remaining} item(s) still pending; the items before it stay applied). Rerun \`${result.apply_command}\` to resume.` });
    }
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      return stopAfterSettle({ reason: 'time_budget', message: `Stopped before ${item.source_id}:${item.slug}: this run reached its time budget (${remaining} item(s) still pending). `
        + `The next run resumes; rerun \`${result.apply_command}\` to continue now.` });
    }
    const allowanceLeft = opts.maxLlmUsd !== undefined ? opts.maxLlmUsd - llmSpent : undefined;
    if (llm && allowanceLeft !== undefined && (llmSpent >= opts.maxLlmUsd! || (item.llm_usd !== undefined && item.llm_usd > allowanceLeft + 1e-9))) {
      return stopAfterSettle({ reason: 'budget_exhausted', message: `Stopped before ${item.source_id}:${item.slug}: this run's paid-model allowance `
        + `${llmSpent >= opts.maxLlmUsd! ? 'is used up' : `cannot cover its estimate ($${item.llm_usd!.toFixed(4)})`} `
        + `($${llmSpent.toFixed(4)} spent of $${opts.maxLlmUsd!.toFixed(4)}; ${remaining} item(s) still pending). Rerun \`${result.apply_command}\` to resume.` });
    }
    const full = admits ? (await capacity(ctx)).find(c => c.used + (c.resource === 'lifetime_ids' ? 1 : RECEIPT_RESERVATION_FLOOR) > c.stop_at) : undefined;
    if (full) {
      const perItem = full.resource === 'lifetime_ids' ? 1 : RECEIPT_RESERVATION_FLOOR;
      const needed = Math.ceil((full.used + remaining * perItem) / STOP_RATIO) + 1;
      return stopAfterSettle({ reason: 'capacity', message: `Stopped before crossing 90% of ${full.scope} ${full.resource} (${full.used} of ${full.limit} used; `
        + `${remaining} item(s) still need ${remaining * perItem} more). Run: gbrain config set ${full.config_key} ${needed} — then rerun \`${result.apply_command}\` to resume.` });
    }
    try {
      const applied = await handler.apply({ ...ctx, sourceId: item.source_id, ...(unresolved.length ? { writeWaitMs: 0 } : {}) }, item, { embed: opts.embed === true, runId,
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
      if (typeof applied === 'object' && applied.failure !== undefined) {
        const { systemic: heldStop } = items.record(`${item.source_id}:${item.slug}`, applied.failure);
        if (heldStop) {
          return stopAfterSettle({ reason: heldStop.code, message: redactConnectionInfo(`${heldStop.message} Fix the shared cause, then rerun \`${result.apply_command}\` to resume.`),
            fix: readFix(`Previews ${handler.kind} again (read-only) to show whether the shared cause is gone.`, { argv: ['gbrain', 'repair', handler.kind, ...(opts.sourceFlag ? ['--source', opts.sourceFlag] : []), '--json'] }) });
        }
      } else items.succeed();
      if (typeof applied === 'object' ? applied.applied : applied) result.applied++;
      else result.skipped++;
      if (typeof applied === 'object' && applied.stop) {
        await advance(item.cursor);
        return stopAfterSettle(applied.stop);
      }
      if (typeof applied === 'object' && applied.failure !== undefined) continue;
    } catch (error) {
      // A page edited since planning is left for the next full scan.
      if (error instanceof OperationError && error.code === 'revision_conflict') { result.skipped++; continue; }
      const receipt = acceptedPendingReceipt(error);
      if (receipt) {
        // #6543 (D1): an accepted write publishes whether or not this run waits; keep going while a consumer here publishes.
        unresolved.push({ index, item, request_id: receipt.request_id });
        const owner = await (opts.publicationOwner ?? (() => repairPublicationOwner(ctx.engine)))();
        if (owner.alive) { await advance(item.cursor); continue; }
        await writeCursor(ctx.engine, handler.kind, scope, cursorNow(), runId, opts.expect);
        result.stopped = { ...pendingStop(`, and nothing here publishes it (${owner.owner})`),
          fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', item.source_id, '--json'], consent: [], actor: 'host_admin', requires_exclusive: false,
            why: `No consumer on this host publishes the accepted repairs (${owner.owner}). Status names the owner, read-only; restart it, then rerun ${result.apply_command}.` } };
        return finish();
      }
      if (error instanceof OperationError && error.code === 'write_pending') {
        result.stopped = { reason: 'write_pending', message: `The repair of ${item.source_id}:${item.slug} was accepted and is still pending publication. `
          + `Rerun \`${result.apply_command}\` to resume; the same request is replayed.` };
        return finish();
      }
      if (writerHeld(error)) {
        return stopAfterSettle({ reason: error.code, message: `The canonical writer for source '${item.source_id}' is held (${error.code}). `
          + `Inspect it with: gbrain sources writer status ${item.source_id} — then rerun \`${result.apply_command}\` to resume.` });
      }
      // GBRA-133: a deadlock, a serialization failure or a lost database connection stops the run with what it applied and
      // the resume command in the result (the cursor stays before this item), instead of ending the command with no record.
      const database = opts.recordDatabaseStops ? classifyItemFailure(error) : null;
      if (database && database.scope === 'run' && (database.code === 'database_contention' || database.code === 'connection_lost')) {
        const sqlstate = (error as { code?: unknown } | null)?.code;
        return stopAfterSettle({ reason: database.code, message: redactConnectionInfo(`Stopped at ${item.source_id}:${item.slug}: the database refused this item`
          + `${typeof sqlstate === 'string' ? ` (${sqlstate})` : ''}: ${database.message.slice(0, 300)}. The items before it stay applied `
          + `(${remaining} item(s) still pending). Rerun \`${result.apply_command}\` to resume from this item.`),
          fix: readFix(`Previews ${handler.kind} again (read-only) to show whether the database accepts work again.`, { argv: ['gbrain', 'repair', handler.kind, ...(opts.sourceFlag ? ['--source', opts.sourceFlag] : []), '--json'] }) });
      }
      // An apply bound to an approved preview (`--expect`) applies that set or answers why not; only the kinds' own refusals continue it.
      if (opts.expect && !(error instanceof OperationError && REPAIR_ITEM_FAILURE_CODES.has(error.code))) throw error;
      const { failure, systemic: stop } = items.record(`${item.source_id}:${item.slug}`, error);
      if (stop) {
        return stopAfterSettle({ reason: stop.code, message: redactConnectionInfo(`${stop.message} Fix the shared cause, then rerun \`${result.apply_command}\` to resume.`),
          fix: readFix(`Previews ${handler.kind} again (read-only) to show whether the shared cause is gone.`, { argv: ['gbrain', 'repair', handler.kind, ...(opts.sourceFlag ? ['--source', opts.sourceFlag] : []), '--json'] }) });
      }
      // A per-item failure: recorded, nothing written, no cursor for it; the next full scan retries it (PR #6459, GBRA-130).
      const message = redactConnectionInfo(failure.message);
      const failedItem = `${item.source_id}:${item.slug}`;
      result.failed.push({ item: failedItem, source_id: item.source_id, slug: item.slug, reason: failure.code, message, retry: 'next_full_scan',
        fix: readFix(`Previews ${handler.kind} for source ${item.source_id} (read-only); it lists ${item.slug} again with its current state. A run with no stored cursor retries it.`,
          { argv: ['gbrain', 'repair', handler.kind, '--source', item.source_id, '--json'] }) });
      failedItems.push({ item, failure });
      result.outcomes = { ...result.outcomes, failed: (result.outcomes?.failed ?? 0) + 1 };
      if ((result.outcome_items ??= []).length < (handler.outcomeItemsLimit ?? SAMPLE * 2)) {
        result.outcome_items.push({ item: failedItem, outcome: 'failed', reason: failure.code, detail: { message } });
      }
      continue;
    }
    await advance(item.cursor);
  }
  if (!await settle(0)) {
    result.stopped = pendingStop(settleMs ? `; nothing published for ${Math.round(settleMs / 1000)}s` : '');
    return finish();
  }
  result.complete = pending.length === plan.items.length;
  // A limited run whose attempted items all failed keeps no cursor either: the next run is a full scan, not a resume past them.
  if (result.complete || (latest === null && result.failed.length > 0)) await writeCursor(ctx.engine, handler.kind, scope, null, null, opts.expect);
  return finish();
}

/** Cursor order shared by the kinds' SQL: (phase, id) strictly after `after`. */
export function afterCursor(item: RepairCursor, after: RepairCursor | null): boolean {
  return !after || item.phase > after.phase || (item.phase === after.phase && item.id > after.id);
}
