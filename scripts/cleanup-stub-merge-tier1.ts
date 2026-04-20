#!/usr/bin/env bun
// Tier 1 stub merge: 5 exact-name-dupe pairs identified in
// /tmp/stub-dedup-candidates.json. Each group becomes one canonical row.
// Every merge is one transaction. Full rollback JSONL captures dupe page +
// all touched edges so nothing is unrecoverable.

import postgres from "postgres";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";

const cfg = JSON.parse(readFileSync("/Users/gergoorendi/.gbrain/config.json", "utf8"));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 30, connect_timeout: 10 });

function contentHash(row: { title: string; type: string; compiled_truth: string; timeline: string; frontmatter: any }): string {
  const tags = Array.isArray(row.frontmatter?.tags) ? [...row.frontmatter.tags].sort() : [];
  return createHash("sha256")
    .update(JSON.stringify({
      title: row.title,
      type: row.type,
      compiled_truth: row.compiled_truth,
      timeline: row.timeline,
      frontmatter: row.frontmatter,
      tags,
    }))
    .digest("hex");
}

const rollbackDir = "/Users/gergoorendi/.gbrain/migrations";
mkdirSync(rollbackDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const rollbackPath = `${rollbackDir}/stub-merge-tier1-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

// (canonical_slug, dupe_slug). Canonical is kept; dupe rolls into it.
const PAIRS: Array<[string, string]> = [
  ["companies/supercharge", "companies/supercharge-ltd"],
  ["companies/epam-systems", "companies/epam-systems-ltd"],
  ["companies/mvm-services-zrt", "companies/mvm-services-ltd"],
  ["companies/nbcuniversal", "companies/nbcuniversal-inc"],
  ["companies/tesco", "companies/tesco-plc"],
];

let totalEdgesMoved = 0;
let totalEdgesDeleted = 0;
let totalPagesDeleted = 0;

try {
  for (const [canonicalSlug, dupeSlug] of PAIRS) {
    console.log(`\n=== merging ${dupeSlug} -> ${canonicalSlug} ===`);

    await sql.begin(async tx => {
      // Fetch both rows
      const [canonical] = await tx`
        SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
        FROM pages WHERE slug = ${canonicalSlug}
      `;
      const [dupe] = await tx`
        SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
        FROM pages WHERE slug = ${dupeSlug}
      `;
      if (!canonical) throw new Error(`canonical not found: ${canonicalSlug}`);
      if (!dupe) throw new Error(`dupe not found: ${dupeSlug}`);
      if (canonical.id === dupe.id) throw new Error(`same id for ${canonicalSlug} and ${dupeSlug}`);

      // Snapshot all edges touching dupe (rollback source)
      const dupeEdges = await tx`
        SELECT * FROM links
        WHERE to_page_id = ${dupe.id}
           OR from_page_id = ${dupe.id}
           OR origin_page_id = ${dupe.id}
      `;
      console.log(`  dupe has ${dupeEdges.length} edges touching it`);

      // Edges to delete because they'd collide with an existing canonical edge
      const toEdgesToDelete = await tx`
        SELECT l.* FROM links l
        WHERE l.to_page_id = ${dupe.id}
          AND EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.from_page_id = l.from_page_id
              AND l2.to_page_id = ${canonical.id}
              AND l2.link_type = l.link_type
              AND l2.link_source IS NOT DISTINCT FROM l.link_source
              AND l2.origin_page_id IS NOT DISTINCT FROM l.origin_page_id
          )
      `;
      const fromEdgesToDelete = await tx`
        SELECT l.* FROM links l
        WHERE l.from_page_id = ${dupe.id}
          AND EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.from_page_id = ${canonical.id}
              AND l2.to_page_id = l.to_page_id
              AND l2.link_type = l.link_type
              AND l2.link_source IS NOT DISTINCT FROM l.link_source
              AND l2.origin_page_id IS NOT DISTINCT FROM l.origin_page_id
          )
      `;
      const originEdgesToDelete = await tx`
        SELECT l.* FROM links l
        WHERE l.origin_page_id = ${dupe.id}
          AND EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.id <> l.id
              AND l2.from_page_id = l.from_page_id
              AND l2.to_page_id = l.to_page_id
              AND l2.link_type = l.link_type
              AND l2.link_source IS NOT DISTINCT FROM l.link_source
              AND l2.origin_page_id = ${canonical.id}
          )
      `;

      // Move non-colliding edges
      const movedTo = await tx`
        UPDATE links SET to_page_id = ${canonical.id}
        WHERE to_page_id = ${dupe.id}
          AND NOT EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.from_page_id = links.from_page_id
              AND l2.to_page_id = ${canonical.id}
              AND l2.link_type = links.link_type
              AND l2.link_source IS NOT DISTINCT FROM links.link_source
              AND l2.origin_page_id IS NOT DISTINCT FROM links.origin_page_id
          )
        RETURNING id
      `;
      const movedFrom = await tx`
        UPDATE links SET from_page_id = ${canonical.id}
        WHERE from_page_id = ${dupe.id}
          AND NOT EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.from_page_id = ${canonical.id}
              AND l2.to_page_id = links.to_page_id
              AND l2.link_type = links.link_type
              AND l2.link_source IS NOT DISTINCT FROM links.link_source
              AND l2.origin_page_id IS NOT DISTINCT FROM links.origin_page_id
          )
        RETURNING id
      `;
      const movedOrigin = await tx`
        UPDATE links SET origin_page_id = ${canonical.id}
        WHERE origin_page_id = ${dupe.id}
          AND NOT EXISTS (
            SELECT 1 FROM links l2
            WHERE l2.id <> links.id
              AND l2.from_page_id = links.from_page_id
              AND l2.to_page_id = links.to_page_id
              AND l2.link_type = links.link_type
              AND l2.link_source IS NOT DISTINCT FROM links.link_source
              AND l2.origin_page_id = ${canonical.id}
          )
        RETURNING id
      `;

      // Delete colliding edges (FK CASCADE would drop remaining on page delete, but
      // let's be explicit about the ones we intentionally drop so rollback is precise)
      const delIds = [
        ...toEdgesToDelete.map(e => e.id),
        ...fromEdgesToDelete.map(e => e.id),
        ...originEdgesToDelete.map(e => e.id),
      ];
      let deleted = [];
      if (delIds.length > 0) {
        deleted = await tx`DELETE FROM links WHERE id = ANY(${delIds}::int[]) RETURNING id`;
      }

      console.log(`  edges: moved to=${movedTo.length} from=${movedFrom.length} origin=${movedOrigin.length}; deleted collisions=${deleted.length}`);

      // Merge frontmatter: canonical keeps its values; dupe fills gaps only.
      // Preserve dupe's industry_original if canonical lacks one, etc.
      const mergedFm = { ...(dupe.frontmatter ?? {}), ...(canonical.frontmatter ?? {}) };
      const newHash = contentHash({
        title: canonical.title,
        type: canonical.type,
        compiled_truth: canonical.compiled_truth ?? "",
        timeline: canonical.timeline ?? "",
        frontmatter: mergedFm,
      });
      await tx`
        UPDATE pages
        SET frontmatter = ${JSON.stringify(mergedFm)}::jsonb,
            content_hash = ${newHash},
            updated_at = now()
        WHERE id = ${canonical.id}
      `;

      // Write rollback BEFORE page delete (so we have the id if it matters)
      appendFileSync(rollbackPath, JSON.stringify({
        canonical_slug: canonicalSlug,
        canonical_id: canonical.id,
        dupe_page: dupe,
        canonical_frontmatter_before: canonical.frontmatter,
        canonical_content_hash_before: canonical.content_hash,
        canonical_frontmatter_after: mergedFm,
        dupe_edges_snapshot: dupeEdges,
        deleted_edge_ids: delIds,
        moved_to_ids: movedTo.map(e => e.id),
        moved_from_ids: movedFrom.map(e => e.id),
        moved_origin_ids: movedOrigin.map(e => e.id),
      }) + "\n");

      // Sanity: no edges should reference dupe anymore
      const [{ leftover }] = await tx`
        SELECT COUNT(*)::int AS leftover FROM links
        WHERE to_page_id = ${dupe.id}
           OR from_page_id = ${dupe.id}
           OR origin_page_id = ${dupe.id}
      `;
      if (leftover !== 0) throw new Error(`${leftover} edges still reference ${dupeSlug}; aborting`);

      // Delete dupe page
      await tx`DELETE FROM pages WHERE id = ${dupe.id}`;
      console.log(`  deleted page ${dupeSlug}`);

      totalEdgesMoved += movedTo.length + movedFrom.length + movedOrigin.length;
      totalEdgesDeleted += deleted.length;
      totalPagesDeleted += 1;
    });
  }

  // Post-verify
  const [{ stillExists }] = await sql`
    SELECT COUNT(*)::int AS "stillExists" FROM pages
    WHERE slug = ANY(${PAIRS.map(p => p[1])}::text[])
  `;
  const [{ canonicalsCount }] = await sql`
    SELECT COUNT(*)::int AS "canonicalsCount" FROM pages
    WHERE slug = ANY(${PAIRS.map(p => p[0])}::text[])
  `;
  console.log(`\n[verify] dupe pages still in DB: ${stillExists} (expect 0)`);
  console.log(`[verify] canonical pages present: ${canonicalsCount} (expect ${PAIRS.length})`);

  // Edge counts for canonicals after merge
  const canonicalEdges = await sql`
    SELECT p.slug, COUNT(l.*)::int AS inbound
    FROM pages p LEFT JOIN links l ON l.to_page_id = p.id
    WHERE p.slug = ANY(${PAIRS.map(p => p[0])}::text[])
    GROUP BY p.slug ORDER BY inbound DESC
  `;
  console.log(`[verify] canonical inbound edges post-merge:`);
  for (const r of canonicalEdges) console.log(`  ${r.slug}: ${r.inbound}`);

  console.log(`\n[summary] pages deleted=${totalPagesDeleted} edges moved=${totalEdgesMoved} edges dropped (collisions)=${totalEdgesDeleted}`);
} finally {
  await sql.end();
}
