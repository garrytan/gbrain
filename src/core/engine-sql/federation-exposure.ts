/**
 * The pages a federation exposes, for the `sources federate` and `sources add` warning (src/core/access/federation-exposure.ts
 * `remotePagesFederationExposes`): the live pages of a source that name no readers and carry no folder rule and that a
 * remote credential wrote, now or in an archived version. The statement is the one that caller sent through
 * `executeRaw`, byte for byte.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { rows } from './search-reads.ts';

/** One exposed page: its slug, the smallest member bound to a credential that wrote it (or null), and the qualifying total. */
export interface FederationExposedRow { slug: string; member: string | null; total: number }

/**
 * The first five qualifying slugs by slug, each with the total. `hidePrivate` adds the privacy part (`privacyPartSql`),
 * as the caller does unless an operator relaxed remote privacy.
 */
export async function readFederationExposedPages(exec: LegacyUnscopedRead, sourceId: string, hidePrivate: boolean): Promise<FederationExposedRow[]> {
  // The privacy part is the vetted constant privacyPartSql; the source id is the one bound value ($1).
  const hidden = trustedSql(hidePrivate ? ` AND ${privacyPartSql('p')}` : '');
  return rows<FederationExposedRow>(exec, sqlFragment`WITH open AS (SELECT p.id, p.slug, p.revision_principal_kind, p.revision_principal_id FROM pages p
       WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL AND p.page_readers IS NULL AND p.folder_rule_ids IS NULL${hidden}),
     authored AS (
       SELECT slug, revision_principal_kind AS kind, revision_principal_id AS pid FROM open
       UNION ALL
       SELECT o.slug, v.write_principal_kind, v.write_principal_id FROM open o JOIN page_versions v ON v.page_id = o.id)
     SELECT a.slug, min(coalesce(t.member_id, c.member_id)) AS member, (count(*) OVER ())::int AS total
       FROM authored a
       LEFT JOIN access_tokens t ON a.kind = 'legacy_token' AND t.id::text = a.pid
       LEFT JOIN oauth_clients c ON a.kind = 'oauth_client' AND c.client_id = a.pid
      WHERE a.kind IN ('legacy_token', 'oauth_client')
      GROUP BY a.slug ORDER BY a.slug LIMIT 5`);
}
