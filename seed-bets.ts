import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";

const config = loadConfig()!;
configureGateway({
  embedding_model: (config as any).embedding_model,
  embedding_dimensions: (config as any).embedding_dimensions,
  expansion_model: (config as any).expansion_model,
  chat_model: (config as any).chat_model,
  base_urls: (config as any).provider_base_urls ?? {},
  env: { ...process.env },
} as any);
const engine: any = await createEngine(toEngineConfig(config));
await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

async function pageId(slug: string): Promise<number | null> {
  const r = await engine.executeRaw(`SELECT id FROM pages WHERE slug=$1 AND deleted_at IS NULL LIMIT 1`, [slug]);
  return r[0]?.id ?? null;
}
async function nextRow(pid: number): Promise<number> {
  const r = await engine.executeRaw(`SELECT COALESCE(MAX(row_num),0)::int m FROM takes WHERE page_id=$1`, [pid]);
  return (r[0]?.m ?? 0) + 1;
}
async function addBet(slug: string, claim: string, holder: string, weight: number, since: string): Promise<{ pid: number; row: number } | null> {
  const pid = await pageId(slug);
  if (pid == null) { console.log(`  (skip: page ${slug} not found)`); return null; }
  const row = await nextRow(pid);
  await engine.addTakesBatch([{ page_id: pid, row_num: row, claim, kind: "bet", holder, weight, since_date: since, active: true }]);
  return { pid, row };
}

// 1. Quality check: 3 synthesized fact-takes.
console.log("=== sample synthesized takes (contexts/zensupply) ===");
const zs = await engine.listTakes({ page_slug: "contexts/zensupply", kind: "fact", active: true, limit: 4 });
for (const t of zs) console.log(`  [w=${Number(t.weight).toFixed(2)}] ${t.claim}`);

// 2. Demo book (holder=demo): prove the scorecard math end to end.
console.log("\n=== demo book: log 3 bets, resolve 2 correct + 1 incorrect ===");
const d1 = await addBet("readme", "DEMO: ZenSupply gross margin improves QoQ in Q1 2026", "demo", 0.70, "2026-01");
const d2 = await addBet("readme", "DEMO: a flagged vendor PO ships inside its promised window", "demo", 0.60, "2026-02");
const d3 = await addBet("readme", "DEMO: watchlist position doubles within six months", "demo", 0.80, "2026-01");
if (d1) await engine.resolveTake(d1.pid, d1.row, { quality: "correct", resolvedBy: "self", source: "demo" });
if (d2) await engine.resolveTake(d2.pid, d2.row, { quality: "correct", resolvedBy: "self", source: "demo" });
if (d3) await engine.resolveTake(d3.pid, d3.row, { quality: "incorrect", resolvedBy: "self", source: "demo" });
const demoCard = await engine.getScorecard({ holder: "demo" }, undefined);
console.log("  scorecard(demo):", JSON.stringify(demoCard));

// 3. Real forward bets (holder=self), unresolved. Confidences are placeholders to confirm.
console.log("\n=== real forward bets (holder=self, unresolved) ===");
await addBet("contexts/ecom-cfo", "June 2026 ZenSupply monthly close is delivered on time and is trustworthy (cash reconciled, close clean) per the eComCFO remediation.", "self", 0.60, "2026-06");
await addBet("contexts/zensupply", "ZenSupply's modeled 12-week cash low stays at or above ~$500k, absorbing the Alarm Lock Amazon deficit (per Russell's 2026-06-22 review).", "self", 0.65, "2026-06");
const open = await engine.listTakes({ kind: "bet", holder: "self", active: true, limit: 50 });
console.log(`  open self bets: ${open.length}`);
for (const t of open) console.log(`   - [w=${Number(t.weight).toFixed(2)}] ${t.claim.slice(0, 90)}...`);
const selfCard = await engine.getScorecard({ holder: "self" }, undefined);
console.log("  scorecard(self):", JSON.stringify(selfCard));

process.exit(0);
