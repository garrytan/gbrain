/**
 * GBRA-156: the candidate read behind `whois` (src/core/ops/whois.ts), a
 * statement builder like graph-rank.ts: the op runs it through `executeRaw`.
 *
 * Every arm is an equality probe an existing index serves, so the read never
 * scans a source's pages:
 *
 *   title    lower(title) = key             idx_pages_title_lower_hash
 *   basename slug basename = key            idx_pages_slug_basename (the slug
 *                                           grammar already folds accents)
 *   alias    page_aliases.alias_norm = key  the (source_id, alias_norm) indexes
 *   email    frontmatter @> {email|emails}  idx_pages_frontmatter (GIN), one
 *                                           arm per address and shape
 *   phone    frontmatter ? phone|phones     idx_pages_frontmatter (GIN) key probe, then
 *                                           the value's digits = a probe digit string
 *
 * The phone arm reads only pages that carry a `phone` or `phones` key; the
 * op verifies each with the canonical form (phone-key.ts). The title arm is
 * left out when there is no title key (a contact match never matches names).
 *
 * The rows are candidates, not answers: the op keeps a row only when its
 * title, email or declared alias folds to exactly the query. Visibility: live
 * pages in unarchived sources of `sourceIds` whose type passes `types`; with
 * `remote`, unquarantined and (with `excludePrivate`) not private.
 */
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { entityTypePredicateSql, type EntityTypeFilter } from '../schema-pack/entity-types.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';

export interface ExactIdentityProbes {
  /** Keys for lower(title), already lowercased. */
  titleKeys: string[];
  /** The query as written, lowercased by the database so both sides share one case map. */
  titleRaw: string;
  /** Slug basenames (the part after the last '/'). */
  basenames: string[];
  /** page_aliases.alias_norm keys. */
  aliasKeys: string[];
  /** Exact frontmatter `email` / `emails` values. */
  emails: string[];
  /** Digit strings a stored `phone` / `phones` value may reduce to (phone-key.ts phoneProbeDigits). */
  phones?: string[];
}

export interface ExactIdentityStatementOpts {
  probes: ExactIdentityProbes;
  /** Every probe and every returned page stays inside these sources. */
  sourceIds: string[];
  /** The page's type must match; an empty filter matches nothing. */
  types: EntityTypeFilter;
  /** Untrusted caller: quarantined and (with excludePrivate) private pages are never candidates. */
  remote?: { excludePrivate: boolean };
  /** Probe only the email arms (the owner identity proves a page by its email alone, so title matches never take the limit). */
  emailsOnly?: boolean;
  limit: number;
}

export interface ExactIdentityRow {
  slug: string;
  source_id: string;
  title: string | null;
  type: string | null;
  email: unknown;
  emails: unknown;
  phone: unknown;
  phones: unknown;
  aliases: unknown;
}

/**
 * One arm per address and frontmatter shape (`email: x`, `email: [x]`,
 * `emails: x`, `emails: [x]`). Separate arms, not one OR: each single
 * containment plans its own GIN bitmap scan, where an OR of several costs
 * more than a scan of the source and plans one.
 */
function emailArms(sourceIds: string[], emails: string[]): SqlFragment[] {
  return emails.flatMap((v) => [
    sqlFragment`jsonb_build_object('email', ${v}::text)`,
    sqlFragment`jsonb_build_object('email', jsonb_build_array(${v}::text))`,
    sqlFragment`jsonb_build_object('emails', ${v}::text)`,
    sqlFragment`jsonb_build_object('emails', jsonb_build_array(${v}::text))`,
  ]).map((shape) => sqlFragment`SELECT p.id FROM pages p WHERE p.source_id = ANY(${sourceIds}::text[]) AND p.frontmatter @> ${shape}`);
}

/** One arm per key (`phone`, `phones`): a scalar or a list, each element reduced to its digits. */
function phoneArms(sourceIds: string[], digits: string[]): SqlFragment[] {
  return (['phone', 'phones'] as const).map((key) => sqlFragment`SELECT p.id FROM pages p
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.frontmatter->${key}::text) = 'array'
         THEN p.frontmatter->${key}::text ELSE jsonb_build_array(p.frontmatter->${key}::text) END) v(value)
       WHERE p.source_id = ANY(${sourceIds}::text[]) AND p.frontmatter ? ${key}::text
         AND regexp_replace(v.value, '[^0-9]', '', 'g') = ANY(${digits}::text[])`);
}

export function exactIdentityStatement(opts: ExactIdentityStatementOpts): { text: string; params: unknown[] } {
  const { probes, sourceIds } = opts;
  const arms: SqlFragment[] = !opts.emailsOnly && (probes.titleKeys.length || probes.titleRaw) ? [sqlFragment`SELECT p.id FROM pages p
       WHERE p.source_id = ANY(${sourceIds}::text[]) AND lower(p.title) = ANY(${probes.titleKeys}::text[] || lower(${probes.titleRaw}::text))`] : [];
  if (probes.basenames.length) {
    arms.push(sqlFragment`SELECT p.id FROM pages p
       WHERE p.source_id = ANY(${sourceIds}::text[]) AND regexp_replace(p.slug, '^.*/', '') = ANY(${probes.basenames}::text[])`);
  }
  if (probes.aliasKeys.length) {
    arms.push(sqlFragment`SELECT p.id FROM page_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug
       WHERE a.source_id = ANY(${sourceIds}::text[]) AND a.alias_norm = ANY(${probes.aliasKeys}::text[])`);
  }
  arms.push(...emailArms(sourceIds, probes.emails));
  if (!opts.emailsOnly && probes.phones?.length) arms.push(...phoneArms(sourceIds, probes.phones));
  if (!arms.length) arms.push(sqlFragment`SELECT p.id FROM pages p WHERE false`);
  const privacy = opts.remote?.excludePrivate ? trustedSql(` AND ${privatePagesFilterForCaller('p')}`) : sqlFragment``;
  const remote = opts.remote ? sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))}${privacy}` : sqlFragment``;
  return renderFragment(sqlFragment`
    WITH cand AS (
      ${joinFragments(arms, '\n      UNION\n      ')}
    )
    SELECT p.slug, p.source_id, p.title, p.type,
           p.frontmatter->'email' AS email, p.frontmatter->'emails' AS emails,
           p.frontmatter->'phone' AS phone, p.frontmatter->'phones' AS phones, p.frontmatter->'aliases' AS aliases
      FROM cand JOIN pages p ON p.id = cand.id
     WHERE p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.archived IS NOT TRUE)
       AND ${entityTypePredicateSql('p', opts.types)}${remote}
     ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"
     LIMIT ${opts.limit}::int`);
}
