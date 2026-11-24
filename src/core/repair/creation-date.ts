import { parseDateLoose, PAGE_TEMPORAL_KEYS } from '../effective-date.ts';
import { parseMarkdown } from '../markdown.ts';

/** Add the page's recorded creation instant without rewriting existing Markdown. */
export function addVerifiedCreationDate(markdown: string, slug: string, createdAt: Date): string | null {
  const opening = /^\uFEFF?---(\r?\n)/.exec(markdown);
  if (!opening || !Number.isFinite(createdAt.valueOf())) return null;
  const parsed = parseMarkdown(markdown, slug);
  if (parsed.errors?.length || Object.hasOwn(parsed.frontmatter, 'created') ||
      PAGE_TEMPORAL_KEYS.some(key => parseDateLoose(parsed.frontmatter[key]) !== null)) return null;
  return opening[0] + `created: '${createdAt.toISOString()}'` + opening[1] + markdown.slice(opening[0].length);
}
