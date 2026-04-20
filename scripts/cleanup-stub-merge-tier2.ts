#!/usr/bin/env bun
// Tier 2 stub merge: domain-match groups where the naming difference is
// clerical (the/LLC/LP, full-form vs short-form brand, English vs native).
// Parent/subsidiary, regional-country-arm, and distinct-product pairs are
// intentionally EXCLUDED: merging Deloitte with Deloitte Consulting or
// SAP with SAP Ariba would damage the graph.

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
const rollbackPath = `${rollbackDir}/stub-merge-tier2-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

// Each entry: canonical_slug, dupe_slug, reason
const PAIRS: Array<{ canonical: string; dupe: string; reason: string }> = [
  { canonical: "companies/the-lego-group", dupe: "companies/lego-group", reason: "same entity, 'The' article variance" },
  { canonical: "companies/amazon-web-services-aws", dupe: "companies/amazon-web-services", reason: "same entity, abbreviation parenthetical variance" },
  { canonical: "companies/jpmorgan-chase-and-co", dupe: "companies/jpmorganchase", reason: "same entity, spacing/punctuation variance" },
  { canonical: "companies/bloomberg", dupe: "companies/bloomberg-lp", reason: "Bloomberg LP is the legal entity of Bloomberg, same business" },
  { canonical: "companies/misys", dupe: "companies/misys-banking-systems", reason: "same entity; 'Misys Banking Systems' was the earlier name before rebrand" },
  { canonical: "companies/f5", dupe: "companies/f5-networks", reason: "F5 dropped 'Networks' from brand in 2020; same company" },
  { canonical: "companies/ocbc-bank", dupe: "companies/ocbc", reason: "same Singapore bank, short vs full brand" },
  { canonical: "companies/seon", dupe: "companies/seon-fraud-fighters", reason: "same company; 'Fraud Fighters' is a marketing tagline" },
  { canonical: "companies/unobank", dupe: "companies/uno-digital-bank", reason: "same Brazilian digital bank (unobank.com.br)" },
  { canonical: "companies/vision-bank", dupe: "companies/visionbank", reason: "same entity; spacing variance" },
  { canonical: "companies/kraken", dupe: "companies/kraken-digital-asset-exchange", reason: "same crypto exchange; 'Digital Asset Exchange' is legal-register suffix" },
  { canonical: "companies/hungarian-university-of-agriculture-and-life-sciences", dupe: "companies/magyar-agrar-es-elettudomanyi-egyetem-mate", reason: "same university (MATE); English vs Hungarian name" },
  { canonical: "companies/bosch-power-tools", dupe: "companies/robert-bosch-power-tools", reason: "same Bosch Power Tools division; 'Robert' prefix variance" },
];

// Manual-review flags (NOT auto-merged):
const FLAG_MANUAL: Array<{ group: string[]; note: string }> = [
  { group: ["companies/erste-bank-hungary", "companies/erste-magyarorszag"], note: "both on erstebank.hu — plausibly same Erste Hungarian entity under different name, but Erste Group has multiple Hungarian legal entities. Confirm before merging." },
  { group: ["companies/budapest-business-university", "companies/budapest-university-of-economics-and-business"], note: "Hungarian higher-ed institutions have gone through merger/rename cycles (BCE, BGF, BGE). Could be genuinely distinct institutions on the same domain. Confirm with Gary." },
];

// Explicit keep-separate decisions (documented so future me doesn't re-litigate):
const KEEP_SEPARATE: Array<{ group: string[]; reason: string }> = [
  { group: ["companies/mol-group", "companies/mol-magyarorszag"], reason: "global parent vs Hungarian operating co" },
  { group: ["companies/finshape", "companies/finshape-hu"], reason: "global brand vs Hungarian entity; Gary worked with both" },
  { group: ["companies/otp-bank", "companies/otp-bank-magyarorszag", "companies/otp-otthon"], reason: "parent bank / Hungarian bank / real-estate product brand" },
  { group: ["companies/university-of-miskolc", "companies/university-of-miskolc-faculty-of-economics-institute-of-management-sciences"], reason: "university vs sub-unit (faculty)" },
  { group: ["companies/robert-bosch-power-tool-kft", "companies/bosch-magyarorszag", "companies/robert-bosch-kft"], reason: "3 distinct Bosch Hungary legal entities" },
  { group: ["companies/sap", "companies/sap-ariba"], reason: "SAP parent vs Ariba product line (major distinct product)" },
  { group: ["companies/deloitte", "companies/deloitte-consulting"], reason: "Deloitte firm vs Consulting service line" },
  { group: ["companies/ey", "companies/ey-parthenon"], reason: "EY vs EY-Parthenon strategy arm" },
  { group: ["companies/vodafone", "companies/vodafone-business"], reason: "consumer vs B2B division" },
  { group: ["companies/unicredit", "companies/unicredit-services"], reason: "parent vs shared-services subsidiary" },
  { group: ["companies/grab", "companies/grabfin"], reason: "Grab (super-app) vs GrabFin (fintech arm)" },
  { group: ["companies/accenture", "companies/accenture-hungary"], reason: "global vs country arm" },
  { group: ["companies/topdesk", "companies/topdesk-magyarorszag-kft"], reason: "global vs Hungarian Kft." },
  { group: ["companies/orange", "companies/orange-services"], reason: "parent vs services arm" },
  { group: ["companies/pwc", "companies/pwc-south-east-asia-consulting"], reason: "global vs SEA consulting arm" },
  { group: ["companies/shift4", "companies/shift4-europe-formerly-finaro"], reason: "global vs European acquired arm (Finaro)" },
  { group: ["companies/siemens-technology-and-services", "companies/siemens-digital-industries-software"], reason: "distinct Siemens divisions" },
  { group: ["companies/unicef", "companies/unicef-global-shared-services-center"], reason: "UNICEF vs operational center" },
  { group: ["companies/worldline", "companies/worldline-global"], reason: "parent vs global subsidiary; low signal, no merge without confirmation" },
  { group: ["companies/abn-amro-clearing-bank", "companies/abn-amro-bank-n-v"], reason: "clearing bank vs main bank — distinct business lines" },
];

let totalEdgesMoved = 0;
let totalEdgesDeleted = 0;
let totalPagesDeleted = 0;

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
      if (!canonical) throw new Error(`canonical not found: ${canonicalSlug}`);
      if (!dupe) throw new Error(`dupe not found: ${dupeSlug}`);
      if (canonical.id === dupe.id) throw new Error(`same id for ${canonicalSlug} and ${dupeSlug}`);

      const dupeEdges = await tx`
        SELECT * FROM links
        WHERE to_page_id = ${dupe.id}
           OR from_page_id = ${dupe.id}
           OR origin_page_id = ${dupe.id}
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

      const delIds = [
        ...toEdgesToDelete.map(e => e.id),
        ...fromEdgesToDelete.map(e => e.id),
        ...originEdgesToDelete.map(e => e.id),
      ];
      let deleted: any[] = [];
      if (delIds.length > 0) {
        deleted = await tx`DELETE FROM links WHERE id = ANY(${delIds}::int[]) RETURNING id`;
      }

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
        WHERE to_page_id = ${dupe.id}
           OR from_page_id = ${dupe.id}
           OR origin_page_id = ${dupe.id}
      `;
      if (leftover !== 0) throw new Error(`${leftover} edges still reference ${dupeSlug}; aborting`);

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
    WHERE slug = ANY(${PAIRS.map(p => p.dupe)}::text[])
  `;
  console.log(`\n[verify] dupe pages still in DB: ${stillExists} (expect 0)`);

  const canonicalEdges = await sql`
    SELECT p.slug, COUNT(l.*)::int AS inbound
    FROM pages p LEFT JOIN links l ON l.to_page_id = p.id
    WHERE p.slug = ANY(${PAIRS.map(p => p.canonical)}::text[])
    GROUP BY p.slug ORDER BY inbound DESC
  `;
  console.log(`[verify] canonical inbound edges post-merge:`);
  for (const r of canonicalEdges) console.log(`  ${r.slug}: ${r.inbound}`);

  console.log(`\n[summary] pages deleted=${totalPagesDeleted} edges moved=${totalEdgesMoved} edges dropped (collisions)=${totalEdgesDeleted}`);
  console.log(`\n[flagged for manual review] ${FLAG_MANUAL.length} pairs:`);
  for (const f of FLAG_MANUAL) {
    console.log(`  - ${f.group.join(" + ")}`);
    console.log(`    ${f.note}`);
  }
  console.log(`\n[kept separate] ${KEEP_SEPARATE.length} groups documented in rollback file meta (parent/sub or distinct-division).`);
} finally {
  await sql.end();
}
