/**
 * derived_visibility doctor check (#5525): extracted atoms and synthesized
 * concepts without an explicit `visibility`, and ones stored looser than their
 * origin (a transcript or missing origin counts as private, as in the repair).
 * Remote reads treat unstamped rows as private; the warning names the
 * tighten-only backfill `gbrain repair visibility` that stamps the stored rows.
 *
 * It also counts what is labelled wider than a private source: Life Chronicle
 * events whose origin is private, pages that carry a privacy alias
 * (`access: private`, ...) but no `visibility`, and active `world` facts held
 * in or extracted from a private page. Facts a remote caller can recall today
 * are listed by id (first 50); slugs stay out of the check, which remote
 * callers may run. `gbrain repair visibility` previews every row.
 *
 * The fact count, the only class remote callers can read today, runs first; each
 * statement is bounded by PLAN_STATEMENT_MS, and derived-page counts that overrun
 * it are reported as unknown while the fact count still stands.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readHonorAliases } from '../../../core/search/private-visibility.ts';
import { PLAN_STATEMENT_MS, worldFactsFromPrivateSources } from '../../../core/repair/visibility.ts';

const FACT_SAMPLE = 50;

export async function derivedVisibilityCheck(engine: BrainEngine, sourceId?: string): Promise<Check> {
  const name = 'derived_visibility';
  try {
    const aliasesHonored = await readHonorAliases(engine);
    const sources = (await engine.listAllSources()).filter(s => !sourceId || s.id === sourceId).map(s => s.id);
    const facts = await worldFactsFromPrivateSources(engine, sources);
    const readable = facts.filter(f => f.readable);
    const factDetails = { world_facts_from_private_sources: facts.length, world_facts_remotely_readable: readable.length,
      remotely_readable_fact_ids: readable.slice(0, FACT_SAMPLE).map(f => String(f.id)), fact_ids_truncated: readable.length > FACT_SAMPLE };
    const factPart = `${facts.length} active world fact(s) are held in or were extracted from a private page; ${readable.length} of them are readable by remote callers (ids in details.remotely_readable_fact_ids).`;
    const preview = 'Preview: gbrain repair visibility (it lists one window, remotely readable facts first, and prints the --apply --expect command for it; run that after the user agrees).';
    let counts;
    try {
      counts = await engine.countDerivedVisibility(sources, PLAN_STATEMENT_MS);
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== '57014') throw e;
      return { name, status: 'warn', details: { ...factDetails, derived_counts: 'unknown', count: 'lower_bound', truncated: true, repair: 'visibility' },
        message: [...(facts.length ? [factPart] : []), `Derived page counts did not finish within ${PLAN_STATEMENT_MS} ms; preview them with gbrain repair visibility --class lineage.`, preview].join(' ') };
    }
    const row = counts;
    const details = { ...row, ...factDetails, count: 'exact', truncated: false, repair: 'visibility' };
    const unstamped = row.unstamped_atoms + row.unstamped_concepts;
    const looser = row.looser_atoms + row.looser_concepts + row.looser_events;
    if (unstamped + looser + row.alias_pages_without_visibility + facts.length === 0) {
      return { name, status: 'ok', details, message: 'Every derived page and fact carries a visibility no looser than its source, and no page relies on a privacy alias alone.' };
    }
    const parts: string[] = [];
    if (unstamped + looser) parts.push(`${unstamped} derived page(s) have no explicit visibility (${row.unstamped_atoms} atoms, ${row.unstamped_concepts} concepts) `
      + `and ${looser} are stored looser than their origin (${row.looser_events} chronicle events); remote reads treat the unstamped ones as private.`);
    if (row.alias_pages_without_visibility) parts.push(`${row.alias_pages_without_visibility} page(s) mark themselves private with a privacy alias (access, confidentiality) but carry no visibility. `
      + (aliasesHonored ? 'Remote page reads hide them (to show them: gbrain config set visibility.honor_aliases false).' : 'visibility.honor_aliases is false, so remote page reads show them.'));
    if (facts.length) parts.unshift(factPart);
    parts.push(preview);
    return { name, status: 'warn', details, message: parts.join(' ') };
  } catch (e) {
    return { name, status: 'warn', message: `derived visibility check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
