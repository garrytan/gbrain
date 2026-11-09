/**
 * #8982: what federating a source exposes. A credential bound to a member writes to a source it was granted
 * without stamped readers (GST-2051 stamps only writes the no-grant floor reads), which is right while that source
 * is not federated. Federating it (`sources federate`, `sources restore`) adds it to the floor, so each such page
 * becomes readable by every connection with no source grant. This read names those pages so the operator sees them;
 * it writes nothing and never refuses the change.
 *
 * A page counts when it names no readers and no folder rule and the writer of its live revision or of any earlier
 * version (the write attribution columns) is a remote credential: a token or OAuth client, revoked or not. No record
 * keeps which member a credential was bound to when it wrote, so a credential unbound or rebound since then counts
 * too, and each example names the member it is bound to now (null when none). The database is the record, so a
 * repo-less brain answers the same way.
 */
import { shellQuote } from '../agent-output.ts';
import type { SqlEngine } from '../persistence/model.ts';

export interface PagesExposed {
  count: number;
  examples: Array<{ slug: string; member: string | null }>;
  check: string;
  restrict: string;
}

/** The pages of `sourceId` a remote credential wrote that name no readers (the first five by slug), or null when there are none. */
export async function remotePagesFederationExposes(engine: SqlEngine, sourceId: string): Promise<PagesExposed | null> {
  const rows = await engine.executeRaw<{ slug: string; member: string | null; total: number }>(
    `WITH writers AS (
       SELECT 'legacy_token'::text AS kind, id::text AS pid, member_id FROM access_tokens
       UNION ALL
       SELECT 'oauth_client'::text, client_id, member_id FROM oauth_clients),
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
  const bound = rows.find(r => r.member !== null && r.slug.includes('/'));
  return {
    count: Number(first.total),
    examples: rows.map(r => ({ slug: r.slug, member: r.member })),
    check: shellQuote(['gbrain', 'access', 'who-can-read', first.slug, '--source', sourceId]),
    restrict: bound
      ? shellQuote(['gbrain', 'access', 'rule', 'add', '--prefix', bound.slug.slice(0, bound.slug.lastIndexOf('/') + 1), '--readers', bound.member!, '--source', sourceId])
      : `gbrain access rule add --prefix <folder/> --readers <member> --source ${shellQuote([sourceId])}`,
  };
}

/**
 * remotePagesFederationExposes when `federating` (the change added the source to the no-grant floor), else null. A
 * failed read is reported on stderr and reads as null, so the check never changes whether or how the federation happens.
 */
export async function remotePagesFederationExposesOrWarn(engine: SqlEngine, sourceId: string, federating: boolean): Promise<PagesExposed | null> {
  if (!federating) return null;
  return remotePagesFederationExposes(engine, sourceId).catch((e: unknown) => {
    console.error(`Warning: could not check ${shellQuote([sourceId])} for remote-written pages without readers: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
}

/** The operator lines for `exposed`, printed on stderr so a --json stdout stays one object. */
export function pagesExposedLines(sourceId: string, exposed: PagesExposed): string[] {
  const more = exposed.count - exposed.examples.length;
  return [
    `Warning: ${exposed.count} page(s) in ${shellQuote([sourceId])} were written by a remote token or OAuth client and name no readers; ` +
      'with the source federated, every connection with no source grant reads them:',
    ...exposed.examples.map(e => `  ${shellQuote([e.slug])} (${e.member ? `member ${e.member}` : 'credential bound to no member now'})`),
    ...(more > 0 ? [`  ... and ${more} more`] : []),
    `  Check one: ${exposed.check}`,
    `  Keep a folder to its member (previews the pages it covers; --yes applies): ${exposed.restrict}`,
    `  Or give a page readable_by: [<member>] in its frontmatter, or undo with: gbrain sources unfederate ${shellQuote([sourceId])}`,
  ];
}
