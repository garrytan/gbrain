/**
 * Save-time entity-slug canonicalization for extract-conversation-facts.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { slugify } from '../../core/entities/resolve.ts';

// ---------------------------------------------------------------------------
// Save-time entity-slug canonicalization.
// ---------------------------------------------------------------------------

/**
 * Basename form the resolver's fallback_slugify produces (`Eve Demo`
 * -> `eve-demo`). Delegates to the resolver's own slugify so accented
 * and curly-apostrophe names fold onto the same basename the resolver mints.
 */
export function slugBasename(name: string): string {
  return slugify(name);
}

/**
 * The shipped resolver cascade mints BOTH `people/eve-demo` and
 * `eve-demo` for the same person, sometimes on the same page across two
 * runs, so `find_trajectory` (keyed on the exact slug) splits one timeline.
 * This folds a raw slug onto an existing prefixed sibling (`people/` or
 * `companies/`, from person/company pages and from facts already written)
 * when exactly one sibling exists. Raw slugs with no sibling stay raw;
 * ambiguous ones (both prefixes) stay raw. Prefixed slugs register their
 * basename so later raw forms in the same run fold onto them. Only the two
 * entity prefixes register: an extractor-minted `projects/x` or `a/../b`
 * never becomes a fold target. Both lookups are scoped to the run's source,
 * like the resolver cascade that runs before this fold (source isolation:
 * a fact in source A never points at a page that exists only in source B).
 */
export class EntitySlugCanonicalizer {
  private readonly byBase = new Map<string, string>();
  private readonly ambiguous = new Set<string>();

  static async load(engine: BrainEngine, sourceId: string): Promise<EntitySlugCanonicalizer> {
    const c = new EntitySlugCanonicalizer();
    try {
      const pages = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages
          WHERE source_id = $1
            AND deleted_at IS NULL
            AND (slug LIKE 'people/%' OR slug LIKE 'companies/%')`,
        [sourceId],
      );
      for (const r of pages) c.register(r.slug);
      const facts = await engine.executeRaw<{ entity_slug: string }>(
        `SELECT DISTINCT entity_slug FROM facts
          WHERE source_id = $1
            AND (entity_slug LIKE 'people/%' OR entity_slug LIKE 'companies/%')`,
        [sourceId],
      );
      for (const r of facts) c.register(r.entity_slug);
    } catch (err) {
      process.stderr.write(
        `[extract-conversation-facts] slug canonicalizer load failed (${err instanceof Error ? err.message : String(err)}); raw slugs stay raw this run\n`,
      );
    }
    return c;
  }

  /** Remember a people/ or companies/ slug. Two prefixes for one basename mark it ambiguous. */
  register(prefixed: string): void {
    const i = prefixed.indexOf('/');
    if (i <= 0) return;
    const prefix = prefixed.slice(0, i);
    if (prefix !== 'people' && prefix !== 'companies') return;
    const base = prefixed.slice(i + 1);
    if (!base || base.includes('/')) return;
    const known = this.byBase.get(base);
    if (known === undefined) this.byBase.set(base, prefixed);
    else if (known !== prefixed) this.ambiguous.add(base);
  }

  /** Canonical slug for an extractor/resolver output; null/undefined pass through. */
  canonicalize(slug: string | null | undefined): string | null | undefined {
    if (!slug) return slug;
    if (slug.includes('/')) {
      this.register(slug);
      return slug;
    }
    const base = slugBasename(slug);
    if (!base || this.ambiguous.has(base)) return slug;
    return this.byBase.get(base) ?? slug;
  }
}
