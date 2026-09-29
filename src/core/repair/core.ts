/**
 * `gbrain repair <kind>` core: one scope resolver, a resumable per-kind cursor,
 * the capacity stop, and the dry-run / apply loop shared by every kind.
 *
 * Every applied item is one coordinated page write (a `put_page` bound to the
 * page's current revision), so a repair never bypasses the persistence
 * coordinator and each item commits or fails on its own. A kind that only
 * rebuilds derived projections (`safe-chunks`) takes no admission instead: its
 * items cost no lifetime IDs or receipt bytes and never hit the capacity stop.
 * Items are processed in
 * a stable order and the cursor after the last committed item is stored in
 * `op_checkpoints` under a fingerprint of (kind, brain, sources): a rerun with
 * the same scope resumes after it, and a finished scan clears it.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { readJournalLimits, journalLimitKey } from '../persistence/limits.ts';
import { isTerminal, principalKey } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from '../embedding-pricing.ts';

export const REPAIR_KINDS = ['timeline', 'visibility', 'safe-chunks'] as const;
export type RepairKind = typeof REPAIR_KINDS[number];

export interface RepairScope { brain_id: string; source_ids: string[] }

/** A stable position in a kind's item order; items after it are pending. */
export interface RepairCursor { phase: number; id: number }

export interface RepairItem {
  cursor: RepairCursor; source_id: string; slug: string; chars: number; action: string;
  /** Kind-specific planned change, rechecked against the page before it is applied. */
  change?: { from: string | null; to: string };
}

export interface RepairPlan {
  items: RepairItem[];
  /** Counts of rows the kind keeps and reports instead of repairing. */
  residuals: Record<string, number>;
}

export interface RepairHandler {
  kind: RepairKind;
  /** `projection`: items rebuild derived rows only and take no journal admission. Default `coordinated`. */
  publication?: 'coordinated' | 'projection';
  /** Pending items after `after`, in cursor order. */
  plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null): Promise<RepairPlan>;
  /** Apply one item; `false` when it no longer needs repair. `embed` is false under --no-embed. */
  apply(ctx: OperationContext, item: RepairItem, opts?: { embed: boolean }): Promise<boolean>;
}

export interface RepairResult {
  kind: RepairKind;
  mode: 'dry_run' | 'apply';
  scope: RepairScope;
  affected: number;
  sample: string[];
  residuals: Record<string, number>;
  cost: { lifetime_ids: number; receipt_bytes: number; embedding_pages: number; embedding_usd: number | null };
  capacity: Array<{ scope: string; resource: string; used: number; limit: number; stop_at: number }>;
  resumed_from: RepairCursor | null;
  applied: number;
  skipped: number;
  complete: boolean;
  stopped?: { reason: string; message: string };
  apply_command: string;
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

function fingerprint(kind: RepairKind, scope: RepairScope): string {
  return digest(['repair-v1', kind, scope.brain_id, scope.source_ids]);
}

async function readCursor(engine: BrainEngine, kind: RepairKind, scope: RepairScope): Promise<RepairCursor | null> {
  const [row] = await engine.executeRaw<{ completed_keys: Array<{ cursor?: RepairCursor }> }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='repair' AND fingerprint=$1", [fingerprint(kind, scope)]);
  return row?.completed_keys[0]?.cursor ?? null;
}

async function writeCursor(engine: BrainEngine, kind: RepairKind, scope: RepairScope, cursor: RepairCursor | null): Promise<void> {
  if (!cursor) {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair' AND fingerprint=$1", [fingerprint(kind, scope)]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('repair',$1,$2::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [fingerprint(kind, scope), JSON.stringify([{ kind, scope, cursor }])]);
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

export async function runRepair(ctx: OperationContext, handler: RepairHandler, scope: RepairScope,
  opts: { apply: boolean; limit?: number; embeddingModel?: string; sourceFlag?: string; embed?: boolean; applyArgs?: string[] }): Promise<RepairResult> {
  if (opts.apply) await initializeLocalPersistence(ctx);
  const resumed = await readCursor(ctx.engine, handler.kind, scope);
  const plan = await handler.plan(ctx.engine, scope, resumed);
  const pending = opts.limit !== undefined ? plan.items.slice(0, opts.limit) : plan.items;
  const counters = await capacity(ctx);
  const admits = (handler.publication ?? 'coordinated') === 'coordinated' ? pending.length : 0;
  const result: RepairResult = {
    kind: handler.kind, mode: opts.apply ? 'apply' : 'dry_run', scope, affected: plan.items.length,
    sample: plan.items.slice(0, SAMPLE).map(item => `${item.source_id}:${item.slug}`), residuals: plan.residuals,
    cost: { lifetime_ids: admits, receipt_bytes: admits * RECEIPT_BYTES, embedding_pages: pending.length,
      embedding_usd: embeddingUsd(pending.reduce((sum, item) => sum + item.chars, 0), opts.embeddingModel) },
    capacity: counters.map(({ scope: key, resource, used, limit, stop_at }) => ({ scope: key, resource, used, limit, stop_at })),
    resumed_from: resumed, applied: 0, skipped: 0, complete: false,
    apply_command: `gbrain repair ${handler.kind}${opts.sourceFlag ? ` --source ${opts.sourceFlag}` : ''}${(opts.applyArgs ?? []).map(arg => ` ${arg}`).join('')} --apply`,
  };
  if (!opts.apply) {
    result.complete = pending.length === plan.items.length;
    return result;
  }
  for (const [index, item] of pending.entries()) {
    const remaining = pending.length - index;
    const full = admits ? (await capacity(ctx)).find(c => c.used + (c.resource === 'lifetime_ids' ? 1 : RECEIPT_BYTES) > c.stop_at) : undefined;
    if (full) {
      const perItem = full.resource === 'lifetime_ids' ? 1 : RECEIPT_BYTES;
      const needed = Math.ceil((full.used + remaining * perItem) / STOP_RATIO) + 1;
      result.stopped = { reason: 'capacity', message: `Stopped before crossing 90% of ${full.scope} ${full.resource} (${full.used} of ${full.limit} used; `
        + `${remaining} item(s) still need ${remaining * perItem} more). Run: gbrain config set ${full.config_key} ${needed} — then rerun \`${result.apply_command}\` to resume.` };
      return result;
    }
    try {
      if (await handler.apply({ ...ctx, sourceId: item.source_id }, item, { embed: opts.embed === true })) result.applied++;
      else result.skipped++;
    } catch (error) {
      // A page edited since planning is left for the next full scan.
      if (error instanceof OperationError && error.code === 'revision_conflict') { result.skipped++; continue; }
      if (error instanceof OperationError && error.code === 'write_pending') {
        result.stopped = { reason: 'write_pending', message: `The repair of ${item.source_id}:${item.slug} was accepted and is still pending publication. `
          + `Rerun \`${result.apply_command}\` to resume; the same request is replayed.` };
        return result;
      }
      if (!writerHeld(error)) throw error;
      result.stopped = { reason: error.code, message: `The canonical writer for source '${item.source_id}' is held (${error.code}). `
        + `Inspect it with: gbrain sources writer status ${item.source_id} — then rerun \`${result.apply_command}\` to resume.` };
      return result;
    }
    await writeCursor(ctx.engine, handler.kind, scope, item.cursor);
  }
  result.complete = pending.length === plan.items.length;
  if (result.complete) await writeCursor(ctx.engine, handler.kind, scope, null);
  return result;
}

/** Cursor order shared by the kinds' SQL: (phase, id) strictly after `after`. */
export function afterCursor(item: RepairCursor, after: RepairCursor | null): boolean {
  return !after || item.phase > after.phase || (item.phase === after.phase && item.id > after.id);
}
