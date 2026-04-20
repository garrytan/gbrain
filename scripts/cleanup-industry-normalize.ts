#!/usr/bin/env bun
// Normalize `industry` on company pages to a controlled ~20-bucket taxonomy.
// Preserves the original in `industry_original`. Zero API cost.
// Per gbrain-work-2026-04-20.md section 4.3.

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

// Controlled taxonomy. Add a new bucket only when it's genuinely orthogonal
// to the others; the goal is ~20 buckets, not 50.
const BUCKETS = [
  "noise",
  "fintech",
  "saas_software",
  "consulting",
  "cybersecurity",
  "healthcare",
  "education",
  "manufacturing",
  "automotive_mobility",
  "energy_utilities",
  "media_entertainment",
  "retail_ecommerce",
  "real_estate_construction",
  "logistics_transport",
  "ai_ml",
  "telecom",
  "hr_staffing",
  "legal",
  "government_nonprofit",
  "agriculture",
  "other",
] as const;
type Bucket = typeof BUCKETS[number];

// Explicit mapping for high-volume and unambiguous values.
// Keys are lowercased, trimmed.
const EXPLICIT: Record<string, Bucket> = {
  // noise preserved as-is
  "noise": "noise",

  // fintech + adjacent money
  "fintech": "fintech",
  "financial services": "fintech",
  "financial software": "fintech",
  "financial software and media": "fintech",
  "financial technology": "fintech",
  "financial analytics": "fintech",
  "financial advisory": "fintech",
  "financial research": "fintech",
  "financial media": "fintech",
  "financial education": "fintech",
  "finance": "fintech",
  "banking": "fintech",
  "fintech banking": "fintech",
  "fintech news": "fintech",
  "fintech consulting": "fintech",
  "insurance": "fintech",
  "insurtech": "fintech",
  "insurance brokerage": "fintech",
  "health insurance": "fintech",
  "asset management": "fintech",
  "investment management": "fintech",
  "private equity": "fintech",
  "venture capital": "fintech",
  "vc": "fintech",
  "microfinance": "fintech",
  "credit reporting": "fintech",
  "credit intelligence": "fintech",
  "debt collection": "fintech",
  "accounting software": "fintech",
  "accounting consulting": "fintech",
  "blockchain": "fintech",
  "cryptocurrency": "fintech",
  "cryptocurrency exchange": "fintech",
  "cryptocurrency mining": "fintech",
  "nft marketplace": "fintech",
  "identity verification": "fintech",
  "compliance software": "fintech",
  "compliance technology": "fintech",
  "gambling compliance": "fintech",
  "environmental finance": "fintech",

  // saas / general software
  "saas": "saas_software",
  "software": "saas_software",
  "software development": "saas_software",
  "software saas": "saas_software",
  "enterprise software": "saas_software",
  "database software": "saas_software",
  "analytics": "saas_software",
  "business intelligence": "saas_software",
  "business solutions": "saas_software",
  "digital services": "saas_software",
  "digital solutions": "saas_software",
  "information technology": "saas_software",
  "technology": "saas_software",
  "cloud computing": "saas_software",
  "cloud infrastructure": "saas_software",
  "cloud storage": "saas_software",
  "data center": "saas_software",
  "data management": "saas_software",
  "web hosting": "saas_software",
  "web services": "saas_software",
  "infrastructure management": "saas_software",
  "visualization technology": "saas_software",
  "it services": "saas_software",
  "it distribution": "saas_software",
  "mobile app": "saas_software",

  // consulting
  "consulting": "consulting",
  "it consulting": "consulting",
  "software consulting": "consulting",
  "technology consulting": "consulting",
  "engineering consulting": "consulting",
  "design consulting": "consulting",
  "ai consulting": "consulting",
  "management consulting": "consulting",
  "hr consulting": "consulting",
  "business services": "consulting",

  // cybersecurity
  "cybersecurity": "cybersecurity",
  "cybersecurity saas": "cybersecurity",
  "security": "cybersecurity",
  "security technology": "cybersecurity",

  // healthcare
  "healthcare": "healthcare",
  "healthcare services": "healthcare",
  "healthcare technology": "healthcare",
  "healthcare ai": "healthcare",
  "healthcare saas": "healthcare",
  "health clubs": "healthcare",
  "medical devices": "healthcare",
  "pharmaceutical": "healthcare",
  "pharmaceuticals": "healthcare",
  "pharmaceutical services": "healthcare",
  "pharmaceutical distribution": "healthcare",
  "pharmaceuticals and diagnostics": "healthcare",
  "pharmacy": "healthcare",
  "biotech": "healthcare",
  "biotechnology": "healthcare",
  "biopharmaceutical": "healthcare",
  "telehealth": "healthcare",
  "digital health": "healthcare",
  "healthtech": "healthcare",
  "genomics": "healthcare",
  "diagnostics": "healthcare",
  "dental healthcare": "healthcare",
  "mental health services": "healthcare",
  "mental health saas": "healthcare",
  "wellness": "healthcare",
  "senior care": "healthcare",
  "clinical research": "healthcare",
  "clinical trials software": "healthcare",
  "consumer health": "healthcare",
  "fitness": "healthcare",
  "fitness hardware": "healthcare",
  "fitness technology": "healthcare",

  // education
  "education": "education",
  "edtech": "education",
  "education technology": "education",
  "academic publishing": "education",
  "startup accelerator": "education",
  "startup studio": "education",

  // manufacturing / hardware / industrial
  "manufacturing": "manufacturing",
  "electronics": "manufacturing",
  "electronics manufacturing": "manufacturing",
  "computer hardware": "manufacturing",
  "consumer electronics": "manufacturing",
  "semiconductors": "manufacturing",
  "semiconductor testing": "manufacturing",
  "robotics": "manufacturing",
  "industrial machinery": "manufacturing",
  "industrial automation": "manufacturing",
  "industrial technology": "manufacturing",
  "steel manufacturing": "manufacturing",
  "chemicals": "manufacturing",
  "specialty chemicals": "manufacturing",
  "materials": "manufacturing",
  "machinery": "manufacturing",
  "textile manufacturing": "manufacturing",
  "food manufacturing": "manufacturing",
  "food processing": "manufacturing",
  "beverage manufacturing": "manufacturing",
  "signage manufacturing": "manufacturing",
  "consumer goods manufacturing": "manufacturing",
  "plastic manufacturing": "manufacturing",
  "plastics manufacturing": "manufacturing",
  "packaging": "manufacturing",
  "packaging and paper": "manufacturing",
  "defense manufacturing": "manufacturing",
  "defense technology": "manufacturing",
  "toy manufacturing": "manufacturing",
  "lighting manufacturing": "manufacturing",
  "home appliances": "manufacturing",
  "consumer durables": "manufacturing",
  "telecommunications equipment": "manufacturing",
  "electrical engineering": "manufacturing",
  "engineering manufacturing": "manufacturing",
  "engineering": "manufacturing",
  "aerospace": "manufacturing",
  "aerospace and defense": "manufacturing",
  "aerospace & defense": "manufacturing",
  "photonics manufacturing": "manufacturing",
  "iot hardware": "manufacturing",
  "ai hardware": "manufacturing",
  "automotive components": "manufacturing",
  "automotive manufacturing": "manufacturing",
  "recreational equipment": "manufacturing",
  "safety equipment": "manufacturing",
  "tools": "manufacturing",
  "agriculture equipment": "manufacturing",
  "agricultural equipment": "manufacturing",
  "building materials": "manufacturing",
  "research and development": "manufacturing",
  "testing and certification": "manufacturing",

  // automotive / mobility (non-manufacturing side of it)
  "automotive": "automotive_mobility",
  "automotive testing": "automotive_mobility",
  "automotive salvage": "automotive_mobility",
  "automotive saas": "automotive_mobility",
  "automotive software": "automotive_mobility",
  "car sharing": "automotive_mobility",
  "car rental": "automotive_mobility",
  "ev charging": "automotive_mobility",
  "electric vehicle charging": "automotive_mobility",
  "mobility": "automotive_mobility",
  "mobility services": "automotive_mobility",
  "saas mobility": "automotive_mobility",

  // energy / utilities
  "energy": "energy_utilities",
  "oil and gas": "energy_utilities",
  "oil & gas": "energy_utilities",
  "renewable energy": "energy_utilities",
  "clean energy": "energy_utilities",
  "solar energy": "energy_utilities",
  "nuclear energy": "energy_utilities",
  "energy utilities": "energy_utilities",
  "energy technology": "energy_utilities",
  "utilities": "energy_utilities",
  "water utilities": "energy_utilities",
  "water management": "energy_utilities",
  "water treatment": "energy_utilities",
  "water infrastructure": "energy_utilities",
  "water technology": "energy_utilities",
  "fuel distribution": "energy_utilities",
  "environmental services": "energy_utilities",
  "sustainable products": "energy_utilities",
  "sustainability software": "energy_utilities",
  "waste management": "energy_utilities",

  // media / entertainment / marketing
  "media": "media_entertainment",
  "digital media": "media_entertainment",
  "media publishing": "media_entertainment",
  "media production": "media_entertainment",
  "media technology": "media_entertainment",
  "media and entertainment": "media_entertainment",
  "media and broadcasting": "media_entertainment",
  "media and publishing": "media_entertainment",
  "media broadcasting": "media_entertainment",
  "publishing": "media_entertainment",
  "digital publishing": "media_entertainment",
  "broadcasting": "media_entertainment",
  "news": "media_entertainment",
  "entertainment": "media_entertainment",
  "adult entertainment": "media_entertainment",
  "social media": "media_entertainment",
  "social networking": "media_entertainment",
  "social technology": "media_entertainment",
  "community": "media_entertainment",
  "advertising technology": "media_entertainment",
  "adtech": "media_entertainment",
  "advertising marketing": "media_entertainment",
  "marketing": "media_entertainment",
  "marketing services": "media_entertainment",
  "marketing agency": "media_entertainment",
  "digital marketing": "media_entertainment",
  "martech": "media_entertainment",
  "creative services": "media_entertainment",
  "creative agency": "media_entertainment",
  "public relations": "media_entertainment",
  "branding and design": "media_entertainment",
  "design": "media_entertainment",
  "design studio": "media_entertainment",
  "design saas": "media_entertainment",
  "interior design": "media_entertainment",
  "web design": "media_entertainment",
  "fashion": "media_entertainment",
  "apparel": "media_entertainment",
  "beauty retail": "media_entertainment",
  "cosmetics": "media_entertainment",
  "music": "media_entertainment",
  "music technology": "media_entertainment",
  "music services": "media_entertainment",
  "music and performing arts": "media_entertainment",
  "theater": "media_entertainment",
  "video games": "media_entertainment",
  "video game development": "media_entertainment",
  "gaming": "media_entertainment",
  "mobile gaming": "media_entertainment",
  "gambling": "media_entertainment",
  "online gambling": "media_entertainment",
  "sports betting": "media_entertainment",
  "sports": "media_entertainment",
  "sports management": "media_entertainment",
  "sports technology": "media_entertainment",
  "animation software": "media_entertainment",
  "arts and culture": "media_entertainment",
  "cultural event": "media_entertainment",
  "cultural institution": "media_entertainment",
  "museum": "media_entertainment",
  "events": "media_entertainment",
  "events and exhibitions": "media_entertainment",
  "events planning": "media_entertainment",
  "event planning": "media_entertainment",
  "event services": "media_entertainment",
  "event technology": "media_entertainment",
  "events and consulting": "media_entertainment",
  "gaming and hospitality": "media_entertainment",
  "ticketing": "media_entertainment",

  // retail / e-commerce / consumer / food / hospitality / travel
  "retail": "retail_ecommerce",
  "retail technology": "retail_ecommerce",
  "e-commerce": "retail_ecommerce",
  "ecommerce": "retail_ecommerce",
  "e-commerce retail": "retail_ecommerce",
  "e-commerce and cloud computing": "retail_ecommerce",
  "loyalty rewards": "retail_ecommerce",
  "consumer goods": "retail_ecommerce",
  "coffee retail": "retail_ecommerce",
  "food": "retail_ecommerce",
  "food and beverage": "retail_ecommerce",
  "food & beverage": "retail_ecommerce",
  "food delivery": "retail_ecommerce",
  "food services": "retail_ecommerce",
  "beverages": "retail_ecommerce",
  "beverage": "retail_ecommerce",
  "beverage distribution": "retail_ecommerce",
  "dairy": "retail_ecommerce",
  "wine": "retail_ecommerce",
  "wine trading": "retail_ecommerce",
  "restaurants": "retail_ecommerce",
  "restaurant": "retail_ecommerce",
  "hospitality": "retail_ecommerce",
  "travel": "retail_ecommerce",
  "travel and entertainment": "retail_ecommerce",
  "travel tech": "retail_ecommerce",
  "travel technology": "retail_ecommerce",
  "tourism": "retail_ecommerce",
  "dating": "retail_ecommerce",
  "toys": "retail_ecommerce",
  "jewelry": "retail_ecommerce",
  "footwear": "retail_ecommerce",
  "luggage": "retail_ecommerce",
  "home improvement": "retail_ecommerce",
  "classifieds": "retail_ecommerce",
  "direct sales": "retail_ecommerce",

  // real estate / construction
  "real estate": "real_estate_construction",
  "real estate technology": "real_estate_construction",
  "proptech": "real_estate_construction",
  "proptech saas": "real_estate_construction",
  "property management": "real_estate_construction",
  "construction": "real_estate_construction",
  "construction software": "real_estate_construction",
  "facilities management": "real_estate_construction",
  "facility management": "real_estate_construction",

  // logistics / transport
  "logistics": "logistics_transport",
  "logistics technology": "logistics_transport",
  "logistics it": "logistics_transport",
  "logistics software": "logistics_transport",
  "logistics robotics": "logistics_transport",
  "logistics and transportation": "logistics_transport",
  "shipping and logistics": "logistics_transport",
  "transportation": "logistics_transport",
  "transportation technology": "logistics_transport",
  "public transportation": "logistics_transport",
  "government transportation": "logistics_transport",
  "freight rail": "logistics_transport",
  "freight rail transport": "logistics_transport",
  "marine services": "logistics_transport",
  "aviation": "logistics_transport",
  "aviation technology": "logistics_transport",
  "airport": "logistics_transport",
  "airline": "logistics_transport",
  "supply chain": "logistics_transport",
  "supply chain logistics": "logistics_transport",
  "supply chain software": "logistics_transport",
  "navigation": "logistics_transport",
  "satellite imagery": "logistics_transport",
  "location intelligence": "logistics_transport",

  // ai / ml
  "artificial intelligence": "ai_ml",
  "ai": "ai_ml",
  "ai software": "ai_ml",
  "ai/ml": "ai_ml",
  "ai video": "ai_ml",
  "computer vision": "ai_ml",
  "virtual reality": "ai_ml",
  "3d volumetric video": "ai_ml",
  "3d metrology": "ai_ml",

  // telecom
  "telecommunications": "telecom",
  "telecom": "telecom",
  "networking technology": "telecom",
  "telematics": "telecom",

  // hr / staffing
  "recruitment": "hr_staffing",
  "recruiting": "hr_staffing",
  "staffing": "hr_staffing",
  "staffing and recruitment": "hr_staffing",
  "executive search": "hr_staffing",
  "human resources": "hr_staffing",
  "hr tech": "hr_staffing",
  "hr technology": "hr_staffing",
  "outsourcing": "hr_staffing",
  "employee benefits": "hr_staffing",
  "coaching": "hr_staffing",
  "job board": "hr_staffing",
  "contact center": "hr_staffing",

  // legal
  "legal services": "legal",
  "law": "legal",
  "legal tech": "legal",
  "legal technology": "legal",
  "legaltech saas": "legal",
  "intellectual property": "legal",

  // government / nonprofit / public sector / research
  "government": "government_nonprofit",
  "local government": "government_nonprofit",
  "public administration": "government_nonprofit",
  "government administration": "government_nonprofit",
  "government development": "government_nonprofit",
  "government technology": "government_nonprofit",
  "government research": "government_nonprofit",
  "nonprofit": "government_nonprofit",
  "non-profit": "government_nonprofit",
  "nonprofit technology": "government_nonprofit",
  "philanthropy": "government_nonprofit",
  "research": "government_nonprofit",
  "research funding": "government_nonprofit",
  "research and innovation": "government_nonprofit",
  "economic development": "government_nonprofit",
  "disability services": "government_nonprofit",
  "business association": "government_nonprofit",
  "business organization": "government_nonprofit",
  "industry association": "government_nonprofit",
  "market research": "government_nonprofit",
  "religion": "government_nonprofit",
  "religious technology": "government_nonprofit",
  "militair": "government_nonprofit",
  "military": "government_nonprofit",

  // agriculture
  "agriculture": "agriculture",
  "agriculture technology": "agriculture",
  "agriculture commodities": "agriculture",

  // other / misc (explicit so they don't fall through)
  "holding company": "other",
  "trading conglomerate": "other",
  "business development": "other",
  "non-company": "other",
  "cards games": "media_entertainment",
  "localization services": "saas_software",
  "language services": "saas_software",
  "market research": "government_nonprofit",
  "coworking": "real_estate_construction",
  "digital preservation": "saas_software",
};

// Fallback substring rules (applied only when explicit map misses).
// Order matters: first match wins.
const FALLBACKS: Array<[RegExp, Bucket]> = [
  [/\bfintech|banking|insur|lending|payment|credit|finance|financial|crypto|blockchain|nft\b/, "fintech"],
  [/\b(ai|ml|machine learning|neural)\b/, "ai_ml"],
  [/cybersecurity|security/, "cybersecurity"],
  [/health|medical|pharma|biotech|clinic|wellness|fitness/, "healthcare"],
  [/education|edtech|academic|university|school/, "education"],
  [/manufactur|industrial|chemical|semiconductor|hardware|aerospace|defense|robot|machinery|packag/, "manufacturing"],
  [/automotive|mobility|vehicle|ev charging/, "automotive_mobility"],
  [/energ|oil|gas|solar|utilit|water|environment|waste|sustainab/, "energy_utilities"],
  [/media|news|broadcast|publishing|gaming|entertainment|music|design|marketing|advertis|adtech|martech|creative|pr |public relations|fashion|apparel|theater|museum|event/, "media_entertainment"],
  [/retail|e-?commerce|consumer|food|beverage|restaurant|hospitality|travel|tourism|dating|toy/, "retail_ecommerce"],
  [/real estate|proptech|construction|facilit/, "real_estate_construction"],
  [/logistic|transport|shipping|aviation|airport|airline|rail|marine|supply chain|navigation/, "logistics_transport"],
  [/telecom|networking|telematics/, "telecom"],
  [/legal|law|intellectual/, "legal"],
  [/recruit|staffing|hr |human resource|outsourc|coaching|employment|job/, "hr_staffing"],
  [/govern|nonprofit|non-profit|philanthropy|research|public sector|religion|military|association/, "government_nonprofit"],
  [/agricult|farming/, "agriculture"],
  [/consult|advisor/, "consulting"],
  [/saas|software|technology|data|cloud|analytic|platform|it /, "saas_software"],
];

function classify(raw: string): { bucket: Bucket; via: "explicit" | "fallback" | "default" } {
  const key = raw.toLowerCase().trim();
  if (EXPLICIT[key]) return { bucket: EXPLICIT[key], via: "explicit" };
  for (const [re, b] of FALLBACKS) {
    if (re.test(key)) return { bucket: b, via: "fallback" };
  }
  return { bucket: "other", via: "default" };
}

const rollbackDir = "/Users/gergoorendi/.gbrain/migrations";
mkdirSync(rollbackDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const rollbackPath = `${rollbackDir}/industry-normalize-rollback-${ts}.jsonl`;
console.log(`[rollback] ${rollbackPath}`);

try {
  // Pull all company rows that currently have an industry value.
  const rows = await sql`
    SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash
    FROM pages
    WHERE type='company' AND frontmatter ? 'industry'
  `;
  console.log(`[found] ${rows.length} company rows with industry`);

  const bucketCounts: Record<string, number> = {};
  const viaCounts: Record<string, number> = { explicit: 0, fallback: 0, default: 0 };
  const defaultedValues: Map<string, number> = new Map();
  const fallbackValues: Map<string, string> = new Map();

  const updates: Array<{ id: number; fm: string; hash: string }> = [];

  for (const r of rows) {
    const original = String(r.frontmatter?.industry ?? "");
    if (!original) continue;
    const { bucket, via } = classify(original);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    viaCounts[via] = (viaCounts[via] ?? 0) + 1;
    if (via === "default") defaultedValues.set(original, (defaultedValues.get(original) ?? 0) + 1);
    if (via === "fallback") fallbackValues.set(original, bucket);

    // Skip rows where the bucket is already the canonical AND industry_original is already set.
    const alreadyCanonical = r.frontmatter?.industry_canonical === bucket && r.frontmatter?.industry_original === original;
    if (alreadyCanonical) continue;

    const newFm = {
      ...r.frontmatter,
      industry: bucket,
      industry_canonical: bucket,
      industry_original: r.frontmatter?.industry_original ?? original,
    };
    const newHash = contentHash({
      title: r.title,
      type: r.type,
      compiled_truth: r.compiled_truth ?? "",
      timeline: r.timeline ?? "",
      frontmatter: newFm,
    });

    appendFileSync(rollbackPath, JSON.stringify({
      id: r.id,
      slug: r.slug,
      previous_frontmatter: r.frontmatter,
      previous_content_hash: r.content_hash,
      new_bucket: bucket,
      via,
    }) + "\n");

    updates.push({ id: r.id, fm: JSON.stringify(newFm), hash: newHash });
  }

  console.log(`[classify] via explicit=${viaCounts.explicit} fallback=${viaCounts.fallback} default=${viaCounts.default}`);
  console.log(`[classify] bucket distribution:`);
  for (const b of BUCKETS) {
    const n = bucketCounts[b] ?? 0;
    if (n > 0) console.log(`  ${b.padEnd(28)} ${n}`);
  }

  if (defaultedValues.size > 0) {
    console.log(`[classify] ${defaultedValues.size} values fell through to 'other'. Top 20:`);
    const sorted = [...defaultedValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [v, n] of sorted) console.log(`  ${String(n).padStart(4)}  ${v}`);
  }

  console.log(`[updates] ${updates.length} rows to write`);
  if (updates.length === 0) {
    console.log("[done] nothing to write");
    process.exit(0);
  }

  // Bulk UPDATE via UNNEST, batched to 500 per call.
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    const ids = chunk.map(u => u.id);
    const fms = chunk.map(u => u.fm);
    const hashes = chunk.map(u => u.hash);
    const res = await sql`
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
    written += res.length;
    console.log(`[batch] ${i / BATCH + 1}: +${res.length} (total ${written}/${updates.length})`);
  }

  // Verify
  const dist = await sql`
    SELECT frontmatter->>'industry' AS bucket, COUNT(*)::int AS n
    FROM pages
    WHERE type='company' AND frontmatter ? 'industry'
    GROUP BY bucket ORDER BY n DESC
  `;
  console.log(`[verify] post-normalize industry distribution:`);
  for (const r of dist) console.log(`  ${String(r.bucket).padEnd(28)} ${r.n}`);
  console.log(`[verify] distinct bucket count: ${dist.length}`);
} finally {
  await sql.end();
}
