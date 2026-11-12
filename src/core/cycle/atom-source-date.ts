/**
 * #6720: the content date a page-derived atom inherits from its source page.
 *
 * Read with the extraction input, before the model call, and serialized as
 * the atom's frontmatter `date`, so classic import and managed publication
 * (including a retained-output retry) store the same `effective_date`
 * instead of the extraction run time. The stored projection wins; a legacy
 * page without one is dated by the same precedence chain import uses.
 * Transcript-derived atoms have no source page: transcriptAtomSourceDate.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { computeEffectiveDate } from '../effective-date.ts';
import { transcriptFrontmatter } from './transcript-discovery.ts';

export async function atomSourceDate(engine: Pick<BrainEngine, 'getConfig'>, page: Page | null): Promise<string | null> {
  if (!page) return null;
  if (page.effective_date) return new Date(page.effective_date).toISOString();
  const { date } = computeEffectiveDate({
    slug: page.slug, frontmatter: page.frontmatter ?? {}, filename: page.slug.split('/').pop(),
    createdAt: new Date(page.created_at), updatedAt: new Date(page.updated_at),
    timeZone: (await engine.getConfig('brain.timezone')) ?? undefined,
  });
  return date ? date.toISOString() : null;
}

/**
 * #7268: the content date a transcript-derived atom inherits, by the same
 * precedence chain: the transcript's frontmatter date keys, else `pathDate`
 * (the date in its path that names its atoms/<date>/ folder). Null when it
 * carries neither; the extraction run never stands in for it. A failed
 * timezone read keeps the phase fail-soft and reads the date as UTC.
 */
export async function transcriptAtomSourceDate(engine: Pick<BrainEngine, 'getConfig'>, content: string, pathDate: string): Promise<string | null> {
  const { date } = computeEffectiveDate({
    slug: '', frontmatter: transcriptFrontmatter(content), filename: pathDate,
    createdAt: new Date(NaN), updatedAt: new Date(NaN),
    timeZone: (await engine.getConfig('brain.timezone').catch(() => null)) ?? undefined,
  });
  return date ? date.toISOString() : null;
}
