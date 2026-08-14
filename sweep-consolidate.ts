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

const buckets: any = await sql`
  SELECT source_id, entity_slug, COUNT(*)::int AS count
  FROM facts
  WHERE consolidated_at IS NULL AND expired_at IS NULL AND entity_slug IS NOT NULL
  GROUP BY source_id, entity_slug HAVING COUNT(*) >= 3`;

// Namespace-aware resolver: exact, else first-hyphen-to-slash (people-london -> people/london).
async function resolves(source_id: string, entity_slug: string): Promise<boolean> {
  const cands = [entity_slug];
  const m = entity_slug.match(/^([a-z]+)-(.+)$/);
  if (m) cands.push(`${m[1]}/${m[2]}`);
  const r: any = await sql`SELECT 1 FROM pages WHERE source_id=${source_id} AND slug = ANY(${cands}) AND deleted_at IS NULL LIMIT 1`;
  return r.length > 0;
}

function clusters(facts: any[], th: number): any[][] {
  const sorted = [...facts].sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime());
  const cl: any[][] = [];
  for (const f of sorted) {
    if (!f.embedding) { cl.push([f]); continue; }
    let placed = false;
    for (const c of cl) {
      const h = c[0];
      if (!h.embedding) continue;
      if (cosineSimilarity(f.embedding, h.embedding) >= th) { c.push(f); placed = true; break; }
    }
    if (!placed) cl.push([f]);
  }
  return cl;
}

const THS = [0.85, 0.80, 0.78, 0.75, 0.72, 0.70];
// Pre-load facts + resolution once per bucket.
const loaded: any[] = [];
let resolvedBuckets = 0, exactOnly = 0;
for (const b of buckets) {
  const facts: any = await engine.listFactsByEntity(b.source_id, b.entity_slug, { activeOnly: true, limit: 200 });
  const u = facts.filter((f: any) => f.consolidated_at == null);
  const res = await resolves(b.source_id, b.entity_slug);
  const exact: any = await sql`SELECT 1 FROM pages WHERE source_id=${b.source_id} AND slug=${b.entity_slug} AND deleted_at IS NULL LIMIT 1`;
  if (res) resolvedBuckets++;
  if (exact.length) exactOnly++;
  loaded.push({ slug: b.entity_slug, facts: u, resolves: res });
}
console.log(`BUCKETS=${buckets.length}  resolve(exact)=${exactOnly}  resolve(withSlugFix)=${resolvedBuckets}  recovered=${resolvedBuckets - exactOnly}`);
console.log("");
console.log("threshold | takes(clusters>=2, resolvable) | factsConsumed | singletonTakes(if size>=1)");
for (const th of THS) {
  let takes = 0, consumed = 0, singletonTakes = 0;
  for (const b of loaded) {
    const cl = clusters(b.facts, th);
    singletonTakes += b.resolves ? cl.length : 0; // every cluster, including size-1, if we dropped the >=2 gate
    if (!b.resolves) continue;
    for (const c of cl) { if (c.length >= 2) { takes++; consumed += c.length; } }
  }
  console.log(`  ${th.toFixed(2)}    |        ${String(takes).padStart(4)}                  |     ${String(consumed).padStart(4)}      |   ${singletonTakes}`);
}

await sql.end();
process.exit(0);
