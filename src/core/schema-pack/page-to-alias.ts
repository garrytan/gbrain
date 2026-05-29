// v0.42 Type Unification (T8) — runPageToAliasCore primitive.
//
// Converts redirect-shaped pages (concept-redirect, the 5.5K-page production
// cluster) into slug_aliases table rows + soft-deletes the source page.
//
// D15 (codex outside voice): does NOT call rewriteLinks for the alias case.
// The alias_table IS the resolver — engine.resolveSlugWithAlias short-circuits
// wikilinks like [[old-concept-name]] to the canonical at read time.
// Rewriting body-text would destroy historical spelling/context.
//
// Codex F7: per-page atomicity preserved via "soft-delete LAST" ordering.
// A crash between alias insert + soft-delete leaves alias present + source
// page still present; retry resumes via ON CONFLICT DO NOTHING on the
// UNIQUE (source_id, alias_slug) constraint.
//
// Per-page unresolved tracking:
//   - canonical_missing: target page doesn't exist in pages table
//   - self_reference: alias === canonical
//   - canonical_unreachable: resolver couldn't extract canonical from body
//   - parse_failed: page body failed markdown parse

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../operations.ts';
import { parseMarkdown } from '../markdown.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import type { PackResolverSpec } from './manifest-v1.ts';

export interface PageToAliasRule {
  from_type: string;
  /** Resolver for the canonical slug. Typical: 'body_first_link' or
   *  {frontmatter_field: 'canonical'}. */
  canonical_from: PackResolverSpec;
  /** Resolver for the alias slug. Default 'slug' (the page's own slug). */
  alias_slug_from: PackResolverSpec;
  /** Optional resolver for the slug_aliases.notes column. */
  notes_from?: PackResolverSpec;
}

export interface PageToAliasOpts {
  rules: PageToAliasRule[];
  apply?: boolean;
  sourceId?: string;
  perRuleLimit?: number;
  onProgress?: (info: { rule_index: number; aliasedSoFar: number }) => void;
}

export interface PerPageToAliasResult {
  rule_index: number;
  from_type: string;
  would_alias: number;
  sample_slugs: string[];
  aliased: number;
  soft_deleted: number;
  unresolved: Array<{
    slug: string;
    reason:
      | 'canonical_missing'
      | 'self_reference'
      | 'canonical_unreachable'
      | 'parse_failed';
  }>;
}

export interface PageToAliasResult {
  schema_version: 1;
  apply: boolean;
  pack_identity: string | null;
  per_rule: PerPageToAliasResult[];
  total_would_alias: number;
  total_aliased: number;
}

/**
 * Resolve a slug or note string from a page view per the rule's
 * PackResolverSpec. The 'body_excerpt' variant returns the first ~240
 * characters of compiled_truth (used by notes_from).
 */
function resolveValue(
  spec: PackResolverSpec,
  page: { slug: string; compiled_truth: string; frontmatter: Record<string, unknown> },
): string | undefined {
  if (spec === 'slug') return page.slug;
  if (spec === 'body_excerpt') {
    const body = page.compiled_truth ?? '';
    return body.slice(0, 240);
  }
  if (spec === 'frontmatter') return undefined;
  if (spec === 'body_first_link') {
    const wiki = page.compiled_truth.match(/\[\[([^\]\|]+)/);
    if (wiki?.[1]) return wiki[1].trim();
    const md = page.compiled_truth.match(/\[[^\]]+\]\(([^)]+)\)/);
    if (md?.[1]) return md[1].trim();
    return undefined;
  }
  if (typeof spec === 'object' && spec !== null && 'frontmatter_field' in spec) {
    const val = page.frontmatter[spec.frontmatter_field];
    if (typeof val === 'string') return val.trim();
    return undefined;
  }
  return undefined;
}

/**
 * Confirm a canonical slug actually exists as an active page. Source-scoped.
 */
async function canonicalExists(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [slug, sourceId],
  );
  return rows.length > 0;
}

/**
 * Insert a slug_aliases row. ON CONFLICT DO NOTHING (idempotent retry).
 * Returns true on first-time insert, false on conflict (already exists).
 */
async function insertAliasRow(
  engine: BrainEngine,
  sourceId: string,
  aliasSlug: string,
  canonicalSlug: string,
  notes: string | undefined,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, alias_slug) DO NOTHING
     RETURNING id`,
    [sourceId, aliasSlug, canonicalSlug, notes ?? null],
  );
  return rows.length > 0;
}

/**
 * Pure core for the unify-types Minion handler's page-to-alias phase.
 * Per-rule iteration; per-page unresolved tracking; source-scoped throughout.
 *
 * Effective sourceId defaults to 'default' when opts.sourceId is undefined
 * (matches engine convention; existing CLI callers pass sourceId from
 * sourceScopeOpts(ctx)).
 */
export async function runPageToAliasCore(
  ctx: OperationContext,
  opts: PageToAliasOpts,
): Promise<PageToAliasResult> {
  const apply = opts.apply === true;
  const limit = Math.max(1, Math.min(50000, opts.perRuleLimit ?? 10000));
  const effectiveSourceId = opts.sourceId ?? 'default';
  const pack = await loadActivePackBestEffort(ctx);

  const per_rule: PerPageToAliasResult[] = [];
  let total_would_alias = 0;
  let total_aliased = 0;

  for (let i = 0; i < opts.rules.length; i++) {
    const rule = opts.rules[i];
    const where = `WHERE deleted_at IS NULL AND type = $1 AND source_id = $2`;
    const rows = await ctx.engine.executeRaw<{
      slug: string;
      compiled_truth: string;
      frontmatter: Record<string, unknown> | string | null;
    }>(
      `SELECT slug, compiled_truth, frontmatter FROM pages ${where} ORDER BY slug LIMIT ${limit}`,
      [rule.from_type, effectiveSourceId],
    );
    const would_alias = rows.length;
    const sample_slugs = rows.slice(0, 10).map((r) => r.slug);
    const unresolved: PerPageToAliasResult['unresolved'] = [];
    let aliased = 0;
    let soft_deleted = 0;

    if (apply && would_alias > 0) {
      for (const r of rows) {
        let fm: Record<string, unknown> = {};
        if (r.frontmatter && typeof r.frontmatter === 'object') {
          fm = r.frontmatter as Record<string, unknown>;
        } else if (typeof r.frontmatter === 'string') {
          try {
            fm = JSON.parse(r.frontmatter);
          } catch {
            try {
              const parsed = parseMarkdown(`---\n${r.frontmatter}\n---\n${r.compiled_truth ?? ''}`);
              fm = parsed.frontmatter;
            } catch {
              unresolved.push({ slug: r.slug, reason: 'parse_failed' });
              continue;
            }
          }
        }
        const pageView = {
          slug: r.slug,
          compiled_truth: r.compiled_truth ?? '',
          frontmatter: fm,
        };
        const aliasSlug = resolveValue(rule.alias_slug_from, pageView);
        const canonicalSlug = resolveValue(rule.canonical_from, pageView);
        if (!aliasSlug) {
          unresolved.push({ slug: r.slug, reason: 'canonical_unreachable' });
          continue;
        }
        if (!canonicalSlug) {
          unresolved.push({ slug: r.slug, reason: 'canonical_unreachable' });
          continue;
        }
        if (aliasSlug === canonicalSlug) {
          unresolved.push({ slug: r.slug, reason: 'self_reference' });
          continue;
        }
        // Verify canonical exists in pages.
        const exists = await canonicalExists(ctx.engine, canonicalSlug, effectiveSourceId);
        if (!exists) {
          unresolved.push({ slug: r.slug, reason: 'canonical_missing' });
          continue;
        }
        const notes = rule.notes_from ? resolveValue(rule.notes_from, pageView) : undefined;
        // Insert alias row (ON CONFLICT DO NOTHING — idempotent).
        await insertAliasRow(ctx.engine, effectiveSourceId, aliasSlug, canonicalSlug, notes);
        aliased++;
        // D15: do NOT rewriteLinks. Alias table IS the resolver.
        // Soft-delete LAST so a crash between insert + delete leaves
        // alias present (idempotent on retry).
        const sdResult = await ctx.engine.softDeletePage(r.slug, { sourceId: effectiveSourceId });
        if (sdResult) soft_deleted++;
        opts.onProgress?.({ rule_index: i, aliasedSoFar: aliased });
      }
    }

    per_rule.push({
      rule_index: i,
      from_type: rule.from_type,
      would_alias,
      sample_slugs,
      aliased,
      soft_deleted,
      unresolved,
    });
    total_would_alias += would_alias;
    total_aliased += aliased;
  }

  return {
    schema_version: 1,
    apply,
    pack_identity: pack ? pack.identity : null,
    per_rule,
    total_would_alias,
    total_aliased,
  };
}
