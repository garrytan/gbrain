/**
 * Barrel export + convenience installer for the four built-in validators.
 */

import type { BrainWriter, PageValidator } from '../writer.ts';
import { citationValidator } from './citation.ts';
import { linkValidator } from './link.ts';
import { backLinkValidator } from './back-link.ts';
import { tripleHrValidator } from './triple-hr.ts';

export { citationValidator, linkValidator, backLinkValidator, tripleHrValidator };

/**
 * The single registry of built-in validators. registerBuiltinValidators,
 * runPostWriteLint, and FIX_HINTS all derive from this list — never a
 * parallel hardcoded copy. A validator added here without a matching
 * FIX_HINTS entry fails the completeness pin in
 * test/put-page-writer-lint.test.ts.
 */
export const BUILTIN_VALIDATORS: readonly PageValidator[] = [
  citationValidator,
  linkValidator,
  backLinkValidator,
  tripleHrValidator,
];

/** Register all built-in validators on a BrainWriter instance. */
export function registerBuiltinValidators(writer: BrainWriter): void {
  for (const v of BUILTIN_VALIDATORS) writer.register(v);
}

/**
 * One actionable fix hint per built-in validator, keyed by validator id.
 * Shipped verbatim in put_page's `writer_lint.top_findings` so a consumer
 * can act on a finding without reading validator source. Keys must cover
 * every BUILTIN_VALIDATORS id (pinned by the completeness test).
 */
export const FIX_HINTS: Readonly<Record<string, string>> = {
  [citationValidator.id]:
    'add a [Source: ...] citation marker (or an inline https:// link) to each factual paragraph, or set frontmatter validate: false to opt this page out',
  [linkValidator.id]:
    'fix or remove the dangling wikilink — the target page does not exist in this source (check the slug, or create the page first)',
  [backLinkValidator.id]:
    'informational — the linked page does not link back; runAutoLink reconciles reverse edges on its next put_page, or add the back-link there yourself',
  [tripleHrValidator.id]:
    'remove the bare "---" line from compiled_truth (it re-splits the page on round-trip); only the triple-HR bar between compiled truth and timeline may use it',
};
