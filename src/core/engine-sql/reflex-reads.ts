/**
 * The retrieval reflex's page reads (context/retrieval-reflex.ts) and the proactive brief's entity-page read
 * (context/proactive-brief.ts `entityPages`), which both ran raw SQL through `engine.executeRaw`
 * (docs/designs/RUST_REFLEX_READS.md). One SQL implementation for both engines, so the callers name typed engine
 * members and a Rust brain can answer them. Each statement is the text its call site sent at efeb078093, with the
 * same parameters in the same order; the privacy predicate renders inside the engine call, in the caller's async
 * context, as it did. The call sites keep their own fallbacks.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { privatePagesFilterForCaller, remoteReadFloorSql } from '../search/private-visibility.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';

/** Which pages a reflex read hides: none (a trusted local caller), the caller's page policy, or the remote read floor. */
export type ReflexPrivacy = 'none' | 'caller' | 'floor';

/** The sources a reflex read covers (an empty list reads nothing) and its privacy. */
export interface ReflexScope { sourceIds: readonly string[]; privacy: ReflexPrivacy }

/**
 * Which live pages `readReflexPages` returns:
 * - `names`: `lower(title)` in `titlesLc`, a slug in `exactSlugs`, or a slug LIKE one of `slugSuffixes`; with a
 *   non-empty `surnamePatterns`, also a person page whose `lower(title)` is LIKE one of them. By page id.
 * - `slugs`: a slug in `slugs`. No set order.
 * - `cjkExact`: `lower(title)` or the slug in `norms`. No set order.
 * - `titles`: `lower(title)` in `titlesLc`. No set order.
 */
export type ReflexPageMatch =
  | { kind: 'names'; titlesLc: readonly string[]; exactSlugs: readonly string[]; slugSuffixes: readonly string[]; surnamePatterns?: readonly string[] }
  | { kind: 'slugs'; slugs: readonly string[] }
  | { kind: 'cjkExact'; norms: readonly string[] }
  | { kind: 'titles'; titlesLc: readonly string[] };

/** A reflex candidate page with its bounded body prefix (`boundedBodyPrefixSql`) as `compiled_truth`. */
export interface ReflexPageRow {
  slug: string;
  source_id: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  compiled_truth: string | null;
}

/** A live page the proactive brief may name as a counterparty: its slug, title and type. */
export interface BriefEntityPageRow { slug: string; title: string | null; type: string | null }

/** `readBriefEntityPages` options: the privacy and the read eligibility (`pageEligibleSql`; absent admits every page). */
export interface BriefEntityPageOpts { privacy: ReflexPrivacy; eligibility?: ReadEligibility }

/** The privacy conjunct with its leading `AND`, or nothing for `none`. */
function reflexPrivacySql(privacy: ReflexPrivacy): SqlFragment {
  switch (privacy) {
    case 'none': return sqlFragment``;
    case 'caller': return sqlFragment`AND ${trustedSql(privatePagesFilterForCaller('p'))}`;
    case 'floor': return sqlFragment`AND ${trustedSql(remoteReadFloorSql('p'))}`;
  }
}

/** The live pages in the scope at `slugs`, as (slug, source_id) pairs, in no set order (the alias arm's live recheck). */
export async function readReflexLiveKeys(raw: EngineRawRead, scope: ReflexScope, slugs: readonly string[]): Promise<Array<{ slug: string; source_id: string }>> {
  const priv = reflexPrivacySql(scope.privacy);
  const sources = [...scope.sourceIds];
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.source_id FROM pages p
            WHERE p.deleted_at IS NULL AND p.source_id = ANY(${sources}::text[]) AND p.slug = ANY(${[...slugs]}::text[]) ${priv}`);
  return raw<{ slug: string; source_id: string }>(text, params);
}

/** The live pages in the scope that `match` names, with the bounded body prefix. */
export async function readReflexPages(raw: EngineRawRead, scope: ReflexScope, match: ReflexPageMatch): Promise<ReflexPageRow[]> {
  const { text, params } = renderFragment(reflexPagesStatement(scope, match));
  return raw<ReflexPageRow>(text, params);
}

function reflexPagesStatement(scope: ReflexScope, match: ReflexPageMatch): SqlFragment {
  const priv = reflexPrivacySql(scope.privacy);
  const prefix = trustedSql(boundedBodyPrefixSql('p'));
  const sources = [...scope.sourceIds];
  switch (match.kind) {
    case 'names': {
      const surname = match.surnamePatterns ?? [];
      return surname.length > 0
        ? sqlFragment`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${prefix} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${priv}
              AND p.source_id = ANY(${sources}::text[])
              AND ( lower(p.title) = ANY(${[...match.titlesLc]}::text[])
                 OR p.slug = ANY(${[...match.exactSlugs]}::text[])
                 OR p.slug LIKE ANY(${[...match.slugSuffixes]}::text[])
                 OR (lower(p.title) LIKE ANY(${[...surname]}::text[]) AND p.type = 'person') ) ORDER BY p.id`
        : sqlFragment`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${prefix} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${priv}
              AND p.source_id = ANY(${sources}::text[])
              AND ( lower(p.title) = ANY(${[...match.titlesLc]}::text[])
             OR p.slug = ANY(${[...match.exactSlugs]}::text[])
             OR p.slug LIKE ANY(${[...match.slugSuffixes]}::text[]) ) ORDER BY p.id`;
    }
    case 'slugs':
      return sqlFragment`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${prefix} AS compiled_truth
           FROM pages p
          WHERE p.deleted_at IS NULL ${priv} AND p.source_id = ANY(${sources}::text[]) AND p.slug = ANY(${[...match.slugs]}::text[])`;
    case 'cjkExact':
      return sqlFragment`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${prefix} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${priv}
              AND p.source_id = ANY(${sources}::text[])
              AND ( lower(p.title) = ANY(${[...match.norms]}::text[]) OR p.slug = ANY(${[...match.norms]}::text[]) )`;
    case 'titles':
      return sqlFragment`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${prefix} AS compiled_truth
         FROM pages p
        WHERE p.deleted_at IS NULL ${priv}
          AND p.source_id = ANY(${sources}::text[])
          AND lower(p.title) = ANY(${[...match.titlesLc]}::text[])`;
  }
}

/** The live pages of the source at `slugs` that the privacy and the eligibility admit, in no set order. */
export async function readBriefEntityPages(raw: EngineRawRead, sourceId: string, slugs: readonly string[],
  opts: BriefEntityPageOpts): Promise<BriefEntityPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = ${sourceId} AND p.slug = ANY(${[...slugs]}::text[]) AND p.deleted_at IS NULL
        ${reflexPrivacySql(opts.privacy)}
        AND ${trustedSql(pageEligibleSql('p', opts.eligibility))}`);
  return raw<BriefEntityPageRow>(text, params);
}
