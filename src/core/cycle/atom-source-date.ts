/**
 * #6720: the content date a page-derived atom inherits from its source page.
 *
 * Read with the extraction input, before the model call, and serialized as
 * the atom's frontmatter `date`, so classic import and managed publication
 * (including a retained-output retry) store the same `effective_date`
 * instead of the extraction run time. The stored projection wins; a legacy
 * page without one is dated by the same precedence chain import uses.
 * Transcript-derived atoms use transcriptSourceDate below.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { computeEffectiveDate } from '../effective-date.ts';
import { parseMarkdownHead } from '../markdown.ts';

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
 * The content date a transcript-derived atom inherits: the transcript's own
 * frontmatter date (`event_date`, `date`, `published`), else `pathDate`, the
 * date in its file path that also names the atom's slug folder, else a
 * frontmatter created key. Null when the transcript carries no date, so the
 * atom keeps the import fallback rather than a borrowed one.
 */
export async function transcriptSourceDate(engine: Pick<BrainEngine, 'getConfig'>, content: string, pathDate: string): Promise<string | null> {
  const { date } = computeEffectiveDate({
    slug: '', frontmatter: parseMarkdownHead(content).frontmatter, filename: pathDate,
    createdAt: new Date(NaN), updatedAt: new Date(NaN),
    timeZone: (await engine.getConfig('brain.timezone').catch(() => null)) ?? undefined, // fail-soft: a config read never rejects the phase
  });
  return date ? date.toISOString() : null;
}
