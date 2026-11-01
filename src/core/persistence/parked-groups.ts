import type { BrainEngine } from '../engine.ts';
import { GIT_PUSH_CODES } from './git-push-holds.ts';

/**
 * #7985: parked Git effects recorded under a binding the source no longer has. `binding_changed`: the source moved to
 * another worktree (or its binding names another incarnation), so the binding guard refuses a retry `source_changed`;
 * `source_replaced`: the source was archived, removed or re-created since. The bulk retry of the current binding never
 * selects them, so its zero is not their clearance.
 */
export interface FormerBinding { reason: 'binding_changed' | 'source_replaced'; worktree_ids: string[]; current_worktree_id: string | null; requests: string[] }

/** GBRA-133: one source's parked Git targets of one error code, with the one command that retries them all. */
export interface ParkedGroup { source_id: string; code: string; effects: number; targets: number; rule?: string; command: string[]; next: string; former_binding?: FormerBinding }

/** SQL that is true when effect `e` belongs to its source's current binding: the binding guard's own test. */
export const CURRENT_BINDING_SQL = `(e.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_source_bindings sb
  WHERE sb.source_id=e.source_id AND sb.worktree_id=e.worktree_id AND sb.source_incarnation::text=e.source_incarnation::text))`;

/**
 * Parked Git targets per source and error code (doctor `parked_effects`, `sources writer status`). Each group names its
 * bulk retry (`--parked-pushes` for push codes, `--parked-code <code>` otherwise) as a preview. A `git_target_ignored`
 * group names the .gitignore rule and says the rule has to change first: a retry while it stands parks again. Other groups
 * also name the settle preview (#7423, #7378) for targets a retry can never move; settled effects are not counted.
 * #7985: effects of a former binding form their own group (`former_binding`) naming their recorded worktree, the current
 * one, up to five request ids and the settle preview (`--retire` for a replaced source), never the bulk retry that cannot select them.
 */
export async function readParkedGroups(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<ParkedGroup[]> {
  const rows = await engine.executeRaw<{ source_id: string; code: string; former: FormerBinding['reason'] | null; effects: number; targets: number;
    rule: string | null; worktree_ids: string[]; current_worktree_id: string | null; requests: string[] }>(
    `WITH parked AS (
       SELECT e.id, e.source_id, e.worktree_id, r.request_id, p->>'error_code' AS code, p->>'rule' AS rule,
              CASE WHEN ${CURRENT_BINDING_SQL} THEN NULL
                WHEN EXISTS (SELECT 1 FROM sources src WHERE src.id=e.source_id AND NOT src.archived AND src.incarnation::text=e.source_incarnation::text)
                THEN 'binding_changed' ELSE 'source_replaced' END AS former
         FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id CROSS JOIN LATERAL jsonb_array_elements(e.data->'parked') p
        WHERE e.kind='git' AND e.state='failed' AND e.error_code='targets_parked' AND jsonb_typeof(e.data->'parked')='array' AND NOT (e.data ? 'settled')
          AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[])))
     SELECT source_id, code, former, count(DISTINCT id)::int AS effects, count(*)::int AS targets, min(rule) AS rule,
            array_agg(DISTINCT worktree_id::text) AS worktree_ids, (array_agg(DISTINCT request_id::text))[1:5] AS requests,
            (SELECT sb.worktree_id::text FROM persistence_source_bindings sb WHERE sb.source_id=parked.source_id) AS current_worktree_id
       FROM parked GROUP BY source_id, code, former ORDER BY source_id, code, former NULLS FIRST`, [sourceIds ?? null]);
  return rows.map(({ rule, former, worktree_ids, current_worktree_id, requests, ...row }) => {
    if (former) {
      const command = ['gbrain', 'sources', 'writer', 'settle-effects', row.source_id, '--parked-code', row.code, ...(former === 'source_replaced' ? ['--retire'] : []), '--dry-run'];
      const recorded = `${row.effects} parked Git effect(s) of source ${row.source_id} (requests ${requests.join(', ')}) were recorded under worktree ${worktree_ids.join(', ')}`;
      const next = former === 'binding_changed'
        ? `${recorded}, a former canonical binding: the source is now bound to ${current_worktree_id ?? 'no worktree'}. retry-effects refuses them (source_changed) and the bulk retry selects none of them, so its zero is not a clearance. Preview settling them on proof: ${command.join(' ')}; an effect it refuses stays parked and its refusal names what is missing. One whose page has since moved on or been deleted can be retired instead (the same preview with --retire; ask the user before applying). Never claim or transfer the source to force them through.`
        : `${recorded}, under an earlier incarnation of the source (archived, removed or re-created since), so they owe nothing to the current source and retry never runs them. Preview recording that: ${command.join(' ')}, and apply it only after the user agrees; never re-create, claim or transfer the source to force them through.`;
      return { ...row, command, next, former_binding: { reason: former, worktree_ids, current_worktree_id, requests } };
    }
    const push = (GIT_PUSH_CODES as readonly string[]).includes(row.code);
    const command = ['gbrain', 'sources', 'writer', 'retry-effects', row.source_id, ...(push ? ['--parked-pushes'] : ['--parked-code', row.code]), '--dry-run'];
    const settle = `gbrain sources writer settle-effects ${row.source_id} --parked-code ${row.code} --dry-run`;
    const next = row.code === 'git_target_ignored'
      ? `Git ignores these files${rule ? ` (${rule})` : ''}, so a retry parks them again while the rule stands. Change the rule and commit it, then preview ${command.join(' ')} and rerun it without --dry-run; or keep the files out of Git and leave them parked (their pages are committed in the database).`
      : `Fix the cause, then preview ${command.join(' ')} and rerun it without --dry-run to authorize one more attempt per target. A target that can never succeed (now declared db_only) settles on proof instead: preview ${settle}.`;
    return { ...row, ...(rule ? { rule } : {}), command, next };
  });
}
