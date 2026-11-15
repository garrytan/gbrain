/**
 * `db_ahead_of_git` (git-canonical memory, wave G1, docs/designs/GIT_CANONICAL_MEMORY.md): for each source with a
 * checkout, the totals of the read-only git-gap census (`gbrain sources git-gap`, commands/sources-git-gap.ts): pages
 * equal to their committed blob at HEAD, database_ahead or git_ahead of it, declared or undeclared database-only, only in
 * the working tree, unparseable. Informational in this release: ok whatever the gap, because nothing converts a source yet.
 * GBRA-541: the census reads the `DOCTOR_GIT_GAP_NEWEST` most recently changed live pages per source (an uncommitted
 * database write is among them) and states that window as the oldest `updated_at` it read; `gbrain sources git-gap` reads
 * them all. Bounded by `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (default 10 s) and the entry's deadline; a source the budget
 * stopped or never reached, or one the census could not read, makes the check the unknown convention (`warn`,
 * `health: unknown`), never ok. A source whose directory is not a Git checkout is only counted. Totals only, never a
 * slug or path.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { scanDeadline } from '../budget.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { censusGitGap, GIT_GAP_DOCS, type GitGapCensus } from '../../sources-git-gap.ts';
import { isGitCheckout } from '../../../core/persistence/git-gap.ts';
import { currentStatementDeadline } from '../../../core/statement-deadline.ts';
import type { BrainEngine } from '../../../core/engine.ts';

/** `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (default 10 s): the wall-clock bound of the census across every source. */
export function gitGapScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/**
 * GBRA-541: the most recently changed live pages per source the doctor census reads: about half the 10 s scan bound (800
 * pages took 4.7 to 5.4 s on a synthetic 300,000-page Postgres brain, 4 cores); `gbrain sources git-gap <id>` reads every page.
 */
export const DOCTOR_GIT_GAP_NEWEST = 800;

type SourceTotals = Pick<GitGapCensus, 'source_id' | 'complete' | 'pages' | 'live_pages' | 'newest' | 'newest_since' | 'states' | 'declared' | 'worktree'>;

/**
 * The doctor's newest-pages census of one source, read once per run: a complete census is kept in the run's memo, so
 * `strict_facts_outside_git` reuses the one `db_ahead_of_git` read instead of walking the same pages again. A partial
 * one is never kept.
 */
export async function doctorGitGapCensus(engine: BrainEngine, sourceId: string, deadlineAt: number): Promise<GitGapCensus> {
  const memo = currentStatementDeadline()?.memo;
  const key = `git_gap_census:${sourceId}`;
  const kept = memo?.get(key) as Promise<GitGapCensus> | undefined;
  if (kept) return kept;
  const census = await censusGitGap(engine, sourceId, { sample: 0, deadlineAt, newest: DOCTOR_GIT_GAP_NEWEST });
  if (census.complete) memo?.set(key, Promise.resolve(census));
  return census;
}

/** What a doctor census covered: every live page, or the newest window back to its oldest `updated_at`. */
export function censusWindow(source: Pick<GitGapCensus, 'complete' | 'pages' | 'live_pages' | 'newest_since'>): string {
  if (!source.complete) return `PARTIAL, ${source.pages} of ${source.live_pages} live page(s) read`;
  if (source.pages >= source.live_pages) return `${source.live_pages} live page(s)`;
  return `checked the ${source.pages} most recently changed of ${source.live_pages} live page(s), back to ${source.newest_since}`;
}

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
        const { source_id, complete, pages, live_pages, newest, newest_since, states, declared, worktree } = await doctorGitGapCensus(engine, row.id, deadlineAt);
        sources.push({ source_id, complete, pages, live_pages, newest, newest_since, states, declared, worktree });
      } catch (error) {
        errors.push({ source_id: row.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const partial = [...sources.filter(source => !source.complete).map(source => source.source_id), ...unread];
    const unknown = partial.length > 0 || errors.length > 0;
    const details = { informational: true, sources, partial_sources: partial, errors, sources_without_git_checkout: rows.length - withCheckout.length,
      newest: DOCTOR_GIT_GAP_NEWEST, timeout_ms: gitGapScanTimeoutMs(), docs: GIT_GAP_DOCS, ...(partial.length ? boundUnknownDetails('git_gap_timeout') : errors.length ? { health: 'unknown' } : {}) };
    const listed = sources.map(source => `${source.source_id}: ${censusWindow(source)}, ${nonzero(source.states)}`);
    const message = withCheckout.length
      ? `${unknown ? 'Health unknown, not clear (a source was not read in full or could not be compared):' : 'Informational, nothing to do:'} the database compared with the commit at HEAD, per source with a Git checkout.${listed.length ? ` ${listed.join('; ')}.` : ''}`
        + `${unread.length ? ` Not reached within the ${details.timeout_ms / 1000}s budget: ${unread.join(', ')}.` : ''}`
        + `${errors.length ? ` Could not compare: ${errors.map(e => `${e.source_id} (${e.message})`).join('; ')}.` : ''}`
        + ` Page detail: gbrain sources git-gap <source-id>.`
      : 'No source has a Git checkout, so there is no commit to compare the database with.';
    checks.push({ name: 'db_ahead_of_git', status: unknown ? 'warn' : 'ok', details, message });
  } catch (error) {
    checks.push({ name: 'db_ahead_of_git', status: 'warn', details: { informational: true, health: 'unknown', docs: GIT_GAP_DOCS },
      message: `Health unknown, not clear: the git-gap census could not run (${error instanceof Error ? error.message : String(error)}); run gbrain sources git-gap <source-id> for one source.` });
  }
  return checks;
}

export const dbAheadOfGitEntry: DoctorEntry = { name: 'db_ahead_of_git', emits: ['db_ahead_of_git'], run: runDbAheadOfGit };
