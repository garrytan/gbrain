import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import { runPhaseConsolidate } from "./src/core/cycle/phases/consolidate.ts";
import postgres from "postgres"; import { readFileSync } from "fs"; import { homedir } from "os";

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

const j = JSON.parse(readFileSync(`${homedir()}/.gbrain/config.json`,"utf8"));
const sql = postgres(j.database_url, { ssl: "require" });
const emb = await sql`select count(*)::int c, count(embedding)::int e from facts`;
console.log("FACTS:", emb[0].c, "EMBEDDED:", emb[0].e);
if (emb[0].e < emb[0].c) {
  console.log("Embedding stale facts first via engine.embed not available here; consolidate clusters need embeddings.");
}
const r: any = await runPhaseConsolidate(engine, { minOldestAgeMs: 0 });
console.log("CONSOLIDATE:", JSON.stringify(r.details ?? r.summary ?? r));
const tk = await sql`select count(*)::int c from takes`;
console.log("TAKES_NOW:", tk[0].c);
await sql.end(); process.exit(0);
