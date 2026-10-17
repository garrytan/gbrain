/**
 * `config set` value checks for `facts.*` keys: nothing is written when a
 * value is one the reader would not accept.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';
import { inertText } from '../../core/agent-output.ts';
import { NOTABILITY_FILTERS, PAGE_WRITE_NOTABILITY_FILTER_KEY, parseNotabilityFilter } from '../../core/facts/notability-filter.ts';

export async function refuseInvalidFactsConfigValue(key: string, value: string, engine?: Pick<BrainEngine, 'getConfig'>): Promise<void> {
  if (key === 'facts.page_cap.warn_rows' || key === 'facts.page_cap.max_rows') {
    const { validPageCapValue, readPageCap } = await import('../../core/facts/page-cap.ts');
    if (!validPageCapValue(value)) exitCliError(usageError(`${key} must be a nonnegative integer.`,
      `Set ${key} to 0 to disable it, or a positive integer.`), 'config');
    if (engine) {
      try { await readPageCap({ getConfig: async k => k === key ? value : engine.getConfig(k) }); }
      catch (error) { exitCliError(usageError((error as Error).message, 'Choose max_rows >= warn_rows, or disable a threshold with 0.'), 'config'); }
    }
  }
  // #6231: page-write extraction reads only the notability filters.
  if (key === PAGE_WRITE_NOTABILITY_FILTER_KEY && !parseNotabilityFilter(value)) {
    exitCliError(usageError(`${key} must be one of ${NOTABILITY_FILTERS.join(', ')} (got "${inertText(value, 80)}"). Nothing was written.`,
      `Re-run with a valid value, e.g. gbrain config set ${key} medium-and-up.`, {
        why: 'Page-write fact extraction reads only these filters.',
        fix: { argv: ['gbrain', 'config', 'set', key, '<FILTER>'], inputs: [{ name: 'FILTER', how: `One of ${NOTABILITY_FILTERS.join(', ')}; ask the user which tiers page writes should keep.` }],
          consent: [], actor: 'agent', why: 'Sets which notability tiers a page write\'s fact extraction keeps.',
          verify: { argv: ['gbrain', 'config', 'get', key] }, requires_exclusive: false },
      }), 'config');
  }
  if (key.startsWith('facts.drain_')) {
    const { validateFactsDrainConfigValue } = await import('../../core/facts/drain-config.ts');
    const err = validateFactsDrainConfigValue(key, value);
    if (err) { console.error(`[config] ${err}`); process.exit(1); }
  }
}
