/**
 * sub-dream.ts: ringfenced dream for a single sub-brain (source).
 *
 * The reusable template for per-business sub-brains (ZenSupply today; board
 * seats and investments next). Reads ONLY the named source's pages as evidence,
 * synthesizes cross-document insights through the OpenAI gateway, and writes
 * them back ringfenced to that same source. Two brains never cross.
 *   - read:  WHERE source_id = <source>     (never touches the personal/default brain)
 *   - write: putPage(..., { sourceId: <source> }) into <source>/insights/*
 *
 * Meetings: this reads ALL substantive pages in the source, so once meeting
 * pages are ingested into the source (see ingest-meetings.ts), they are dreamed
 * over automatically alongside the doc corpus. No code change needed here.
 *
 * Dry-run by default (review file to brain/agent-output/, no DB mutation).
 * Pass --write to persist the insight pages.
 *
 * Usage (from ~/gbrain so bun loads .env):
 *   bun sub-dream.ts --source zen-garden            # dry-run
 *   bun sub-dream.ts --source zen-garden --write    # persist
 */
import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { configureGateway, chat } from "./src/core/ai/gateway.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import { resolveDreamGatewayModel } from "./src/core/cycle/synthesize-gateway.ts";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

function argVal(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WRITE = process.argv.includes("--write");
const SOURCE = argVal("--source", "zen-garden");
const NS = `${SOURCE}/insights`;
const MAX_INSIGHTS = parseInt(argVal("--max", "8"), 10) || 8;
const TODAY = new Date().toISOString().slice(0, 10);
const REVIEW_PATH = `/Users/christianfriedland/mempalace/brain/agent-output/${TODAY}-${SOURCE}-dream.md`;

// Per-source descriptor sharpens the synthesis. Add one line per new sub-brain.
const DESCRIPTORS: Record<string, string> = {
  "zen-garden": "ZenSupply, an e-commerce distributor of commercial door hardware and electrical/building-materials supply.",
};
const SUBJECT = DESCRIPTORS[SOURCE] ?? `the business represented by the '${SOURCE}' brain (infer its nature from the corpus).`;

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

// 1) Read the ringfenced corpus (this source only): docs + any ingested meetings.
const rows = await engine.executeRaw<{ slug: string; type: string; title: string | null; compiled_truth: string | null }>(
  `SELECT slug, type, title, compiled_truth
     FROM pages
    WHERE source_id = $1
      AND deleted_at IS NULL
      AND slug NOT LIKE $2
      AND COALESCE(length(compiled_truth), 0) > 400
    ORDER BY slug`,
  [SOURCE, `${NS}/%`],
);
console.log(`[sub-dream:${SOURCE}] corpus: ${rows.length} substantive pages (mode: ${WRITE ? "WRITE" : "dry-run"})`);
if (rows.length === 0) {
  console.error(`[sub-dream:${SOURCE}] no substantive pages found for this source. Is it synced? Aborting.`);
  process.exit(1);
}

const corpus = rows
  .map((r, i) => `### ${i + 1}. [[${r.slug}]] : ${r.title ?? r.slug} (type: ${r.type})\n${(r.compiled_truth ?? "").slice(0, 2200)}`)
  .join("\n\n---\n\n");

// 2) Synthesis prompt.
const SYSTEM = `You are the dreaming layer of a company brain. The company is ${SUBJECT}

You are given the company's own knowledge corpus (doctrine, market/category intelligence, vendor or partner models, buyer/channel profiles, operating playbooks, metrics, decision memos, and any recent meeting notes).

Your job is to DREAM over this corpus the way a sharp operator would after reading everything in one sitting: surface the non-obvious, cross-document insights the corpus IMPLIES but never states in one place. Good dream insights are:
- Tensions or contradictions between two doctrines, playbooks, or recent decisions.
- Second-order implications of a stated principle (if X is true, then we should also...).
- Connections across documents that nobody wrote down together.
- Strategic risks or opportunities that only appear when several documents are read together.
- A leverage point: a small change implied by the corpus that would move margin, retention, or speed.

Each insight must be grounded in AT LEAST TWO distinct source pages (cite their slugs). Do NOT summarize a single document. Do NOT produce generic business advice unmoored from this corpus. Be specific to this company's actual doctrine and data.`;

const USER = `Below is the corpus (${rows.length} pages). Dream over it and return UP TO ${MAX_INSIGHTS} of the strongest cross-document insights.

Return ONLY a strict JSON array, no prose around it. Each element:
{
  "slug_suffix": "<short-kebab-case-id>",
  "title": "<one-line insight title>",
  "body": "<1-3 short paragraphs of markdown: the insight, why it follows from the corpus, and the leverage/action it implies>",
  "evidence": ["<page-slug>", "<page-slug>", ...]
}

CORPUS:
${corpus}`;

const model = resolveDreamGatewayModel();
if (!model) {
  console.error(`[sub-dream:${SOURCE}] no gateway chat model resolved (need OPENAI_API_KEY or GBRAIN_DREAM_MODEL). Aborting.`);
  process.exit(1);
}
console.log(`[sub-dream:${SOURCE}] synthesizing via ${model} ...`);

const res = await chat({
  model,
  system: SYSTEM,
  maxTokens: 8000,
  messages: [{ role: "user", content: USER }],
});

// 3) Parse.
interface Insight { slug_suffix: string; title: string; body: string; evidence: string[] }
let insights: Insight[] = [];
const matchArr = /\[[\s\S]*\]/.exec(res.text);
try {
  insights = JSON.parse(matchArr ? matchArr[0] : res.text) as Insight[];
} catch (e) {
  console.error(`[sub-dream:${SOURCE}] could not parse model output as JSON. Raw head:\n`, res.text.slice(0, 1200));
  process.exit(1);
}
insights = insights.filter(i => i && i.title && i.body).slice(0, MAX_INSIGHTS);
console.log(`[sub-dream:${SOURCE}] ${insights.length} insight(s) generated (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens).`);

const safeSuffix = (s: string) => (s || "insight").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// 4) Review file (always written).
const reviewMd = `---
date: ${TODAY}
created_by: sub-dream.ts
source_brain: ${SOURCE}
model: ${model}
mode: ${WRITE ? "write" : "dry-run"}
---

# ${SOURCE} dream (${TODAY})

Ringfenced over the \`${SOURCE}\` source only (${rows.length} substantive pages). Personal brain untouched. ${WRITE ? `Insight pages persisted to source_id=${SOURCE} under \`${NS}/\`.` : "Dry-run: no DB writes. Re-run with --write to persist."}

${insights.map((i, n) => `## ${n + 1}. ${i.title}

${i.body}

**Evidence:** ${(i.evidence ?? []).map(s => `[[${s}]]`).join(", ") || "(none cited)"}
**Slug:** \`${NS}/${safeSuffix(i.slug_suffix)}\` (source_id=${SOURCE}, type=pattern)
`).join("\n---\n\n")}
`;
mkdirSync(dirname(REVIEW_PATH), { recursive: true });
writeFileSync(REVIEW_PATH, reviewMd, "utf8");
console.log(`[sub-dream:${SOURCE}] review file: ${REVIEW_PATH}`);

// 5) Persist (only with --write).
if (WRITE) {
  let written = 0;
  for (const i of insights) {
    const slug = `${NS}/${safeSuffix(i.slug_suffix)}`;
    await engine.putPage(
      slug,
      {
        type: "pattern",
        title: i.title,
        compiled_truth: i.body,
        frontmatter: {
          dream_generated: true,
          dream_cycle_date: TODAY,
          source_brain: SOURCE,
          evidence: i.evidence ?? [],
        },
      },
      { sourceId: SOURCE },
    );
    written++;
    console.log(`[sub-dream:${SOURCE}] wrote ${slug}`);
  }
  console.log(`[sub-dream:${SOURCE}] persisted ${written} insight page(s). Run 'gbrain embed' to make them searchable.`);
} else {
  console.log(`[sub-dream:${SOURCE}] dry-run complete. Review the file above; re-run with --write to persist.`);
}

process.exit(0);
