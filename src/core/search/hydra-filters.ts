/** Keep caller filters while HydraDB owns relevance and ranking. */
import type { SearchOpts } from '../types.ts';
import { resolveSearchDateBounds } from './date-bounds.ts';
import { resolveHardExcludes } from './source-boost.ts';

export interface HydraPageFields { slug: string; type?: string; date?: string | Date | null; language?: string | null; symbolKind?: string | null }

export function hydraFilter(opts: SearchOpts | undefined): (page: HydraPageFields) => boolean {
  const excludes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
  const dates = resolveSearchDateBounds(opts);
  return page => {
    if (opts?.exclude_slugs?.includes(page.slug) || excludes.some(p => page.slug.startsWith(p))) return false;
    if (opts?.type && page.type !== opts.type) return false;
    if (opts?.types && !opts.types.includes(page.type ?? '')) return false;
    if (opts?.language && page.language !== opts.language) return false;
    if (opts?.symbolKind && page.symbolKind !== opts.symbolKind) return false;
    const date = page.date ? new Date(page.date).getTime() : NaN;
    if (dates.afterDate && !(dates.afterDateInclusive ? date >= Date.parse(dates.afterDate) : date > Date.parse(dates.afterDate))) return false;
    if (dates.beforeDate && !(dates.beforeDateInclusive ? date <= Date.parse(dates.beforeDate) : date < Date.parse(dates.beforeDate))) return false;
    return true;
  };
}
