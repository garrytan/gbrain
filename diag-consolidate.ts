import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import { cosineSimilarity } from "./src/core/facts/classify.ts";
import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

const config = loadConfig()!;
configureGateway({
  embedding_model: (config as any).embedding_model,
  embedding_dimensions: (config as any).embedding_dimensions,
  expansion_model: (config as any).expansion_model,
  chat_model: (config as any).chat_model,
  base_urls: (config as any).provider_base_urls ?? {},
  env: { ...process.env },
} as any);
const engine = await createEngine(toEngineConfig(config));
await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

const j = JSON.parse(readFileSync(`${homedir()}/.gbrain/config.json`, "utf8"));
const sql = postgres(j.database_url, { ssl: "require" });

// 1. Buckets exactly as consolidate.ts computes them.
const buckets: any = await sql`
  SELECT source_id, entity_slug, COUNT(*)::int AS count
  FROM facts
  WHERE consolidated_at IS NULL AND expired_at IS NULL AND entity_slug IS NOT NULL
  GROUP BY source_id, entity_slug
  HAVING COUNT(*) >= 3
  ORDER BY count DESC`;
console.log("BUCKETS(>=3):", buckets.length);

// 2. Page resolution: exact match like consolidate.ts does.
let resolves = 0, missing = 0;
const sample: any[] = [];
for (const b of buckets) {
  const p: any = await sql`SELECT slug FROM pages WHERE source_id=${b.source_id} AND slug=${b.entity_slug} AND deleted_at IS NULL LIMIT 1`;
  const ok = p.length > 0;
  ok ? resolves++ : missing++;
  if (sample.length < 14) {
    let near = "";
    if (!ok) {
      const n: any = await sql`SELECT slug FROM pages WHERE slug LIKE ${'%' + b.entity_slug + '%'} AND deleted_at IS NULL LIMIT 1`;
      near = n.length ? n[0].slug : "(no LIKE match)";
    }
    sample.push({ entity_slug: b.entity_slug, n: b.count, resolves: ok, near_page: ok ? "n/a" : near });
  }
}
console.log("PAGE_RESOLVES:", resolves, "MISSING:", missing);
console.table(sample);

// 3. Cluster-size distribution at several thresholds for the top buckets.
function clusterSizes(facts: any[], th: number): number[] {
  const sorted = [...facts].sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime());
  const clusters: any[][] = [];
  for (const f of sorted) {
    if (!f.embedding) { clusters.push([f]); continue; }
    let placed = false;
    for (const c of clusters) {
      const h = c[0];
      if (!h.embedding) continue;
      if (cosineSimilarity(f.embedding, h.embedding) >= th) { c.push(f); placed = true; break; }
    }
    if (!placed) clusters.push([f]);
  }
  return clusters.map(c => c.length).sort((a, b) => b - a);
}

for (const b of buckets.slice(0, 6)) {
  const facts: any = await engine.listFactsByEntity(b.source_id, b.entity_slug, { activeOnly: true, limit: 100 });
  const u = facts.filter((f: any) => f.consolidated_at == null);
  const emb = u.filter((f: any) => f.embedding).length;
  const s85 = clusterSizes(u, 0.85);
  const s80 = clusterSizes(u, 0.80);
  const s75 = clusterSizes(u, 0.75);
  console.log(`\n[${b.entity_slug}] facts=${u.length} embedded=${emb}`);
  console.log(`  @0.85 maxCluster=${s85[0]} top=[${s85.slice(0, 6).join(",")}]`);
  console.log(`  @0.80 maxCluster=${s80[0]} top=[${s80.slice(0, 6).join(",")}]`);
  console.log(`  @0.75 maxCluster=${s75[0]} top=[${s75.slice(0, 6).join(",")}]`);
}

await sql.end();
process.exit(0);
