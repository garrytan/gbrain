/**
 * synopsis_tier_coverage (#8744): the configured contextual-retrieval tier is
 * per_chunk_synopsis (search.mode tokenmax, or a source override) but import
 * and sync embed pages at the title tier and nothing schedules the synopsis
 * sweep, so a brain can search on title-tier vectors for weeks while it
 * reports tokenmax. Warns when the synopsis tier is missing from most eligible
 * chunks, with the coverage and the preview of the explicit sweep
 * (`gbrain reindex --synopsis`). Database reads only: repo-less brains are
 * covered the same way.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';


export async function checkSynopsisTierCoverage(engine: BrainEngine, opts: { sourceIds?: string[] } = {}): Promise<Check> {
  try {
    const sweep = await import('../../../core/synopsis-sweep.ts');
    const read = await sweep.readSynopsisTierConfig(engine);
    const granted = opts.sourceIds ? read.synopsis_sources.filter(id => opts.sourceIds!.includes(id)) : read.synopsis_sources;
    const config = { ...read, synopsis_sources: granted, configured: !read.kill_switch && (read.global_tier === 'per_chunk_synopsis' || granted.length > 0) };
    if (!config.configured) {
      return infoCheck('synopsis_tier_coverage', `Not applicable: the configured contextual-retrieval tier is ${config.kill_switch ? 'off (kill switch)' : config.global_tier}, not per_chunk_synopsis.`,
        'not_applicable', undefined, { configured: false, global_tier: config.global_tier });
    }
    const { embeddingsDisabled } = await import('../../../core/embedding-disabled.ts');
    if (await embeddingsDisabled(engine)) {
      return infoCheck('synopsis_tier_coverage', 'Not applicable: embeddings are disabled on this brain, so no tier applies (keyword search keeps working).', 'disabled_by_choice', undefined, { configured: true });
    }
    const coverage = await sweep.readSynopsisCoverage(engine, { sourceIds: opts.sourceIds, config });
    const last = opts.sourceIds ? null : await sweep.readLastSynopsisSweep(engine);
    const sweepNote = last === null ? '' : last.jobs === 0 ? ' No synopsis sweep job has ever run.' : ` Last sweep job finished ${last.last_finished_at ?? 'never'} (${last.jobs} job(s) recorded).`;
    const details = {
      configured: true,
      global_tier: config.global_tier,
      synopsis_sources: config.synopsis_sources,
      eligible_pages: coverage.eligible_pages,
      eligible_chunks: coverage.eligible_chunks,
      synopsis_pages: coverage.synopsis_pages,
      synopsis_chunks: coverage.synopsis_chunks,
      coverage_pct: coverage.coverage_pct,
      page_coverage_pct: coverage.eligible_pages ? Math.floor((coverage.synopsis_pages / coverage.eligible_pages) * 1000) / 10 : null,
      large_title_pages: coverage.large_title_pages,
      large_title_chunks: coverage.large_title_chunks,
      ...(last ? { sweep_jobs: last.jobs, last_sweep_finished_at: last.last_finished_at } : {}),
      fix: sweep.SYNOPSIS_SWEEP_ARGV.join(' '),
    };
    const message = sweep.formatSynopsisCoverageLine(coverage) + sweepNote;
    const missingMost = coverage.coverage_pct !== null && coverage.coverage_pct < sweep.SYNOPSIS_COVERAGE_WARN_PCT;
    const pending = coverage.eligible_chunks > coverage.synopsis_chunks;
    return {
      name: 'synopsis_tier_coverage',
      status: missingMost ? 'warn' : 'ok',
      message,
      details,
      ...(pending ? { fix: agentFix([...sweep.SYNOPSIS_SWEEP_ARGV],
        'Previews the per-chunk synopsis sweep (pages, chunks, tokens and dollars on the configured synopsis model) and changes nothing; it runs only with --yes, which is paid work the user approves.',
        'synopsis_tier_coverage') } : {}),
    };
  } catch (e) {
    return checkError('synopsis_tier_coverage', 'check synopsis tier coverage', e);
  }
}
