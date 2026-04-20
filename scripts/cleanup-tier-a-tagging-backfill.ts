#!/usr/bin/env bun
// Backfill Tier A (Step 4A legacy) rows with enrichment_source + enrichment_verified.
// Per gbrain-work-2026-04-20.md section 4.1 step 1. Zero API cost.

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
const rollbackPath = `${rollbackDir}/tier-a-tagging-backfill-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

try {
  // Phase 1: identify targets
  const rows = await sql`
    SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
    FROM pages
    WHERE type = 'company'
      AND frontmatter ? 'enrichment_confidence'
      AND NOT (frontmatter ? 'enrichment_source')
  `;
  console.log(`[found] ${rows.length} Tier A rows (expect 20)`);
  if (rows.length === 0) {
    console.log("[done] nothing to do");
    process.exit(0);
  }
  if (rows.length !== 20) {
    console.log(`[warn] expected 20, got ${rows.length}. proceeding anyway.`);
  }

  // Phase 2: write rollback BEFORE any mutation
  for (const r of rows) {
    appendFileSync(rollbackPath, JSON.stringify({
      id: r.id,
      slug: r.slug,
      previous_frontmatter: r.frontmatter,
      previous_content_hash: r.content_hash,
    }) + "\n");
  }
  console.log(`[rollback] wrote ${rows.length} entries`);

  // Phase 3: build new payloads
  const updates = rows.map(r => {
    const newFm = {
      ...r.frontmatter,
      enrichment_source: "haiku_search",
      enrichment_verified: true,
    };
    const newHash = contentHash({
      title: r.title,
      type: r.type,
      compiled_truth: r.compiled_truth ?? "",
      timeline: r.timeline ?? "",
      frontmatter: newFm,
    });
    return { id: r.id, fm: JSON.stringify(newFm), hash: newHash };
  });

  // Phase 4: single bulk UPDATE via UNNEST
  const updIds = updates.map(u => u.id);
  const updFms = updates.map(u => u.fm);
  const updHashes = updates.map(u => u.hash);
  const result = await sql`
    UPDATE pages p
    SET frontmatter = d.fm::jsonb,
        content_hash = d.hash,
        updated_at = now()
    FROM (
      SELECT UNNEST(${updIds}::int[]) AS id,
             UNNEST(${updFms}::text[]) AS fm,
             UNNEST(${updHashes}::text[]) AS hash
    ) d
    WHERE p.id = d.id
    RETURNING p.slug
  `;
  console.log(`[updated] ${result.length} rows`);

  // Phase 5: verify
  const [{ remaining }] = await sql`
    SELECT COUNT(*)::int AS remaining FROM pages
    WHERE type = 'company'
      AND frontmatter ? 'enrichment_confidence'
      AND NOT (frontmatter ? 'enrichment_source')
  `;
  console.log(`[verify] remaining untagged Tier A rows: ${remaining} (expect 0)`);

  const [{ verified }] = await sql`
    SELECT COUNT(*)::int AS verified FROM pages
    WHERE type = 'company'
      AND frontmatter->>'enrichment_source' = 'haiku_search'
      AND frontmatter->>'enrichment_verified' = 'true'
  `;
  console.log(`[verify] total haiku_search verified rows: ${verified} (expect 58 + ${updates.length} = ${58 + updates.length})`);
} finally {
  await sql.end();
}
