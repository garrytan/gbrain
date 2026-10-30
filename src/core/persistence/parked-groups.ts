import type { BrainEngine } from '../engine.ts';
import { GIT_PUSH_CODES } from './git-push-holds.ts';

/** GBRA-133: one source's parked Git targets of one error code, with the one command that retries them all. */
export interface ParkedGroup { source_id: string; code: string; effects: number; targets: number; rule?: string; command: string[]; next: string }

/**
 * Parked Git targets per source and error code (doctor `parked_effects`, `sources writer status`). Each group names its
 * bulk retry (`--parked-pushes` for push codes, `--parked-code <code>` otherwise) as a preview. A `git_target_ignored`
 * group names the .gitignore rule and says the rule has to change first: a retry while it stands parks again. Other groups
 * also name the settle preview (#7423, #7378) for targets a retry can never move; settled effects are not counted.
 */
export async function readParkedGroups(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<ParkedGroup[]> {
  const rows = await engine.executeRaw<{ source_id: string; code: string; effects: number; targets: number; rule: string | null }>(
    `SELECT e.source_id, p->>'error_code' AS code, count(DISTINCT e.id)::int AS effects, count(*)::int AS targets, min(p->>'rule') AS rule
       FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(e.data->'parked') p
      WHERE e.kind='git' AND e.state='failed' AND e.error_code='targets_parked' AND jsonb_typeof(e.data->'parked')='array' AND NOT (e.data ? 'settled')
        AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[]))
      GROUP BY 1, 2 ORDER BY 1, 2`, [sourceIds ?? null]);
  return rows.map(({ rule, ...row }) => {
    const push = (GIT_PUSH_CODES as readonly string[]).includes(row.code);
    const command = ['gbrain', 'sources', 'writer', 'retry-effects', row.source_id, ...(push ? ['--parked-pushes'] : ['--parked-code', row.code]), '--dry-run'];
    const settle = `gbrain sources writer settle-effects ${row.source_id} --parked-code ${row.code} --dry-run`;
    const next = row.code === 'git_target_ignored'
      ? `Git ignores these files${rule ? ` (${rule})` : ''}, so a retry parks them again while the rule stands. Change the rule and commit it, then preview ${command.join(' ')} and rerun it without --dry-run; or keep the files out of Git and leave them parked (their pages are committed in the database).`
      : `Fix the cause, then preview ${command.join(' ')} and rerun it without --dry-run to authorize one more attempt per target. A target that can never succeed (now declared db_only, or left in a former canonical worktree) settles on proof instead: preview ${settle}.`;
    return { ...row, ...(rule ? { rule } : {}), command, next };
  });
}
