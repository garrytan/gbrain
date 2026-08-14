import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import { runFactsBackstop } from "./src/core/facts/backstop.ts";
import postgres from "postgres";
import { readFileSync } from "fs"; import { homedir } from "os";

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
const limit = parseInt(process.env.BACKFILL_LIMIT || "5", 10);
const rows = await sql`select slug from pages where deleted_at is null order by updated_at desc limit ${limit}`;
let ok=0, fail=0, facts=0;
for (const { slug } of rows) {
  try {
    const page: any = await engine.getPage(slug);
    if (!page) { continue; }
    const r: any = await runFactsBackstop(
      { slug, type: page.type, compiled_truth: page.compiled_truth, frontmatter: page.frontmatter },
      { engine, sourceId: page.source_id ?? "default", sessionId: null, source: "backfill", mode: "inline" } as any
    );
    if (typeof r.inserted === "number") facts += r.inserted;
    ok++;
  } catch (e) { fail++; console.error("FAIL", slug, String(e).slice(0,140)); }
}
console.log(`DONE pages=${ok} fail=${fail} facts_inserted=${facts}`);
await sql.end(); process.exit(0);
