#!/usr/bin/env bun
// Report-only: find near-duplicate company stubs. No DB writes.
// Outputs candidates to /tmp/stub-dedup-candidates.json for manual review.
// Per gbrain-work-2026-04-20.md section 4.3.

import postgres from "postgres";
import { readFileSync, writeFileSync } from "fs";

const cfg = JSON.parse(readFileSync("/Users/gergoorendi/.gbrain/config.json", "utf8"));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 30, connect_timeout: 10 });

// STRICT legal-entity suffixes only. Keep "technology/services/solutions/group/
// holdings/international" as meaningful tokens: they often distinguish parent vs.
// subsidiary. Stripping them produces too many false-positive merges.
const LEGAL_SUFFIXES = [
  "private limited", "pvt ltd", "pvt. ltd.", "pvt. ltd", "pvt ltd.",
  "public limited company", "plc",
  "limited liability company", "l.l.c.", "llc",
  "corporation", "corp.", "corp", "incorporated", "inc.", "inc",
  "limited", "ltd.", "ltd",
  "gmbh & co. kg", "gmbh", "g.m.b.h.",
  "sas", "s.a.s.", "s.a.s", "sarl", "s.a.r.l.", "s.a.r.l",
  "sa", "s.a.", "s.a",
  "n.v.", "nv", "b.v.", "bv",
  "a.g.", "ag",
  "oyj", "oy",
  "ab",
  "a.s.", "as",
  "sp. z o.o.", "sp z o o", "spolka z o.o.",
  "s.r.o.", "sro",
  "zrt.", "zrt", "nyrt.", "nyrt", "kft.", "kft", "bt.", "bt",
  "kg", "ohg",
  "pte. ltd.", "pte ltd", "pte.ltd.", "pte ltd.",
  "sdn bhd", "sdn. bhd.",
];

function normalize(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // strip accents
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9\s\.\-]/g, " "); // keep dots/hyphens for suffix match, strip punct
  s = s.replace(/\s+/g, " ").trim();

  // Strip trailing legal suffixes (iteratively, longest first).
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      const pattern = new RegExp(`[\\s\\.,]+${suf.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\\\\\./g, "\\\\.?")}$`);
      if (pattern.test(s)) {
        s = s.replace(pattern, "").trim();
        changed = true;
      }
    }
  }

  s = s.replace(/[\.\-]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function extractDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let w = String(website).toLowerCase().trim();
  w = w.replace(/^https?:\/\//, "").replace(/^www\./, "");
  w = w.split("/")[0].split("?")[0];
  if (!w || !w.includes(".")) return null;
  return w;
}

// Damerau-Levenshtein distance, capped.
function editDistance(a: string, b: string, cap: number = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

try {
  const rows = await sql`
    SELECT id, slug, title,
           frontmatter->>'website' AS website,
           frontmatter->>'industry' AS industry,
           frontmatter->>'hq_country' AS hq_country,
           frontmatter->>'industry_original' AS industry_original,
           (SELECT COUNT(*)::int FROM links WHERE to_page_id = pages.id) AS inbound_edges
    FROM pages
    WHERE type='company'
  `;
  console.log(`[loaded] ${rows.length} company rows`);

  // Build normalized index + domain index
  type Row = typeof rows[0] & { norm: string; domain: string | null };
  const enriched: Row[] = rows.map(r => ({
    ...r,
    norm: normalize(String(r.title ?? "")),
    domain: extractDomain(r.website),
  }));

  // Group 1: EXACT normalized-name match (highest confidence merges)
  const byNorm = new Map<string, Row[]>();
  for (const r of enriched) {
    if (!r.norm) continue;
    if (!byNorm.has(r.norm)) byNorm.set(r.norm, []);
    byNorm.get(r.norm)!.push(r);
  }
  const exactDupeGroups = [...byNorm.values()].filter(g => g.length > 1);
  console.log(`[exact] ${exactDupeGroups.length} groups with ${exactDupeGroups.reduce((n, g) => n + g.length, 0)} total rows`);

  // Group 2: EXACT domain match (high confidence; different names but same site)
  const byDomain = new Map<string, Row[]>();
  for (const r of enriched) {
    if (!r.domain) continue;
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain)!.push(r);
  }
  const domainDupeGroups = [...byDomain.values()].filter(g => g.length > 1 &&
    // Skip groups already fully captured by exact-norm match
    new Set(g.map(r => r.norm)).size > 1
  );
  console.log(`[domain] ${domainDupeGroups.length} groups differ by name but share domain`);

  // Group 3: FUZZY normalized-name match (edit distance <= 2, min length 5)
  // Only check unique norms; bucket by first 3 chars to keep O(n^2) bounded.
  const uniqueNorms = [...byNorm.keys()].filter(n => n.length >= 5);
  const byPrefix = new Map<string, string[]>();
  for (const n of uniqueNorms) {
    const key = n.slice(0, 3);
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key)!.push(n);
  }
  type FuzzyPair = { a: string; b: string; dist: number; rows_a: Row[]; rows_b: Row[] };
  const fuzzyPairs: FuzzyPair[] = [];
  const seenPair = new Set<string>();
  for (const bucket of byPrefix.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const pairKey = [a, b].sort().join("||");
        if (seenPair.has(pairKey)) continue;
        seenPair.add(pairKey);
        const d = editDistance(a, b, 2);
        if (d > 0 && d <= 2) {
          fuzzyPairs.push({ a, b, dist: d, rows_a: byNorm.get(a)!, rows_b: byNorm.get(b)! });
        }
      }
    }
  }
  console.log(`[fuzzy] ${fuzzyPairs.length} candidate pairs (edit distance 1-2)`);

  // Output report
  const report = {
    generated_at: new Date().toISOString(),
    total_company_rows: rows.length,
    summary: {
      exact_norm_groups: exactDupeGroups.length,
      exact_norm_rows: exactDupeGroups.reduce((n, g) => n + g.length, 0),
      domain_match_groups: domainDupeGroups.length,
      fuzzy_pairs: fuzzyPairs.length,
    },
    exact_norm_groups: exactDupeGroups
      .sort((a, b) => b.reduce((n, r) => n + r.inbound_edges, 0) - a.reduce((n, r) => n + r.inbound_edges, 0))
      .map(g => ({
        norm: g[0].norm,
        total_edges: g.reduce((n, r) => n + r.inbound_edges, 0),
        rows: g.map(r => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          website: r.website,
          industry: r.industry,
          hq_country: r.hq_country,
          inbound_edges: r.inbound_edges,
        })),
      })),
    domain_match_groups: domainDupeGroups
      .sort((a, b) => b.reduce((n, r) => n + r.inbound_edges, 0) - a.reduce((n, r) => n + r.inbound_edges, 0))
      .map(g => ({
        domain: g[0].domain,
        rows: g.map(r => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          norm: r.norm,
          industry: r.industry,
          hq_country: r.hq_country,
          inbound_edges: r.inbound_edges,
        })),
      })),
    fuzzy_pairs: fuzzyPairs
      .sort((a, b) =>
        (b.rows_a[0].inbound_edges + b.rows_b[0].inbound_edges) -
        (a.rows_a[0].inbound_edges + a.rows_b[0].inbound_edges)
      )
      .slice(0, 100)
      .map(p => ({
        dist: p.dist,
        a: { norm: p.a, rows: p.rows_a.map(r => ({ slug: r.slug, title: r.title, edges: r.inbound_edges })) },
        b: { norm: p.b, rows: p.rows_b.map(r => ({ slug: r.slug, title: r.title, edges: r.inbound_edges })) },
      })),
  };

  const outPath = "/tmp/stub-dedup-candidates.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[wrote] ${outPath}`);

  // Print top 15 of each category for console preview
  console.log("\n=== TOP 15 exact-norm dup groups (by combined inbound edges) ===");
  for (const g of report.exact_norm_groups.slice(0, 15)) {
    console.log(`  [${g.total_edges} edges total] "${g.norm}"`);
    for (const r of g.rows) console.log(`    - ${r.slug} | ${r.title} | ${r.website ?? "-"} | edges=${r.inbound_edges}`);
  }

  console.log("\n=== TOP 10 domain-match groups (different name, same site) ===");
  for (const g of report.domain_match_groups.slice(0, 10)) {
    console.log(`  domain=${g.domain}`);
    for (const r of g.rows) console.log(`    - ${r.slug} | ${r.title} | edges=${r.inbound_edges}`);
  }

  console.log("\n=== TOP 15 fuzzy pairs (edit-distance 1-2) ===");
  for (const p of report.fuzzy_pairs.slice(0, 15)) {
    console.log(`  dist=${p.dist}`);
    console.log(`    A: "${p.a.norm}" -> ${p.a.rows.map(r => r.slug).join(", ")}`);
    console.log(`    B: "${p.b.norm}" -> ${p.b.rows.map(r => r.slug).join(", ")}`);
  }
} finally {
  await sql.end();
}
