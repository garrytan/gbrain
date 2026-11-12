/**
 * `strict_facts_outside_git` (GST-2492 PR 2): for each strict source (`config.canonical = "git"`), the facts the git-gap
 * census counts with no Git home (unfenced, fenced on a missing page, fenced on a page with no file and no declared class)
 * the facts held on memory/unattributed for longer than 30 days, and held facts that cannot move (a page that cannot take
 * them, or a bare name two pages match, named as candidates). Ok when all are 0. Otherwise a warning with the
 * counts by group (facts/facts-home.ts), any `held_fact_unmovable` rows with their reason, and the read-only preview of
 * `gbrain repair facts-home` as the fix. A source that is not strict is not judged (its database keeps such facts by
 * design); `db_ahead_of_git` stays informational. Bounded by the same budget as the census (`GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS`).
 */
import type { Check } from '../../doctor.ts';
import { scanDeadline } from '../budget.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import { censusGitGap, factsWithoutGitHome } from '../../sources-git-gap.ts';
import { FACTS_HOME_DOCS, factsHomePreviewCommand, scanFactsHome, type FactsHomeGroup } from '../../../core/facts/facts-home.ts';
import { gitGapScanTimeoutMs } from './db-ahead-of-git.ts';

interface SourceFacts { source_id: string; complete: boolean; outside_git: number; held_over_30_days: number; groups: Partial<Record<FactsHomeGroup, number>>;
  held_fact_unmovable: Array<{ code: 'held_fact_unmovable'; fact_id: number; entity_slug: string | null; reason: string }> }

async function runStrictFactsOutsideGit(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('strict_facts_outside_git');
  const checks: Check[] = [];
  try {
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id`);
    if (!rows.length) {
      checks.push({ name: 'strict_facts_outside_git', status: 'ok', details: { sources: [], docs: FACTS_HOME_DOCS },
        message: 'No source is strict (git-canonical), so no fact is required to have a Git home.' });
      return checks;
    }
    const deadlineAt = scanDeadline(ctx, gitGapScanTimeoutMs());
    const sources: SourceFacts[] = [];
    for (const row of rows) {
      const census = await censusGitGap(engine, row.id, { sample: 0, deadlineAt });
      const scan = await scanFactsHome(engine, row.id);
      sources.push({ source_id: row.id, complete: census.complete, outside_git: factsWithoutGitHome(census.rows_without_git_home),
        held_over_30_days: scan.counts.held_over_30_days,
        groups: Object.fromEntries(Object.entries(scan.counts).filter(([, n]) => n > 0)),
        held_fact_unmovable: scan.rows.filter(r => r.group === 'held_fact_unmovable').slice(0, 20)
          .map(r => ({ code: 'held_fact_unmovable' as const, fact_id: r.id, entity_slug: r.entity_slug, reason: r.reason ?? 'unknown' })) });
    }
    const details = { sources, docs: FACTS_HOME_DOCS };
    const flagged = sources.filter(source => source.outside_git > 0 || source.held_over_30_days > 0 || source.held_fact_unmovable.length > 0);
    if (!flagged.length) {
      checks.push({ name: 'strict_facts_outside_git', status: 'ok', details,
        message: `Every fact of each strict source has a Git home and none has been held for more than 30 days: ${sources.map(s => `${s.source_id}${s.complete ? '' : ' (census partial)'}`).join(', ')}.` });
      return checks;
    }
    const describe = (source: SourceFacts) => `${source.source_id}: ${source.outside_git} fact(s) without a Git home${source.complete ? '' : ' (census partial)'}, `
      + `${source.held_over_30_days} held over 30 days${Object.keys(source.groups).length ? ` (${Object.entries(source.groups).map(([group, n]) => `${group} ${n}`).join(', ')})` : ''}`
      + `${source.held_fact_unmovable.length ? `; held_fact_unmovable: ${source.held_fact_unmovable.map(r => `fact ${r.fact_id} for ${r.entity_slug} (${r.reason})`).join(', ')}` : ''}`;
    const first = flagged[0]!.source_id;
    checks.push({ name: 'strict_facts_outside_git', status: 'warn', details,
      message: `${flagged.length} strict source(s) hold facts that Git does not have, facts held for a page that has not appeared, or held facts that cannot move: ${flagged.map(describe).join('; ')}. `
        + 'A database rebuilt from Git would lose the facts without a Git home. Preview what the repair would do; it writes nothing until you apply the hash it prints.',
      fix: { argv: [...factsHomePreviewCommand(first).split(' '), '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `Lists the facts of ${first} without a Git home by group, read-only; its --apply --expect <hash> writes the ones it can to memory/unattributed. Repeat for each source in details.sources.`,
        verify: doctorVerify('strict_facts_outside_git') } });
  } catch (error) {
    checks.push({ name: 'strict_facts_outside_git', status: 'ok', details: { health: 'unknown', docs: FACTS_HOME_DOCS },
      message: `Could not count the facts of strict sources without a Git home (${error instanceof Error ? error.message : String(error)}); gbrain sources git-gap <source-id> counts them for one source.` });
  }
  return checks;
}

export const strictFactsOutsideGitEntry: DoctorEntry = { name: 'strict_facts_outside_git', emits: ['strict_facts_outside_git'], run: runStrictFactsOutsideGit };
