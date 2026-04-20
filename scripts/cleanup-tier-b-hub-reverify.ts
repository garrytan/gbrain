#!/usr/bin/env bun
// Tier B hub re-verification: Haiku 4.5 + web search for the 35 companies
// in Tier B non-noise with inbound edges >= 3. Budget cap $5, time cap 5 min.
// Per-row persistence (no end-of-run batch). Sets enrichment_source=
// 'haiku_search' + enrichment_verified=true so rows join Tier C semantics.

import postgres from "postgres";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";

const cfg = JSON.parse(readFileSync("/Users/gergoorendi/.gbrain/config.json", "utf8"));
const ANTHROPIC_API_KEY = cfg.anthropic_api_key;
if (!ANTHROPIC_API_KEY) throw new Error("no anthropic_api_key in gbrain config");

const sql = postgres(cfg.database_url, { max: 2, idle_timeout: 30, connect_timeout: 10 });

const BUDGET_USD = 5.0;
const TIME_CAP_MS = 5 * 60 * 1000;
const CONCURRENCY = 5;
const JITTER_MS = 200;

// Minimal industry -> bucket classifier (same taxonomy as cleanup-industry-normalize.ts,
// regex fallbacks cover the typical Haiku outputs). Order matters: first match wins.
const BUCKET_FALLBACKS: Array<[RegExp, string]> = [
  [/\bfintech|banking|insur|lending|payment|credit|finance|financial|crypto|blockchain|nft\b/i, "fintech"],
  [/\b(ai|ml|machine learning|neural)\b/i, "ai_ml"],
  [/cybersecurity|security/i, "cybersecurity"],
  [/health|medical|pharma|biotech|clinic|wellness|fitness/i, "healthcare"],
  [/education|edtech|academic|university|school/i, "education"],
  [/manufactur|industrial|chemical|semiconductor|hardware|aerospace|defense|robot|machinery|packag/i, "manufacturing"],
  [/automotive|mobility|vehicle|ev charging/i, "automotive_mobility"],
  [/energ|oil|gas|solar|utilit|water|environment|waste|sustainab/i, "energy_utilities"],
  [/media|news|broadcast|publishing|gaming|entertainment|music|design|marketing|advertis|adtech|martech|creative|pr |public relations|fashion|apparel|theater|museum|event/i, "media_entertainment"],
  [/retail|e-?commerce|consumer|food|beverage|restaurant|hospitality|travel|tourism|dating|toy/i, "retail_ecommerce"],
  [/real estate|proptech|construction|facilit/i, "real_estate_construction"],
  [/logistic|transport|shipping|aviation|airport|airline|rail|marine|supply chain|navigation/i, "logistics_transport"],
  [/telecom|networking|telematics/i, "telecom"],
  [/legal|law|intellectual/i, "legal"],
  [/recruit|staffing|hr |human resource|outsourc|coaching|employment|job/i, "hr_staffing"],
  [/govern|nonprofit|non-profit|philanthropy|research|public sector|religion|military|association/i, "government_nonprofit"],
  [/agricult|farming/i, "agriculture"],
  [/consult|advisor/i, "consulting"],
  [/saas|software|technology|data|cloud|analytic|platform|it /i, "saas_software"],
];

function classifyIndustry(raw: string | null | undefined): string {
  if (!raw) return "other";
  const key = raw.toLowerCase().trim();
  if (key === "noise") return "noise";
  for (const [re, b] of BUCKET_FALLBACKS) {
    if (re.test(key)) return b;
  }
  return "other";
}

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
const rollbackPath = `${rollbackDir}/tier-b-hub-reverify-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);
console.log(`[cap] budget=$${BUDGET_USD.toFixed(2)} time=${TIME_CAP_MS / 60000}min concurrency=${CONCURRENCY}`);

const PROMPT = (name: string) => `You are looking up factual details about a company. Use web search to find accurate, current information.

Company name: "${name}"

Return a single JSON object (and ONLY that JSON object, no prose) with these fields:
- industry: short phrase, lowercase, 1-3 words (e.g. "fintech", "banking", "saas", "consulting", "education")
- industry_specific: more precise categorization if meaningful (e.g. "core banking software", "iot platform"). Can be null.
- hq_country: 2-letter ISO country code of headquarters (e.g. "SG", "US", "HU", "DE"). Null if genuinely unknown.
- hq_city: primary HQ city (e.g. "Singapore", "Berlin"). Null if unknown.
- website: canonical domain only, lowercase, no scheme or www (e.g. "mambu.com"). Null if unknown.
- size_category: one of "startup" | "growth" | "enterprise" | "unknown"
- description: one concise sentence (<=160 chars) describing what the company does
- confidence: one of "high" | "medium" | "low" - your confidence these facts are about THIS specific company (vs a namesake or disambiguation issue)

If the name is ambiguous, pick the most likely interpretation given it's a company from a LinkedIn network, and set confidence to "low" if unsure.

If the name is obviously not a real company, return:
{"industry": "noise", "hq_country": null, "hq_city": null, "website": null, "size_category": "unknown", "description": "Placeholder, not a real company", "confidence": "high"}

Return JSON only, no markdown fences, no prose.`;

type EnrichResult = {
  industry: string | null;
  industry_specific?: string | null;
  hq_country: string | null;
  hq_city: string | null;
  website: string | null;
  size_category: string | null;
  description: string | null;
  confidence: string | null;
};

async function enrichCompany(name: string): Promise<{ ok: true; data: EnrichResult; usage: any } | { ok: false; error: string }> {
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: PROMPT(name) }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  const data = await res.json();
  const textBlocks = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text);
  const fullText = textBlocks.join("\n").trim();
  let jsonText = fullText;
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  try {
    const parsed = JSON.parse(jsonText) as EnrichResult;
    return { ok: true, data: parsed, usage: data.usage };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${jsonText.slice(0, 300)}` };
  }
}

function estimateCost(usage: any): number {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const searches = usage?.server_tool_use?.web_search_requests ?? 0;
  return (input / 1e6) * 1.0 + (output / 1e6) * 5.0 + (searches / 1000) * 10.0;
}

const t0 = Date.now();

console.log("[1] Fetching Tier B non-noise hubs (inbound edges >= 3)...");
const targets = await sql<{ id: number; slug: string; title: string; compiled_truth: string; timeline: string; frontmatter: any; type: string; inbound: number }[]>`
  SELECT p.id, p.slug, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.type,
         (SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND l.link_type = 'works_at') AS inbound
  FROM pages p
  WHERE p.type = 'company'
    AND p.frontmatter->>'enrichment_source' = 'no_search'
    AND (p.frontmatter->>'industry_original' IS NULL OR p.frontmatter->>'industry_original' != 'noise')
    AND (SELECT COUNT(*) FROM links l WHERE l.to_page_id = p.id AND l.link_type = 'works_at') >= 3
  ORDER BY inbound DESC
`;
console.log(`[1] found ${targets.length} hubs`);
for (const t of targets) console.log(`    [${String(t.inbound).padStart(3)}] ${t.title} (${t.slug})`);

// Shared cost counter (protected by JS single-threaded nature)
let cumulativeCost = 0;
let completed = 0;
let failed = 0;
let skipped = 0;
const failures: { slug: string; error: string }[] = [];
const capHit: { reason: string } = { reason: "" };

async function worker(queue: typeof targets) {
  while (queue.length > 0) {
    if (capHit.reason) return;

    // Cap checks
    const elapsed = Date.now() - t0;
    if (elapsed > TIME_CAP_MS) {
      capHit.reason = `time cap hit at ${(elapsed / 1000).toFixed(0)}s`;
      return;
    }
    if (cumulativeCost > BUDGET_USD) {
      capHit.reason = `budget cap hit at $${cumulativeCost.toFixed(4)}`;
      return;
    }

    const t = queue.shift();
    if (!t) break;
    await new Promise(r => setTimeout(r, Math.random() * JITTER_MS));
    const callT0 = Date.now();
    const r = await enrichCompany(t.title);
    const callMs = Date.now() - callT0;

    if (!r.ok) {
      failed++;
      failures.push({ slug: t.slug, error: r.error });
      console.log(`  [${callMs}ms] FAIL ${t.title}: ${r.error.slice(0, 120)}`);
      continue;
    }

    const callCost = estimateCost(r.usage);
    cumulativeCost += callCost;

    const bucket = classifyIndustry(r.data.industry);
    const newFm = {
      ...t.frontmatter,
      industry: bucket,
      industry_canonical: bucket,
      industry_original: r.data.industry ?? t.frontmatter?.industry_original,
      industry_specific: r.data.industry_specific ?? null,
      hq_country: r.data.hq_country,
      hq_city: r.data.hq_city,
      website: r.data.website,
      size_category: r.data.size_category,
      description: r.data.description,
      enrichment_confidence: r.data.confidence,
      enrichment_source: "haiku_search",
      enrichment_verified: true,
      enriched_at: new Date().toISOString(),
    };
    const newHash = contentHash({
      title: t.title,
      type: t.type,
      compiled_truth: t.compiled_truth ?? "",
      timeline: t.timeline ?? "",
      frontmatter: newFm,
    });

    // Persist IMMEDIATELY (no end-of-run batch)
    appendFileSync(rollbackPath, JSON.stringify({
      slug: t.slug,
      id: t.id,
      inbound: t.inbound,
      previous_frontmatter: t.frontmatter,
      new_frontmatter: newFm,
      call_cost_usd: callCost,
      usage: r.usage,
    }) + "\n");

    await sql`
      UPDATE pages
      SET frontmatter = ${sql.json(newFm)},
          content_hash = ${newHash},
          updated_at = now()
      WHERE id = ${t.id}
    `;

    completed++;
    console.log(`  [${callMs}ms $${callCost.toFixed(4)}] ${t.title}: ${r.data.industry}->${bucket}, ${r.data.hq_country ?? '?'} conf=${r.data.confidence} (cum=$${cumulativeCost.toFixed(4)} done=${completed}/${targets.length})`);

    // After first 3 successful calls, sanity-check avg cost
    if (completed === 3) {
      const avg = cumulativeCost / completed;
      if (avg > 0.10) {
        capHit.reason = `unexpected cost per call (avg $${avg.toFixed(4)}); stopping per sanity check`;
        return;
      }
    }
  }
}

console.log(`\n[2] running enrichment with concurrency=${CONCURRENCY}...\n`);
const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
skipped = queue.length;

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== REPORT ===`);
if (capHit.reason) console.log(`CAP HIT: ${capHit.reason}`);
console.log(`  completed: ${completed}/${targets.length}`);
console.log(`  failed:    ${failed}`);
console.log(`  skipped:   ${skipped}  (not attempted due to cap or queue empty)`);
console.log(`  cost:      $${cumulativeCost.toFixed(4)} of $${BUDGET_USD.toFixed(2)} budget`);
console.log(`  wall:      ${elapsedSec}s of ${TIME_CAP_MS / 60000}min cap`);
console.log(`  rollback:  ${rollbackPath}`);

if (failures.length > 0) {
  console.log(`\nFAILURES:`);
  for (const f of failures) console.log(`  ${f.slug}: ${f.error.slice(0, 200)}`);
}

// Post-verify
const [{ verifiedCount }] = await sql`
  SELECT COUNT(*)::int AS "verifiedCount" FROM pages
  WHERE type='company'
    AND frontmatter->>'enrichment_source' = 'haiku_search'
    AND frontmatter->>'enrichment_verified' = 'true'
`;
console.log(`\n[verify] total haiku_search-verified rows now: ${verifiedCount}`);

await sql.end();
