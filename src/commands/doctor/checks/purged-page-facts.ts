import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { countPurgedPageFacts } from '../../../core/repair/purged-page-facts.ts';

const CAP = 10_000;

/**
 * #8859 follow-up: page-extraction facts filed on no page that purges before the #8859 fix left active although their
 * page is gone. Counts the retirable ones by class (evidenced: the purge ledger records the page; ambiguous: no purge
 * record) and names the explicit-only repair's preview. Read-only.
 */
export async function purgedPageFactsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const counted = await countPurgedPageFacts(engine, sources, CAP);
    const details = { evidenced: counted.evidenced, ambiguous: counted.ambiguous, capped: counted.capped, repair: 'purged-page-facts', docs: 'docs/guides/repair.md#purged-page-facts' };
    const total = counted.evidenced + counted.ambiguous;
    if (!total) return { name: 'purged_page_facts', status: 'ok', details, message: 'No fact extracted from a page is left active after that page was purged.' };
    return { name: 'purged_page_facts', status: 'warn', details,
      message: `${total}${counted.capped ? '+' : ''} fact(s) extracted from pages that no longer exist are still active, left by purges that ran before #8859 was fixed `
        + `(${counted.evidenced} of purged pages, ${counted.ambiguous} of pages gone with no purge record); recall still returns them. `
        + 'Preview the retirement on the brain host: gbrain repair purged-page-facts — then run the apply command it prints after the user agrees '
        + '(rows with no purge record only with gbrain repair purged-page-facts --include-ambiguous).' };
  } catch (error) {
    return { name: 'purged_page_facts', status: 'warn',
      message: `Facts left by purged pages could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
