#!/usr/bin/env bun
// Final Tier 2 merge: Erste Hungary pair (Gary confirmed same entity).
// Budapest Business University vs Budapest University of Economics and Business:
// confirmed distinct, not merged.

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
const rollbackPath = `${rollbackDir}/stub-merge-erste-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

const PAIRS = [
  { canonical: "companies/erste-bank-hungary", dupe: "companies/erste-magyarorszag", reason: "confirmed by Gary: same Erste Hungarian entity, Hungarian-language label variant" },
];

try {
  for (const { canonical: canonicalSlug, dupe: dupeSlug, reason } of PAIRS) {
    console.log(`\n=== merging ${dupeSlug} -> ${canonicalSlug} ===`);
    console.log(`  reason: ${reason}`);

    await sql.begin(async tx => {
      const [canonical] = await tx`
        SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
        FROM pages WHERE slug = ${canonicalSlug}
      `;
      const [dupe] = await tx`
        SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
        FROM pages WHERE slug = ${dupeSlug}
      `;
      if (!canonical || !dupe) throw new Error(`not found: ${canonicalSlug} or ${dupeSlug}`);

      const dupeEdges = await tx`
        SELECT * FROM links
        WHERE to_page_id = ${dupe.id} OR from_page_id = ${dupe.id} OR origin_page_id = ${dupe.id}
      `;

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

      const delIds = [...toEdgesToDelete.map(e => e.id), ...fromEdgesToDelete.map(e => e.id), ...originEdgesToDelete.map(e => e.id)];
      let deleted: any[] = [];
      if (delIds.length > 0) deleted = await tx`DELETE FROM links WHERE id = ANY(${delIds}::int[]) RETURNING id`;

      console.log(`  edges: moved to=${movedTo.length} from=${movedFrom.length} origin=${movedOrigin.length}; deleted collisions=${deleted.length}`);

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
        SET frontmatter = ${sql.json(mergedFm)},
            content_hash = ${newHash},
            updated_at = now()
        WHERE id = ${canonical.id}
      `;

      appendFileSync(rollbackPath, JSON.stringify({
        canonical_slug: canonicalSlug,
        canonical_id: canonical.id,
        reason,
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

      const [{ leftover }] = await tx`
        SELECT COUNT(*)::int AS leftover FROM links
        WHERE to_page_id = ${dupe.id} OR from_page_id = ${dupe.id} OR origin_page_id = ${dupe.id}
      `;
      if (leftover !== 0) throw new Error(`${leftover} edges still reference ${dupeSlug}; aborting`);

      await tx`DELETE FROM pages WHERE id = ${dupe.id}`;
      console.log(`  deleted page ${dupeSlug}`);
    });
  }

  const [{ stillExists }] = await sql`
    SELECT COUNT(*)::int AS "stillExists" FROM pages
    WHERE slug = ANY(${PAIRS.map(p => p.dupe)}::text[])
  `;
  console.log(`\n[verify] dupe page(s) remaining: ${stillExists} (expect 0)`);

  const [{ edges }] = await sql`
    SELECT COUNT(*)::int AS edges FROM links l
    JOIN pages p ON p.id = l.to_page_id
    WHERE p.slug = 'companies/erste-bank-hungary'
  `;
  console.log(`[verify] erste-bank-hungary inbound edges: ${edges}`);
} finally {
  await sql.end();
}
