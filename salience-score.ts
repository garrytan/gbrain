// salience-score.ts : content-based emotional/salience scorer for gbrain.
//
// The deterministic `recompute_emotional_weight` phase scores emotional_weight
// from tags + takes only, so reflections (which have neither) come back 0.0 and
// get_recent_salience ranks everything flat. This reads each recent page's actual
// text and scores its charge 0..1 via the AI gateway (OpenAI), then writes
// pages.emotional_weight through the same setEmotionalWeightBatch the cycle uses.
// get_recent_salience reads that column (emotional_weight * 5 is its top term).
//
// Enumerates candidates directly from postgres (getRecentSalience is a top-N
// ranker capped at 100 and skewed to take-heavy pages, wrong for a full backfill).
//
// Usage:
//   bun run salience-score.ts                       # score recent pages, write
//   bun run salience-score.ts --days 60 --limit 300
//   bun run salience-score.ts --dry-run --limit 15  # score + print, write nothing
import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway, chat } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
// --force: re-score pages that already carry a nonzero emotional_weight.
// Default skips them: the dream cycle re-serializes old pages nightly (bumping
// updated_at), which otherwise refills the candidate pool with already-scored
// pages and turns this into a 300-call marathon every night (2026-08-03 fix).
const FORCE = args.includes("--force");
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(arg("--days") ?? 60);
const limit = Number(arg("--limit") ?? 300);

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

// Inlined 2026-08-07. This used to call resolveDreamGatewayModel() from
// cycle/synthesize-gateway.ts, a fork-only file removed when the repo moved to
// upstream v0.42 (upstream ships a real claude-cli provider, so the parallel
// gateway synthesis path is gone). The resolution was only ever env lookups,
// and .env pins GBRAIN_SALIENCE_MODEL, so this fallback is belt-and-braces.
const resolveDreamModel = (): string =>
  process.env.GBRAIN_DREAM_MODEL?.trim()
  || (process.env.OPENAI_API_KEY ? "openai:gpt-5.2" : "")
  || (process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "google:gemini-2.5-pro" : "");

const model = process.env.GBRAIN_SALIENCE_MODEL?.trim()
  || (process.env.OPENAI_API_KEY ? "openai:gpt-4o-mini" : resolveDreamModel());
if (!model) { console.error("no gateway model (set OPENAI_API_KEY or GBRAIN_DREAM_MODEL)"); process.exit(1); }
console.log(`salience-score: model=${model} days=${days} limit=${limit} dry=${DRY}`);

const SCORE_TYPES = ["reflection", "pattern", "original", "daily", "meeting-summary", "note", "conversation"];

const SYSTEM = `You score how SALIENT and emotionally charged a page in a personal second brain is, so the system can rank what to resurface to its owner. Reply with ONLY a JSON object: {"score": <number between 0 and 1>}.
1.0 = identity-defining, high-stakes, emotionally weighty: a hard decision, a strong conviction, money/conflict/health/family/reputation on the line.
0.5 = a real but ordinary work item, idea, or update.
0.0 = routine, administrative, logistical, low-stakes.
Judge the substance and charge of the CONTENT, not its length. Use the full range; do not default to 0.5.`;

const j = JSON.parse(readFileSync(`${homedir()}/.gbrain/config.json`, "utf8"));
const sql = postgres(j.database_url, { ssl: "require" });

const cands = await sql<Array<{ slug: string; source_id: string; type: string; title: string; compiled_truth: string }>>`
  select slug, source_id, type, title, compiled_truth
  from pages
  where deleted_at is null
    and type = any(${SCORE_TYPES}::text[])
    and updated_at >= now() - make_interval(days => ${days})
    ${FORCE ? sql`` : sql`and (emotional_weight is null or emotional_weight = 0)`}
  order by updated_at desc
  limit ${limit}`;
console.log(`scorable candidates=${cands.length}${FORCE ? " (force: rescoring already-scored)" : " (skip-scored; --force to rescore)"}`);

const rows: Array<{ slug: string; source_id: string; weight: number }> = [];
let i = 0;
const hist: Record<string, number> = {};
for (const c of cands) {
  let score = 0;
  try {
    const body = String(c.compiled_truth || c.title || "").slice(0, 6000);
    if (body.trim()) {
      const res = await chat({
        model,
        system: SYSTEM,
        maxTokens: 40,
        messages: [{ role: "user", content: `Title: ${c.title}\nType: ${c.type}\n\n${body}` }],
      } as any);
      const m = /\{[\s\S]*?\}/.exec((res as any)?.text || "");
      if (m) { const v = Number(JSON.parse(m[0]).score); if (Number.isFinite(v)) score = Math.max(0, Math.min(1, v)); }
    }
  } catch (e) { console.error(`ERR ${c.slug}: ${(e as Error).message}`); }
  rows.push({ slug: c.slug, source_id: c.source_id, weight: score });
  const bucket = score.toFixed(1); hist[bucket] = (hist[bucket] || 0) + 1;
  i++;
  if (DRY || i <= 12) console.log(`${score.toFixed(2)}  ${String(c.type).padEnd(15)}  ${c.slug}`);
}

console.log("score histogram:", JSON.stringify(hist));
if (!DRY && rows.length) {
  const n = await engine.setEmotionalWeightBatch(rows as any);
  console.log(`WROTE ${n} emotional_weight rows (of ${rows.length} scored)`);
} else {
  console.log(`DRY-RUN: scored ${rows.length}, wrote 0`);
}
await sql.end();
process.exit(0);
