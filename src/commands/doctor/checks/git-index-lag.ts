/**
 * `git_index_lag` (git-canonical memory, G3, docs/designs/GIT_CANONICAL_MEMORY.md): for each strict source
 * (`config.canonical = "git"`) with a checkout, how far its index trails the commit at HEAD: the commits after the last
 * commit a finished sync pass indexed (`sources.last_commit`) and the seconds since the oldest of them was committed
 * (sync-freshness.ts `readGitBehind`). Warns when that oldest commit is older than
 * `GBRAIN_DOCTOR_GIT_INDEX_LAG_WARN_SECONDS` (default 900) or the source was never indexed; the fix is the sync that indexes
 * it. A source that is not strict is not read. Counts and seconds only, never a sha or path.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import { readGitBehind } from '../../../core/persistence/sync-freshness.ts';
import { isGitCheckout } from '../../../core/persistence/git-gap.ts';

const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#the-model';

/** `GBRAIN_DOCTOR_GIT_INDEX_LAG_WARN_SECONDS` (default 900): how old the oldest unindexed commit of a strict source may get before a warning. */
export function gitIndexLagWarnSeconds(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_GIT_INDEX_LAG_WARN_SECONDS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

interface SourceLag { source_id: string; indexed: boolean; commits_behind: number | null; seconds_behind: number | null }

async function runGitIndexLag(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('git_index_lag');
  const warnSeconds = gitIndexLagWarnSeconds();
  const checks: Check[] = [];
  try {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null; last_commit: string | null }>(
      `SELECT id, local_path, last_commit FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id`);
    const sources: SourceLag[] = [];
    for (const row of rows) {
      if (!row.local_path || !existsSync(row.local_path) || !isGitCheckout(row.local_path)) { sources.push({ source_id: row.id, indexed: !!row.last_commit, commits_behind: null, seconds_behind: null }); continue; }
      if (!row.last_commit) { sources.push({ source_id: row.id, indexed: false, commits_behind: null, seconds_behind: null }); continue; }
      const lag = await readGitBehind(row.local_path, row.last_commit).catch(() => null);
      sources.push({ source_id: row.id, indexed: true, commits_behind: lag?.commits ?? null,
        seconds_behind: lag?.oldest == null ? (lag ? 0 : null) : Math.max(0, Math.round(Date.now() / 1000 - lag.oldest)) });
    }
    const late = sources.filter(source => !source.indexed || (source.seconds_behind ?? 0) > warnSeconds);
    const details = { sources, warn_seconds: warnSeconds, docs: DOCS };
    if (!rows.length) {
      checks.push({ name: 'git_index_lag', status: 'ok', details, message: 'No source is strict (git-canonical), so no index trails a commit.' });
      return checks;
    }
    const describe = (source: SourceLag) => !source.indexed ? `${source.source_id}: never indexed`
      : source.commits_behind === null ? `${source.source_id}: Git could not count the commits after the last indexed one`
      : `${source.source_id}: ${source.commits_behind} commit(s) behind HEAD${source.commits_behind ? `, the oldest committed ${source.seconds_behind}s ago` : ''}`;
    if (!late.length) {
      checks.push({ name: 'git_index_lag', status: 'ok', details, message: `Every strict source's index is within ${warnSeconds}s of HEAD: ${sources.map(describe).join('; ')}.` });
      return checks;
    }
    const first = late[0]!.source_id;
    checks.push({ name: 'git_index_lag', status: 'warn', details,
      message: `The index of ${late.length} strict source(s) trails its commits by more than ${warnSeconds}s: ${late.map(describe).join('; ')}. `
        + 'Git holds these commits and the database has not indexed them yet, so search and reads show older content until a sync pass indexes them.',
      fix: { argv: ['gbrain', 'sync', '--source', first, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `Indexes the commits of ${first} that the database has not read yet; the sync reads committed blobs only and Git wins. Repeat for each source in details.sources.`,
        verify: doctorVerify('git_index_lag') } });
  } catch (error) {
    checks.push({ name: 'git_index_lag', status: 'ok', details: { health: 'unknown', docs: DOCS },
      message: `Could not read the index lag of strict sources (${error instanceof Error ? error.message : String(error)}); gbrain sources status --json shows each source's watermark.` });
  }
  return checks;
}

export const gitIndexLagEntry: DoctorEntry = { name: 'git_index_lag', emits: ['git_index_lag'], run: runGitIndexLag };
