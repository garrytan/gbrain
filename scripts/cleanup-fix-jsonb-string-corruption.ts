#!/usr/bin/env bun
// Fix frontmatter rows that were saved as JSON strings (double-encoded) instead of
// JSON objects. Caused by `${JSON.stringify(x)}::jsonb` in postgres.js; the correct
// form is `${json}::text::jsonb` or passing via UNNEST with ::text[] + ::jsonb cast.
//
// Strategy: unwrap via `frontmatter #>> '{}'` (extract underlying string, then
// cast back to jsonb). Recompute content_hash. Transactional per-row with
// rollback JSONL.

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
const rollbackPath = `${rollbackDir}/fix-jsonb-string-corruption-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

try {
  // Pull affected rows. Get the unwrapped jsonb object in-query via #>> '{}' then cast.
  const rows = await sql`
    SELECT id, slug, title, type, compiled_truth, timeline,
           frontmatter AS corrupt_frontmatter,
           (frontmatter #>> '{}')::jsonb AS fixed_frontmatter,
           content_hash AS old_hash
    FROM pages
    WHERE jsonb_typeof(frontmatter) = 'string'
  `;
  console.log(`[found] ${rows.length} corrupted rows`);
  if (rows.length === 0) {
    console.log("nothing to fix");
    process.exit(0);
  }

  // Sanity: every unwrap must be an object
  const badUnwrap = rows.filter(r => r.fixed_frontmatter === null || typeof r.fixed_frontmatter !== 'object' || Array.isArray(r.fixed_frontmatter));
  if (badUnwrap.length > 0) {
    console.log(`[abort] ${badUnwrap.length} rows unwrapped to non-object. First:`, badUnwrap[0].slug);
    process.exit(1);
  }

  const ids = rows.map(r => r.id);
  const fms = rows.map(r => JSON.stringify(r.fixed_frontmatter));
  const hashes = rows.map(r => contentHash({
    title: r.title,
    type: r.type,
    compiled_truth: r.compiled_truth ?? "",
    timeline: r.timeline ?? "",
    frontmatter: r.fixed_frontmatter,
  }));

  // Write rollback first
  for (let i = 0; i < rows.length; i++) {
    appendFileSync(rollbackPath, JSON.stringify({
      id: rows[i].id,
      slug: rows[i].slug,
      previous_frontmatter_raw: rows[i].corrupt_frontmatter,
      previous_content_hash: rows[i].old_hash,
      fixed_frontmatter: rows[i].fixed_frontmatter,
      new_content_hash: hashes[i],
    }) + "\n");
  }
  console.log(`[rollback] wrote ${rows.length} entries`);

  // Bulk UPDATE via UNNEST (::text[] + ::jsonb cast, the known-good pattern)
  const result = await sql`
    UPDATE pages p
    SET frontmatter = d.fm::jsonb,
        content_hash = d.hash,
        updated_at = now()
    FROM (
      SELECT UNNEST(${ids}::int[]) AS id,
             UNNEST(${fms}::text[]) AS fm,
             UNNEST(${hashes}::text[]) AS hash
    ) d
    WHERE p.id = d.id
    RETURNING p.id
  `;
  console.log(`[updated] ${result.length} rows`);

  // Verify
  const [{ remaining }] = await sql`
    SELECT COUNT(*)::int AS remaining FROM pages
    WHERE jsonb_typeof(frontmatter) = 'string'
  `;
  console.log(`[verify] string-typed rows remaining: ${remaining} (expect 0)`);

  // Recount enrichment state now that keys are queryable again
  const state = await sql`
    SELECT frontmatter->>'enrichment_source' AS src,
           frontmatter->>'enrichment_verified' AS verified,
           COUNT(*)::int AS n
    FROM pages WHERE type='company'
    GROUP BY src, verified ORDER BY n DESC
  `;
  console.log(`[state] post-fix enrichment distribution:`);
  for (const r of state) console.log(`  src=${r.src} verified=${r.verified}: ${r.n}`);
} finally {
  await sql.end();
}
