// v0.42 Type Unification (T7) — runPageToLinkCore primitive.
//
// Reads pages whose body+frontmatter ARE edges (atom-partner-link, symlink),
// extracts source+target slugs via the rule's resolver, inserts a real
// link row via engine.addLinksBatch (using ON CONFLICT DO NOTHING for
// idempotency), then soft-deletes the source page.
//
// Codex F7: per-page atomicity. The parse → extract → insert → soft-delete
// sequence wraps in a per-page rollback-safe loop: each page either fully
// succeeds (link inserted + soft-deleted) or is recorded as unresolved
// (no half-applied state). v0.42 does NOT use a SQL transaction wrap
// because BrainEngine doesn't expose one across the cross-call mix
// (addLinksBatch + softDeletePage); instead the soft-delete is the LAST
// step so a crash between insert + soft-delete leaves the link present
// + the source page still present, which a retry can resume idempotently
// (alias/link insert is ON CONFLICT DO NOTHING; soft-delete is idempotent
// on already-deleted rows).
//
// D15 does NOT apply here: page-to-link is the WHOLE-PAGE conversion case
// (the source page is going away). Inbound `[[atom-partner-link-XYZ]]`
// wikilinks become orphans within the 72h soft-delete window; the
// existing dead-link detector surfaces them. The alias-table-as-resolver
// principle is for page-to-alias only.

import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { OperationContext } from '../operations.ts';
import { parseMarkdown } from '../markdown.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import type { PackResolverSpec } from './manifest-v1.ts';

export interface PageToLinkRule {
  from_type: string;
  /** The link_type to stamp on the inserted link row. */
  link_type: string;
  /** Resolver for the source-side slug (links.from_slug). */
  source_slug_from: PackResolverSpec;
  /** Resolver for the target-side slug (links.to_slug). */
  target_slug_from: PackResolverSpec;
  /** Optional inverse link_type (deferred to caller; v0.42 logs only). */
  inverse?: string;
  /** When true, capture first paragraph as link context. */
  preserve_notes?: boolean;
}

export interface PageToLinkOpts {
  rules: PageToLinkRule[];
  apply?: boolean;
  sourceId?: string;
  /** Per-rule cap on pages processed per invocation. Default 5000 (covers
   *  the 65-page production case 80x over without runaway). */
  perRuleLimit?: number;
  onProgress?: (info: { rule_index: number; convertedSoFar: number }) => void;
}

export interface PerPageToLinkResult {
  rule_index: number;
  from_type: string;
  link_type: string;
  would_convert: number;
  sample_slugs: string[];
  converted: number;
  soft_deleted: number;
  unresolved: Array<{
    slug: string;
    reason: 'no_source' | 'no_target' | 'cycle' | 'parse_failed';
  }>;
}

export interface PageToLinkResult {
  schema_version: 1;
  apply: boolean;
  pack_identity: string | null;
  per_rule: PerPageToLinkResult[];
  total_would_convert: number;
  total_converted: number;
}

/**
 * Resolve a slug according to the rule's PackResolverSpec.
 * Returns undefined when the resolver can't extract a slug.
 */
function resolveSlug(
  spec: PackResolverSpec,
  page: { slug: string; compiled_truth: string; frontmatter: Record<string, unknown> },
): string | undefined {
  if (spec === 'slug') return page.slug;
  if (spec === 'body_excerpt') {
    // Not a slug resolver per se; used by page-to-alias for `notes_from`.
    // Treating as undefined here keeps the resolver narrow.
    return undefined;
  }
  if (spec === 'frontmatter') {
    // Generic frontmatter resolver — defer to caller's per-rule field
    // configuration (covered by the object form below).
    return undefined;
  }
  if (spec === 'body_first_link') {
    // Match the first [[wikilink]] or [text](slug) form in the body.
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
 * Pure core for the unify-types Minion handler's page-to-link phase.
 * Per-rule iteration; per-page unresolved tracking; source-scoped throughout.
 */
export async function runPageToLinkCore(
  ctx: OperationContext,
  opts: PageToLinkOpts,
): Promise<PageToLinkResult> {
  const apply = opts.apply === true;
  const limit = Math.max(1, Math.min(50000, opts.perRuleLimit ?? 5000));
  const sourceId = opts.sourceId;
  const pack = await loadActivePackBestEffort(ctx);

  const per_rule: PerPageToLinkResult[] = [];
  let total_would_convert = 0;
  let total_converted = 0;

  for (let i = 0; i < opts.rules.length; i++) {
    const rule = opts.rules[i];
    const where = sourceId
      ? `WHERE deleted_at IS NULL AND type = $1 AND source_id = $2`
      : `WHERE deleted_at IS NULL AND type = $1`;
    const params: unknown[] = [rule.from_type];
    if (sourceId) params.push(sourceId);
    // Load pages with body+frontmatter for the resolver.
    const rows = await ctx.engine.executeRaw<{
      slug: string;
      compiled_truth: string;
      frontmatter: Record<string, unknown> | string | null;
    }>(
      `SELECT slug, compiled_truth, frontmatter FROM pages ${where} ORDER BY slug LIMIT ${limit}`,
      params,
    );
    const would_convert = rows.length;
    const sample_slugs = rows.slice(0, 10).map((r) => r.slug);
    const unresolved: PerPageToLinkResult['unresolved'] = [];
    let converted = 0;
    let soft_deleted = 0;

    if (apply && would_convert > 0) {
      // Batched insert into links table; per-page soft-delete.
      const linksBuffer: LinkBatchInput[] = [];
      const pagesToSoftDelete: string[] = [];
      for (const r of rows) {
        // Parse frontmatter from JSONB (Postgres) or string (PGLite/raw).
        let fm: Record<string, unknown> = {};
        if (r.frontmatter && typeof r.frontmatter === 'object') {
          fm = r.frontmatter as Record<string, unknown>;
        } else if (typeof r.frontmatter === 'string') {
          try {
            fm = JSON.parse(r.frontmatter);
          } catch {
            // Some engines/rows store as YAML in compiled_truth header. We
            // can fall through to parseMarkdown for a fuller parse.
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
        const sourceSlug = resolveSlug(rule.source_slug_from, pageView);
        const targetSlug = resolveSlug(rule.target_slug_from, pageView);
        if (!sourceSlug) {
          unresolved.push({ slug: r.slug, reason: 'no_source' });
          continue;
        }
        if (!targetSlug) {
          unresolved.push({ slug: r.slug, reason: 'no_target' });
          continue;
        }
        if (sourceSlug === targetSlug) {
          unresolved.push({ slug: r.slug, reason: 'cycle' });
          continue;
        }
        linksBuffer.push({
          from_slug: sourceSlug,
          to_slug: targetSlug,
          link_type: rule.link_type,
          context: rule.preserve_notes ? r.compiled_truth.slice(0, 240) : undefined,
          link_source: 'manual',
          from_source_id: sourceId ?? 'default',
          to_source_id: sourceId ?? 'default',
        });
        pagesToSoftDelete.push(r.slug);
      }
      if (linksBuffer.length > 0) {
        await ctx.engine.addLinksBatch(linksBuffer); // gbrain-allow-direct-insert: page-to-link mapping_rules under unify-types convert edge-shaped pages to canonical link rows; PROTECTED Minion handler, source-scoped, atomic per-rule
        converted = linksBuffer.length;
      }
      for (const slug of pagesToSoftDelete) {
        const result = await ctx.engine.softDeletePage(slug, { sourceId });
        if (result) soft_deleted++;
      }
      opts.onProgress?.({ rule_index: i, convertedSoFar: converted });
    }

    per_rule.push({
      rule_index: i,
      from_type: rule.from_type,
      link_type: rule.link_type,
      would_convert,
      sample_slugs,
      converted,
      soft_deleted,
      unresolved,
    });
    total_would_convert += would_convert;
    total_converted += converted;
  }

  return {
    schema_version: 1,
    apply,
    pack_identity: pack ? pack.identity : null,
    per_rule,
    total_would_convert,
    total_converted,
  };
}
