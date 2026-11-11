/**
 * #8982: what federating a source exposes. A credential bound to a member writes to a source it was granted
 * without stamped readers (GST-2051 stamps only writes the no-grant floor reads), which is right while that source
 * is not federated. Federating it (`sources federate`, `sources restore`) adds it to the floor, so each such page
 * becomes readable by every connection with no source grant. This read names those pages so the operator sees them;
 * it writes nothing and never refuses the change.
 *
 * A page counts when it names no readers and no folder rule, the read paths' privacy rules (privacyPartSql: visibility,
 * aliases, pinned questions, lineage) do not hide it from a no-grant connection (#9068; the search.remote_private_pages
 * and GBRAIN_REMOTE_PRIVATE_PAGES opt-outs relax them here too), and the writer of its live revision or of any earlier
 * version (the write attribution columns) is a remote credential: a token or OAuth client, revoked or deleted since. No
 * record keeps which member a credential was bound to when it wrote, so a credential unbound or rebound since then
 * counts too, and each example names the member it is bound to now (null when none or deleted). A write that moves
 * the revision attribution without a version snapshot (a tag change) hides the earlier remote author from this read. The database is the record, so a
 * repo-less brain answers the same way.
 */
import { shellQuote } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { privacyPartSql, remotePrivacyRelaxed } from '../search/private-visibility.ts';

export interface PagesExposed {
  count: number;
  examples: Array<{ slug: string; member: string | null }>;
  check: string;
  restrict: string;
}

/** The pages of `sourceId` a remote credential wrote that name no readers (the first five by slug), or null when there are none. */
export async function remotePagesFederationExposes(engine: BrainEngine, sourceId: string): Promise<PagesExposed | null> {
  const hidden = await remotePrivacyRelaxed(engine) ? '' : ` AND ${privacyPartSql('p')}`;
  const rows = await engine.executeRaw<{ slug: string; member: string | null; total: number }>(
    `WITH open AS (SELECT p.id, p.slug, p.revision_principal_kind, p.revision_principal_id FROM pages p
       WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.page_readers IS NULL AND p.folder_rule_ids IS NULL${hidden}),
     authored AS (
       SELECT slug, revision_principal_kind AS kind, revision_principal_id AS pid FROM open
       UNION ALL
       SELECT o.slug, v.write_principal_kind, v.write_principal_id FROM open o JOIN page_versions v ON v.page_id = o.id)
     SELECT a.slug, min(coalesce(t.member_id, c.member_id)) AS member, (count(*) OVER ())::int AS total
       FROM authored a
       LEFT JOIN access_tokens t ON a.kind = 'legacy_token' AND t.id::text = a.pid
       LEFT JOIN oauth_clients c ON a.kind = 'oauth_client' AND c.client_id = a.pid
      WHERE a.kind IN ('legacy_token', 'oauth_client')
      GROUP BY a.slug ORDER BY a.slug LIMIT 5`, [sourceId]);
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
export async function remotePagesFederationExposesOrWarn(engine: BrainEngine, sourceId: string, federating: boolean): Promise<PagesExposed | null> {
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
