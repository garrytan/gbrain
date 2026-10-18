/**
 * #6948: the sync-time heal of duplicate-origin twins. A file several live pages record as their origin is held by sync
 * (`origin_conflict`); when they are verified duplicates (persistence/origin-twins.ts: the canonical page by path, one
 * inline body, readable file, compatible ids, one visibility and trust tier, no slug-keyed withdrawals, no file at a
 * twin's own slug path), nothing is ambiguous. So right after a managed sync of a source finishes and releases its drain
 * lease, this re-reads each such hold's group from the database and the file at the last synced commit, re-runs the
 * verdict, and merges each twin into the canonical page through the same coordinated write `gbrain repair origin-twins`
 * applies (`resolveOriginTwin`). Each resolved file is scheduled for re-screen, so the next sync imports it.
 *
 * Guards, as #6865's slug heal (slug-autoheal.ts): skipped on dry runs and non-ok results, under remote submission
 * authority, while the source has an unfinished sync cursor, and when `sync.origin_twins.auto_resolve` is false;
 * bounded (`ORIGIN_HEAL_MAX_FILES`, `ORIGIN_HEAL_BUDGET_MS` or the caller's deadline). Mass valve: when the planned
 * twin deletions are over half of the source's file-backed pages, nothing is merged and the repair preview is named.
 * The heal never builds the index. Nothing here runs at upgrade; a failure never fails the sync.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { serr } from '../console-prefix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { readGitSourceHolds } from '../persistence/sync-holds.ts';
import { ORIGIN_TWINS_AUTO_RESOLVE_KEY, originTwinsPreviewArgv, readOriginClaimants } from '../persistence/origin-twins.ts';
import { syncOriginPath } from '../persistence/sync-origin.ts';
import { groupPairs, massTwins, originGroupVerdict, originOwnerContext, resolveOriginTwin, type OriginTwinGroup } from './origin-twins.ts';
import { repairRequestId } from './core.ts';

export const ORIGIN_HEAL_BUDGET_MS = 60_000;
export const ORIGIN_HEAL_MAX_FILES = 200;
/** Twin pages the heal soft-deletes per source in any 24 h (merges by the repair count too); past it the repair preview is named. */
export const ORIGIN_HEAL_DAILY_MAX = 1000;
const FALSE = /^(false|0|off|no)$/i;
const TRUE = /^(true|1|on|yes)$/i;
const OK_STATUSES: ReadonlyArray<SyncResult['status']> = ['synced', 'first_sync', 'up_to_date'];

/** `gbrain config set` refusal text for a value that is not a boolean; null when it is one. */
export function originAutoResolveValueRefusal(value: string): string | null {
  return TRUE.test(value.trim()) || FALSE.test(value.trim()) ? null : `${ORIGIN_TWINS_AUTO_RESOLVE_KEY} must be true or false (got "${value}"). Nothing was written.`;
}

export interface OriginHealReport {
  /** Held files whose twins were merged into the canonical page; each imports on the next sync. */
  resolved: number;
  /** Twin pages soft-deleted by those merges. */
  twins_merged: number;
  pending: number;
  failed: number;
  left_by_reason: Record<string, number>;
  /** Up to 20 resolved files. */
  resolved_paths: string[];
  /** One receipt per merged twin (slugs, moved counts, dropped frontmatter, restore argv), up to 20. */
  receipts: Array<Record<string, unknown>>;
  skipped?: 'disabled' | 'remote_authority' | 'sync_unfinished' | 'not_owner_host' | 'mass_valve' | 'daily_cap';
  notice: string;
  preview_argv: string[];
  opt_out_argv: string[];
}

async function unfinishedCursor(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'
    AND completed_keys->0->>'sourceId'=$1 LIMIT 1`, [sourceId]);
  return rows.length > 0;
}

function skipReason(skipped: NonNullable<OriginHealReport['skipped']>): string {
  if (skipped === 'disabled') return `${ORIGIN_TWINS_AUTO_RESOLVE_KEY} is false`;
  if (skipped === 'remote_authority') return 'this sync runs under a remote job or agent';
  if (skipped === 'sync_unfinished') return 'the source still has an unfinished sync cursor';
  if (skipped === 'mass_valve') return "the twins are over half of the source's file-backed pages";
  if (skipped === 'daily_cap') return `the heal already merged ${ORIGIN_HEAL_DAILY_MAX} twin page(s) of this source in the last 24 h`;
  return 'this host does not own the source checkout';
}

function noticeOf(sourceId: string, r: Omit<OriginHealReport, 'notice' | 'preview_argv' | 'opt_out_argv'>): string {
  const preview = originTwinsPreviewArgv(sourceId).join(' ');
  if (r.skipped) return `[sync] ${r.pending} file(s) of source ${sourceId} are recorded by several live pages; sync left them held because ${skipReason(r.skipped)}. Preview the fix with ${preview} (read-only).`;
  const left = Object.values(r.left_by_reason).reduce((a, b) => a + b, 0);
  const more = r.pending ? `; ${r.pending} more wait for the next sync` : '';
  const failed = r.failed ? `; ${r.failed} failed (${preview} shows why)` : '';
  const person = left ? `; ${left} held file(s) need a person (${preview})` : '';
  return `[sync] resolved ${r.resolved} file(s) of source ${sourceId} recorded by duplicate pages: ${r.twins_merged} twin page(s) merged into the page each path names `
    + `(links moved, slug kept as an alias, soft-deleted without touching the file; restorable for 72 h)${more}${failed}${person}. Opt out: gbrain config set ${ORIGIN_TWINS_AUTO_RESOLVE_KEY} false.`;
}

/** The post-sync heal of one managed source; returns the result with the report. Never throws. */
export async function healOriginTwinsAfterManagedSync(engine: BrainEngine, outer: SyncOpts, result: SyncResult, now: () => number = Date.now): Promise<SyncResult> {
  if (outer.dryRun || !OK_STATUSES.includes(result.status)) return result;
  const sourceId = outer.sourceId ?? 'default';
  try {
    const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.code === 'origin_conflict');
    if (!holds.length) return result;
    const base = { resolved: 0, twins_merged: 0, pending: holds.length, failed: 0, left_by_reason: {} as Record<string, number>, resolved_paths: [] as string[], receipts: [] as Array<Record<string, unknown>> };
    const authority = currentSubmissionAuthority();
    const skip: OriginHealReport['skipped'] = FALSE.test(String(await engine.getConfig(ORIGIN_TWINS_AUTO_RESOLVE_KEY) ?? '').trim()) ? 'disabled'
      : authority && authority.kind !== 'application' ? 'remote_authority' : await unfinishedCursor(engine, sourceId) ? 'sync_unfinished' : undefined;
    const context = skip ? null : await originOwnerContext(engine, sourceId);
    if (skip || !context?.ok) return withReport(result, sourceId, { ...base, skipped: skip ?? 'not_owner_host' });
    const groups: Array<{ path: string; group: OriginTwinGroup }> = [];
    for (const hold of [...holds].sort((a, b) => a.path.localeCompare(b.path)).slice(0, ORIGIN_HEAL_MAX_FILES)) {
      const origin = syncOriginPath(hold.source_path ?? hold.path);
      const live = await engine.executeRaw<{ id: number; source_path: string }>('SELECT id, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id=ANY($2::bigint[])',
        [sourceId, (hold.meta.origin_claimants ?? []).map(page => page.id)]);
      const claimants = await readOriginClaimants(engine, sourceId, live.map(row => Number(row.id)));
      const verdict = claimants.length > 1 ? await originGroupVerdict(engine, context, origin, claimants) : null;
      if (!verdict || verdict.verdict !== 'resolve') {
        const reason = verdict && verdict.verdict === 'hold' ? verdict.reason : 'no_longer_twins';
        base.left_by_reason[reason] = (base.left_by_reason[reason] ?? 0) + 1;
        base.pending--;
        continue;
      }
      const pathOf = new Map(live.map(row => [Number(row.id), row.source_path]));
      groups.push({ path: hold.path, group: { source_id: sourceId, source_path: origin, canonical: verdict.canonical, reason: null,
        claimants: [verdict.survivor, ...verdict.twins].map(page => ({ page_id: page.id, slug: page.slug, revision: page.revision, source_path: pathOf.get(page.id)! })) } });
    }
    const [counted] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    if (massTwins(groups.reduce((n, entry) => n + entry.group.claimants.length - 1, 0), Number(counted?.n ?? 0))) return withReport(result, sourceId, { ...base, skipped: 'mass_valve' });
    const [today] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND database_only_reason='origin_twin'
      AND deleted_at > now() - interval '24 hours'`, [sourceId]);
    let budget = ORIGIN_HEAL_DAILY_MAX - Number(today?.n ?? 0);
    if (budget <= 0) return withReport(result, sourceId, { ...base, skipped: 'daily_cap' });
    const { loadConfig } = await import('../config.ts');
    const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, logger: { info: () => {}, warn: (m: string) => serr(m), error: (m: string) => serr(m) },
      remote: false, dryRun: false, sourceId } as unknown as OperationContext;
    const deadline = Math.min(now() + ORIGIN_HEAL_BUDGET_MS, outer.deadlineAtMs ?? Infinity);
    const healed: string[] = [];
    for (const { path, group } of groups) {
      if (now() >= deadline || outer.signal?.aborted || budget < group.claimants.length - 1) break;
      base.pending--;
      budget -= group.claimants.length - 1;
      let all = true;
      for (const pair of groupPairs(group)) {
        try {
          const outcome = await resolveOriginTwin(ctx, pair, context.owner,
            () => repairRequestId(ctx, 'origin-twins', { source_id: sourceId, slug: pair.twin.slug }, `merge:${pair.survivor.revision}:${pair.twin.revision}`));
          if (!outcome.applied) { all = false; base.left_by_reason[outcome.outcome] = (base.left_by_reason[outcome.outcome] ?? 0) + 1; break; }
          base.twins_merged++;
          if (base.receipts.length < 20 && outcome.detail) base.receipts.push(outcome.detail);
        } catch (error) {
          all = false; base.failed++;
          serr(`[sync] could not resolve the duplicate pages of ${path}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
      if (all) { healed.push(path); base.resolved++; }
    }
    return withReport(result, sourceId, { ...base, resolved_paths: healed.slice(0, 20) });
  } catch (error) {
    serr(`[sync] the duplicate-origin heal of source ${sourceId} did not run (${error instanceof Error ? error.message : String(error)}); gbrain repair origin-twins --source ${sourceId} resolves them.`);
    return result;
  }
}

function withReport(result: SyncResult, sourceId: string, report: Omit<OriginHealReport, 'notice' | 'preview_argv' | 'opt_out_argv'>): SyncResult {
  const notice = noticeOf(sourceId, report);
  if (report.resolved || report.failed || report.skipped === 'mass_valve' || report.skipped === 'remote_authority') serr(notice);
  return { ...result, origin_twins_resolved: { ...report, notice, preview_argv: originTwinsPreviewArgv(sourceId), opt_out_argv: ['gbrain', 'config', 'set', ORIGIN_TWINS_AUTO_RESOLVE_KEY, 'false'] } };
}
