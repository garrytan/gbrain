/**
 * `db_ahead_of_git` (git-canonical memory, wave G1, docs/designs/GIT_CANONICAL_MEMORY.md): for each source with a
 * checkout, the totals of the read-only git-gap census (`gbrain sources git-gap`, commands/sources-git-gap.ts): pages
 * equal to their committed blob at HEAD, database_ahead or git_ahead of it, declared or undeclared database-only, only in
 * the working tree, unparseable. Informational in this release: always ok whatever the gap, because nothing converts a
 * source yet. Bounded by `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (default 10 s) and the entry's deadline; a source the budget
 * stopped or never reached is listed as partial; a source whose directory is not a Git checkout is only counted. Totals
 * only, never a slug or path.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { scanDeadline } from '../budget.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { censusGitGap, GIT_GAP_DOCS, type GitGapCensus } from '../../sources-git-gap.ts';
import { isGitCheckout } from '../../../core/persistence/git-gap.ts';

/** `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (default 10 s): the wall-clock bound of the census across every source. */
export function gitGapScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

type SourceTotals = Pick<GitGapCensus, 'source_id' | 'complete' | 'pages' | 'states' | 'declared' | 'worktree'>;

const nonzero = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'no pages';

async function runDbAheadOfGit(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('db_ahead_of_git');
  const deadlineAt = scanDeadline(ctx, gitGapScanTimeoutMs());
  try {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE NOT archived ORDER BY id');
    const withCheckout = rows.filter(row => row.local_path && existsSync(row.local_path) && isGitCheckout(row.local_path));
    const sources: SourceTotals[] = [], unread: string[] = [], errors: Array<{ source_id: string; message: string }> = [];
    for (const row of withCheckout) {
      if (Date.now() >= deadlineAt) { unread.push(row.id); continue; }
      try {
        const { source_id, complete, pages, states, declared, worktree } = await censusGitGap(engine, row.id, { sample: 0, deadlineAt });
        sources.push({ source_id, complete, pages, states, declared, worktree });
      } catch (error) {
        errors.push({ source_id: row.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const partial = [...sources.filter(source => !source.complete).map(source => source.source_id), ...unread];
    const details = { informational: true, sources, partial_sources: partial, errors, sources_without_git_checkout: rows.length - withCheckout.length,
      timeout_ms: gitGapScanTimeoutMs(), docs: GIT_GAP_DOCS };
    const listed = sources.map(source => `${source.source_id}: ${nonzero(source.states)}${source.complete ? '' : ' (partial)'}`);
    const message = withCheckout.length
      ? `Informational, nothing to do: the database compared with the commit at HEAD, per source with a Git checkout.${listed.length ? ` ${listed.join('; ')}.` : ''}`
        + `${unread.length ? ` Not reached within the ${details.timeout_ms / 1000}s budget: ${unread.join(', ')}.` : ''}`
        + `${errors.length ? ` Could not compare: ${errors.map(e => `${e.source_id} (${e.message})`).join('; ')}.` : ''}`
        + ` Page detail: gbrain sources git-gap <source-id>.`
      : 'No source has a Git checkout, so there is no commit to compare the database with.';
    checks.push({ name: 'db_ahead_of_git', status: 'ok', details, message });
  } catch (error) {
    checks.push({ name: 'db_ahead_of_git', status: 'ok', details: { informational: true, health: 'unknown', docs: GIT_GAP_DOCS },
      message: `Informational: the git-gap census could not run (${error instanceof Error ? error.message : String(error)}); run gbrain sources git-gap <source-id> for one source.` });
  }
  return checks;
}

export const dbAheadOfGitEntry: DoctorEntry = { name: 'db_ahead_of_git', emits: ['db_ahead_of_git'], run: runDbAheadOfGit };
