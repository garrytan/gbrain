/**
 * #8982: what federating a source exposes. A credential bound to a member writes to a source it was granted
 * without stamped readers (GST-2051 stamps only writes the no-grant floor reads), which is right while that source
 * is not federated. Federating it (`sources federate`, `sources restore`) adds it to the floor, so each such page
 * becomes readable by every connection with no source grant. This read names those pages so the operator sees them;
 * it writes nothing and never refuses the change.
 *
 * A page counts when the writer of its live revision or of any earlier version (the write attribution columns) is a
 * token or OAuth client bound to a member, revoked or not, and it carries no reader restriction (no readable_by, no folder rule). The database is
 * the record, so a repo-less brain answers the same way.
 */
import type { SqlEngine } from '../persistence/model.ts';

export interface MemberPagesExposed {
  count: number;
  examples: Array<{ slug: string; member: string }>;
  check: string;
  restrict: string;
}

/** The member-written pages of `sourceId` that name no readers (the first five by slug), or null when there are none. */
export async function memberPagesFederationExposes(engine: SqlEngine, sourceId: string): Promise<MemberPagesExposed | null> {
  const rows = await engine.executeRaw<{ slug: string; member: string; total: number }>(
    `WITH writers AS (
       SELECT 'legacy_token'::text AS kind, id::text AS pid, member_id FROM access_tokens WHERE member_id IS NOT NULL
       UNION ALL
       SELECT 'oauth_client'::text, client_id, member_id FROM oauth_clients WHERE member_id IS NOT NULL),
     open AS (SELECT id, slug, revision_principal_kind, revision_principal_id FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL AND page_readers IS NULL AND folder_rule_ids IS NULL),
     authored AS (
       SELECT o.slug, w.member_id FROM open o JOIN writers w ON w.kind = o.revision_principal_kind AND w.pid = o.revision_principal_id
       UNION ALL
       SELECT o.slug, w.member_id FROM open o JOIN page_versions v ON v.page_id = o.id
         JOIN writers w ON w.kind = v.write_principal_kind AND w.pid = v.write_principal_id)
     SELECT slug, min(member_id) AS member, (count(*) OVER ())::int AS total
       FROM authored GROUP BY slug ORDER BY slug LIMIT 5`, [sourceId]);
  const first = rows[0];
  if (!first) return null;
  const folder = first.slug.includes('/') ? first.slug.slice(0, first.slug.lastIndexOf('/') + 1) : '<folder/>';
  return {
    count: Number(first.total),
    examples: rows.map(r => ({ slug: r.slug, member: r.member })),
    check: `gbrain access who-can-read ${first.slug} --source ${sourceId}`,
    restrict: `gbrain access rule add --prefix ${folder} --readers ${first.member} --source ${sourceId}`,
  };
}

/**
 * memberPagesFederationExposes when `federating` (the change adds the source to the no-grant floor), else null. A failed
 * read is reported on stderr and reads as null, so the check never changes whether or how the federation happens.
 */
export async function memberPagesFederationExposesOrWarn(engine: SqlEngine, sourceId: string, federating: boolean): Promise<MemberPagesExposed | null> {
  if (!federating) return null;
  return memberPagesFederationExposes(engine, sourceId).catch((e: unknown) => {
    console.error(`Warning: could not check "${sourceId}" for member-written pages without readers: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
}

/** The operator lines for `exposed`, printed on stderr so a --json stdout stays one object. */
export function memberPagesExposedLines(sourceId: string, exposed: MemberPagesExposed): string[] {
  const more = exposed.count - exposed.examples.length;
  return [
    `Warning: ${exposed.count} page(s) in "${sourceId}" were written by a credential bound to a member and name no readers; ` +
      'with the source federated, every connection with no source grant reads them:',
    ...exposed.examples.map(e => `  ${e.slug} (member ${e.member})`),
    ...(more > 0 ? [`  ... and ${more} more`] : []),
    `  Check one: ${exposed.check}`,
    `  Keep a folder to its member (previews the pages it covers; --yes applies): ${exposed.restrict}`,
    `  Or give a page readable_by: [<member>] in its frontmatter, or undo with: gbrain sources unfederate ${sourceId}`,
  ];
}
