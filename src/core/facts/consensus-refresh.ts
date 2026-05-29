/**
 * v0.42.0.0 — world_knowledge consensus-refresh minion (Confer fork).
 *
 * This is the engine the merged `src/core/facts/world-knowledge.ts` header
 * flagged as "a separate supervised change ... intentionally out of scope
 * here." The kind + the promotion RULE shipped in 0.42.0.0; nothing yet
 * COMPUTES consensus into the cache or RE-KINDS graduated rows. This module
 * is that missing pass.
 *
 * What it does, in one idempotent pass over a source's `take_proposals`:
 *   (a) REFRESH `take_proposals.world_consensus` from the `confer_world_consensus`
 *       VIEW (migrate.ts v109 / src/migrations/0003). The view is the source of
 *       truth; the column is a nightly cache. We copy view→column per proposal id.
 *   (b) PROMOTE: for every proposal whose page carries an `escalated_from`
 *       lineage link (the upstream `links` primitive with link_type
 *       'escalated_from', declared by the confer-everything-v1 pack — NOT a
 *       column), call the MERGED `classifyWorldKnowledge(...)` with the freshly
 *       refreshed consensus. When it returns `world_knowledge`, re-kind the row
 *       (`take_proposals.kind` 'take' → 'world_knowledge').
 *
 * SAFETY (matches the merged classifier's contract — see world-knowledge.ts):
 *   - Promotes ONLY `take` → `world_knowledge`. classifyWorldKnowledge never
 *     demotes and never touches fact/bet/hunch, and we additionally scope the
 *     UPDATE `WHERE kind = 'take'` so a concurrent writer can't have us clobber
 *     a non-take row between SELECT and UPDATE.
 *   - IDEMPOTENT: re-running with no new consensus/lineage is a no-op. The
 *     consensus refresh only writes when the cached value actually differs
 *     (`IS DISTINCT FROM`); the re-kind only fires on rows still `kind='take'`.
 *     A row already at `world_knowledge` is skipped (the classifier returns it
 *     unchanged; the `WHERE kind='take'` guard means zero UPDATEs).
 *   - DRY-RUN: `dryRun: true` performs the same reads + the same promotion
 *     decision but issues NO writes; it reports what WOULD change. Used by
 *     `gbrain facts consensus-refresh --dry-run` for the supervised first run.
 *   - Postgres-only effect: `confer_world_consensus` is a Postgres view
 *     (FILTER + JSONB ->> + ::float). On a PGLite local/code-search brain the
 *     view does not exist; the pass no-ops with a clear skip reason rather than
 *     throwing (mirrors migrate.ts v109's `sqlFor.postgres`-only entry and the
 *     `engine.kind === 'postgres'` guards in doctor.ts).
 *
 * LOCKING: takes the shared DB-backed lock (db-lock.ts, the same
 * `gbrain_cycle_locks` table the cycle + sync use) under a dedicated lock id so
 * two concurrent refresh passes for the same source can't double-write. Mirrors
 * how cycle.ts / performSync acquire their own narrow lock ids.
 *
 * This module is PURE of the CLI: it takes an engine + opts and returns a
 * structured result, so it unit-tests against a mock engine exactly like
 * propose-takes.ts. The `gbrain facts consensus-refresh` command
 * (src/commands/consensus-refresh.ts) is the thin runnable wrapper.
 *
 * NOT SCHEDULED. Per the task + the merged header's "first prod run needs
 * supervision" note, nothing here installs a cron. Scheduling is a separate,
 * supervised deploy step. Run it by hand (ideally `--dry-run` first).
 */

import {
  classifyWorldKnowledge,
  WORLD_KNOWLEDGE_KIND,
  PROMOTABLE_SOURCE_KIND,
  WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD,
} from './world-knowledge.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../db-lock.ts';
import type { BrainEngine } from '../engine.ts';

/**
 * The `escalated_from` link_type, declared by the confer-everything-v1 pack
 * over the upstream `links` primitive (NOT a column — see
 * src/migrations/0002_confer_epistemology.sql header). A take "has lineage"
 * iff its page is the `from_page` of ≥1 link of this type.
 */
export const ESCALATED_FROM_LINK_TYPE = 'escalated_from';

/**
 * Dedicated DB lock id for the consensus-refresh pass. Parameterized by source
 * so per-source passes don't serialize against each other, mirroring
 * cycle.ts's `gbrain-cycle:<source>` and db-lock.ts's `syncLockId(source)`.
 */
const CONSENSUS_REFRESH_LOCK_BASE = 'gbrain-consensus-refresh';
/** Lock TTL in minutes. A refresh pass is short; 5m matches the cycle lock TTL. */
const CONSENSUS_REFRESH_LOCK_TTL_MINUTES = 5;

export function consensusRefreshLockId(sourceId: string): string {
  return `${CONSENSUS_REFRESH_LOCK_BASE}:${sourceId}`;
}

export interface ConsensusRefreshOpts {
  /** Source to scope the pass to. Defaults to 'default'. */
  sourceId?: string;
  /**
   * When true, perform every read + the promotion decision but issue NO
   * writes. Reports what WOULD be refreshed / promoted. The supervised first
   * prod run should use this.
   */
  dryRun?: boolean;
  /** Optional structured logger (matches OperationContext.logger shape). */
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/** One row the pass would re-kind (for dry-run reporting + tests). */
export interface PromotionCandidate {
  take_proposal_id: number;
  page_slug: string;
  claim_text: string;
  world_consensus: number;
}

export interface ConsensusRefreshResult {
  /** 'ok' on a completed pass; 'skipped' when no-op (lock busy / no view / no engine). */
  status: 'ok' | 'skipped';
  /** Present when status='skipped'. */
  reason?: 'lock_busy' | 'view_unavailable' | 'no_proposals';
  /** True iff this was a dry-run (no writes issued). */
  dry_run: boolean;
  source_id: string;
  /** Proposals examined this pass. */
  proposals_scanned: number;
  /**
   * Number of `world_consensus` cache cells that changed (or WOULD change in
   * dry-run) because the view's value differed from the stored column.
   */
  consensus_refreshed: number;
  /** Rows promoted take→world_knowledge (or WOULD be, in dry-run). */
  promoted: number;
  /** The rows promoted/would-be-promoted, for audit + the --dry-run report. */
  promotions: PromotionCandidate[];
  warnings: string[];
}

/**
 * Shape of one joined row we read per proposal: the proposal's identity, its
 * current kind, the cached consensus column, the freshly computed view value,
 * and whether the proposal's page has an escalated_from link. Computed entirely
 * in SQL so the promotion decision sees a consistent snapshot.
 */
interface RefreshRow {
  take_proposal_id: number;
  page_slug: string;
  claim_text: string;
  kind: string;
  stored_consensus: number | null;
  view_consensus: number | null;
  has_escalated_from: boolean;
}

/**
 * The join that powers the pass. Per `take_proposals` row in the source:
 *   - LEFT JOIN the confer_world_consensus VIEW (keyed on take_proposal_id) for
 *     the freshly computed consensus.
 *   - LEFT JOIN pages (by slug + source) to reach the proposal's page id, then
 *     EXISTS over `links` to test for an outgoing `escalated_from` edge.
 *
 * Postgres-specific (the view + boolean EXISTS). Guarded by an engine.kind
 * check before we ever run it.
 */
const REFRESH_SELECT = `
  SELECT
    tp.id                               AS take_proposal_id,
    tp.page_slug                        AS page_slug,
    tp.claim_text                       AS claim_text,
    tp.kind                             AS kind,
    tp.world_consensus                  AS stored_consensus,
    cwc.world_consensus                 AS view_consensus,
    EXISTS (
      SELECT 1
        FROM links l
        JOIN pages p
          ON p.id = l.from_page_id
       WHERE p.slug = tp.page_slug
         AND p.source_id = tp.source_id
         AND l.link_type = $2
    )                                   AS has_escalated_from
  FROM take_proposals tp
  LEFT JOIN confer_world_consensus cwc
    ON cwc.take_proposal_id = tp.id
  WHERE tp.source_id = $1
`;

/** Detect whether the confer_world_consensus view exists on this engine. */
async function viewExists(engine: BrainEngine): Promise<boolean> {
  // Postgres-only feature. PGLite local/code brains never have the view.
  if (engine.kind !== 'postgres') return false;
  try {
    const rows = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.views
         WHERE table_name = 'confer_world_consensus'
       ) AS exists`,
    );
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

/**
 * Run one consensus-refresh + promotion pass. Acquires the per-source DB lock,
 * refreshes the consensus cache from the view, and re-kinds graduated takes via
 * the merged classifier. Idempotent; honors dryRun.
 *
 * The function owns the lock lifecycle but NOT the engine lifecycle (the caller
 * connects/disconnects), matching propose-takes / migrate-engine.
 */
export async function runConsensusRefresh(
  engine: BrainEngine,
  opts: ConsensusRefreshOpts = {},
): Promise<ConsensusRefreshResult> {
  const sourceId = opts.sourceId ?? 'default';
  const dryRun = opts.dryRun ?? false;
  const log = opts.logger;

  const result: ConsensusRefreshResult = {
    status: 'ok',
    dry_run: dryRun,
    source_id: sourceId,
    proposals_scanned: 0,
    consensus_refreshed: 0,
    promoted: 0,
    promotions: [],
    warnings: [],
  };

  // The view only exists on Postgres. Skip cleanly on PGLite (no throw) so the
  // command is safe to invoke on a local code-search brain.
  if (!(await viewExists(engine))) {
    result.status = 'skipped';
    result.reason = 'view_unavailable';
    result.warnings.push(
      engine.kind === 'postgres'
        ? 'confer_world_consensus view not found — run `gbrain apply-migrations` (v109) first.'
        : 'consensus-refresh is Postgres-only (confer_world_consensus is a Postgres view); no-op on PGLite.',
    );
    log?.warn(result.warnings[result.warnings.length - 1]!);
    return result;
  }

  // Acquire the per-source lock so two passes can't double-write. A busy lock
  // means another pass (or cron) is already running for this source — skip,
  // don't block. Dry-run still takes the lock: it reads the same rows the live
  // pass would mutate, and we want a consistent snapshot. (Cheap; released in
  // finally.)
  const lockId = consensusRefreshLockId(sourceId);
  const handle: DbLockHandle | null = await tryAcquireDbLock(
    engine,
    lockId,
    CONSENSUS_REFRESH_LOCK_TTL_MINUTES,
  );
  if (!handle) {
    result.status = 'skipped';
    result.reason = 'lock_busy';
    result.warnings.push(`another consensus-refresh pass holds ${lockId}; skipped.`);
    log?.warn(result.warnings[result.warnings.length - 1]!);
    return result;
  }

  try {
    const rows = await engine.executeRaw<RefreshRow>(REFRESH_SELECT, [
      sourceId,
      ESCALATED_FROM_LINK_TYPE,
    ]);
    result.proposals_scanned = rows.length;
    if (rows.length === 0) {
      result.status = 'skipped';
      result.reason = 'no_proposals';
      return result;
    }

    for (const row of rows) {
      // ── (a) Refresh the consensus cache from the view ──────────────────
      // Normalize null→null; the view emits NULL when no agreement signal
      // exists. We only write when the cached column actually differs (the
      // idempotency guard: re-running an unchanged source issues 0 writes).
      const viewConsensus = row.view_consensus;
      const storedConsensus = row.stored_consensus;
      const consensusChanged = !numericEq(storedConsensus, viewConsensus);
      if (consensusChanged) {
        result.consensus_refreshed += 1;
        if (!dryRun) {
          // COALESCE to the column default (0.0) when the view yields NULL so
          // the NOT-NULL-friendly REAL column never goes NULL via this path.
          await engine.executeRaw(
            `UPDATE take_proposals
                SET world_consensus = COALESCE($2, 0.0)
              WHERE id = $1
                AND world_consensus IS DISTINCT FROM COALESCE($2, 0.0)`,
            [row.take_proposal_id, viewConsensus],
          );
        }
      }

      // ── (b) Promote take → world_knowledge via the MERGED classifier ───
      // Use the FRESH view value (what we just refreshed to), not the stale
      // stored column, so a single pass both refreshes and promotes coherently.
      const effectiveKind = classifyWorldKnowledge({
        kind: row.kind,
        hasEscalatedFromLineage: row.has_escalated_from === true,
        worldConsensus: viewConsensus,
      });

      if (effectiveKind === WORLD_KNOWLEDGE_KIND && row.kind === PROMOTABLE_SOURCE_KIND) {
        const candidate: PromotionCandidate = {
          take_proposal_id: row.take_proposal_id,
          page_slug: row.page_slug,
          claim_text: row.claim_text,
          world_consensus: viewConsensus ?? 0,
        };
        result.promotions.push(candidate);
        result.promoted += 1;
        if (!dryRun) {
          // Re-kind. The `kind = 'take'` guard makes this SAFE under
          // concurrency and IDEMPOTENT: a row already promoted (or changed to a
          // non-take kind by another writer) matches zero rows. We NEVER demote
          // and NEVER touch fact/bet/hunch — the guard + the classifier's
          // take-only rule both enforce that.
          await engine.executeRaw(
            `UPDATE take_proposals
                SET kind = $2
              WHERE id = $1
                AND kind = $3`,
            [row.take_proposal_id, WORLD_KNOWLEDGE_KIND, PROMOTABLE_SOURCE_KIND],
          );
        }
      }
    }

    const verb = dryRun ? 'WOULD refresh' : 'refreshed';
    const verb2 = dryRun ? 'WOULD promote' : 'promoted';
    log?.info(
      `consensus-refresh[${sourceId}]${dryRun ? ' (dry-run)' : ''}: ` +
        `scanned ${result.proposals_scanned}, ${verb} ${result.consensus_refreshed} consensus cells, ` +
        `${verb2} ${result.promoted} take→world_knowledge (threshold ${WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD}).`,
    );

    return result;
  } finally {
    // Release the lock even on throw. release() is idempotent (db-lock.ts).
    try {
      await handle.release();
    } catch {
      /* idempotent — registerCleanup also covers abnormal exit */
    }
  }
}

/**
 * Null-aware numeric equality for the consensus cache compare. Treats null and
 * a stored 0.0 as DIFFERENT only when one side is null and the other isn't —
 * but because the live UPDATE COALESCEs null→0.0, a stored 0.0 vs a view NULL
 * are treated as equal here too (both normalize to 0.0) so we don't churn a
 * write every pass. Mirrors the SQL `IS DISTINCT FROM COALESCE($2,0.0)` guard.
 */
function numericEq(stored: number | null, view: number | null): boolean {
  const s = stored ?? 0;
  const v = view ?? 0;
  // REAL round-trips can introduce 1-ULP drift; treat within 1e-9 as equal so a
  // re-run doesn't rewrite an effectively-identical value (keeps it idempotent).
  return Math.abs(s - v) < 1e-9;
}

/** Test-only surface (mirrors propose-takes.ts `__testing`). */
export const __testing = {
  REFRESH_SELECT,
  numericEq,
  ESCALATED_FROM_LINK_TYPE,
  consensusRefreshLockId,
};
