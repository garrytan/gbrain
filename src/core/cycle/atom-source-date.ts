/**
 * #6720: the content date a page-derived atom inherits from its source page.
 *
 * Read with the extraction input, before the model call, and serialized as
 * the atom's frontmatter `date`, so classic import and managed publication
 * (including a retained-output retry) store the same `effective_date`
 * instead of the extraction run time. The stored projection wins; a legacy
 * page without one is dated by the same precedence chain import uses.
 * Transcript-derived atoms have no source page and get no date.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { computeEffectiveDate } from '../effective-date.ts';

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
