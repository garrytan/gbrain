/*
 * corpus-synth/run.ts — corpus-level Wisdom synthesis (top-down, LLM-proposed themes).
 *
 * synthesis-sweep produces PER-ENTITY dossiers (unit = one person/company/concept).
 * corpus-synth produces CORPUS-LEVEL viewpoint pages (unit = a theme/thread that
 * cuts across many documents). It turns a freshly-imported systematic knowledge
 * base into queryable "观点与洞察" — not just facts (RAG) but the corpus's
 * arguments, tensions, transferable patterns, and open questions.
 *
 * Why top-down (not embedding clustering): a freshly-imported corpus is often
 * not embedded yet (the real bulk-ingest order is import→embed→…→corpus-synth,
 * and a manual import may skip embed entirely — gbrain-docs currently has
 * embedding=NULL). Top-down also tracks the knowledge's CONCEPTUAL structure,
 * not just vector proximity.
 *
 * Borrowed from gbrain's gated dream phases (which we can't use — they require an
 * `atom` layer / personal-reflections slugs / a VC-forecast prompt; see the fork
 * analysis): the `min_evidence` anti-hallucination gate (patterns.ts), tier-by-
 * evidence-count (synthesize-concepts.ts), and content_hash idempotency so a
 * re-run on an unchanged corpus never re-pays (propose_takes.ts).
 *
 * Pipeline:
 *   Phase A  build a CORPUS MAP (every doc: slug — title + snippet), send to Opus
 *            once → it proposes the major themes + cross-cutting tensions, each
 *            with member doc slugs. Validate members against the real slug set;
 *            drop themes below --min-evidence.
 *   Phase B  per theme (checkpointed, resumable, concurrent — same engine as
 *            synthesis-sweep): gather member docs up to a token budget, Opus
 *            synthesizes a corpus-level viewpoint page, write to synthesis/<slug>.
 *   Phase C  report (themes / failed / tokens).
 *
 * Usage:
 *   bun run skills/kos-jarvis/corpus-synth/run.ts --source gbrain-docs --plan   # build map, no LLM
 *   bun run skills/kos-jarvis/corpus-synth/run.ts --source gbrain-docs --limit 2  # small live
 *   bun run skills/kos-jarvis/corpus-synth/run.ts --source gbrain-docs            # full
 *
 * Exit: 0 clean | 1 fatal pre-flight / fatal LLM abort | 2 partial (some failed)
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB = process.env.GBRAIN_DATABASE_URL ?? "postgresql://chenyuanquan@127.0.0.1:5432/gbrain";
const MODEL = process.env.GBRAIN_SYNTHESIS_MODEL ?? "claude-opus-4-8";
// CRS proxy base carries `/v1` for gbrain's gateway; the official SDK appends
// `/v1/messages`, so strip a trailing `/v1` (cf. enrich-sweep NER / synthesis-sweep).
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, "") || undefined;
const WANT_1M = process.env.SYNTH_CONTEXT_1M === "1";
const BETA_1M = process.env.ANTHROPIC_BETA ?? "context-1m-2025-08-07";
const MAX_TOKENS = Number(process.env.SYNTH_MAX_TOKENS) || 64000;
// The corpus map fed to the theme-proposal call. Cap so a huge corpus can't
// blow the context; recency-desc keeps the most current docs when it overflows.
const MAP_TOKEN_CEILING = Number(process.env.CORPUS_MAP_CEILING) || 600_000;

const CACHE_DIR = join(homedir(), ".cache", "kos-jarvis", "corpus-synth");
const LOCK = join(homedir(), ".cache", "kos-jarvis", "corpus-synth.lock");
let lockFile = LOCK;

type Flags = {
  source?: string;
  limit?: number;
  minEvidence: number;
  maxThemes: number;
  mapCharCap: number; // per-doc snippet length in the corpus map
  charCap: number;    // per-doc body length in the per-theme synthesis
  tokenBudget: number;
  concurrency: number;
  dry: boolean;
  plan: boolean;
  resume: boolean;
  help: boolean;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    minEvidence: 3,
    maxThemes: 24,
    mapCharCap: 800,
    charCap: 4000,
    tokenBudget: WANT_1M ? 900_000 : 450_000,
    concurrency: 3,
    dry: false,
    plan: false,
    resume: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--source") f.source = next();
    else if (a === "--limit") f.limit = parseInt(next(), 10);
    else if (a === "--min-evidence") f.minEvidence = parseInt(next(), 10);
    else if (a === "--max-themes") f.maxThemes = parseInt(next(), 10);
    else if (a === "--map-char-cap") f.mapCharCap = parseInt(next(), 10);
    else if (a === "--char-cap") f.charCap = parseInt(next(), 10);
    else if (a === "--token-budget") f.tokenBudget = parseInt(next(), 10);
    else if (a === "--concurrency") f.concurrency = parseInt(next(), 10);
    else if (a === "--dry") f.dry = true;
    else if (a === "--plan") f.plan = true;
    else if (a === "--resume") f.resume = true;
    else if (a === "--help" || a === "-h") f.help = true;
  }
  return f;
}

const HELP = `corpus-synth — Opus corpus-level viewpoint/insight synthesis (Wisdom layer)

  --source <id>        Corpus to synthesize (REQUIRED — you synthesize one body)
  --limit N            Process only the first N themes (small-batch verify)
  --min-evidence N     Min distinct member docs per theme (default 3; anti-hallucination)
  --max-themes N       Cap themes proposed (default 24)
  --map-char-cap N     Per-doc snippet length in the corpus map (default 800)
  --char-cap N         Per-doc body length fed to per-theme synthesis (default 4000)
  --token-budget N     Gathered-context token budget per theme (default ${WANT_1M ? "900000 (1M)" : "450000"})
  --concurrency N      Themes synthesized in parallel (default 3)
  --plan / --dry       Build the corpus map + show its size; no LLM, no writes
  --resume             Skip themes already in the checkpoint (by member-set hash)
  -h, --help           This help

Env: ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL (CRS, /v1) required; SYNTH_CONTEXT_1M=1
for 1M context; GBRAIN_SYNTHESIS_MODEL overrides the model.`;

// ─────────────────────────── helpers (shared with synthesis-sweep) ──────────

function psql(sql: string): string {
  const r = spawnSync("psql", [DB, "-At", "-F", "\t", "-c", sql], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout;
}

// Records-safe psql: compiled_truth has newlines AND tabs → split on control
// chars (RS between rows, US between fields) that never appear in content.
function psqlRecords(sql: string): string[][] {
  const RS = "\x1e", US = "\x1f";
  const r = spawnSync("psql", [DB, "-At", "-R", RS, "-F", US, "-c", sql], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout.split(RS).filter((rec) => rec.length > 0).map((rec) => rec.split(US));
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.\-]/g, "_");
}
function checkpointPath(scope: string): string {
  return join(CACHE_DIR, `${sanitizeId(scope)}.jsonl`);
}
function loadDoneHashes(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).hash); } catch { /* skip */ }
  }
  return done;
}
function markDone(path: string, rec: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify(rec) + "\n");
}
function acquireLock(): void {
  if (existsSync(lockFile)) {
    console.error(`Another corpus-synth is running (lock: ${lockFile}). Remove it if stale.`);
    process.exit(1);
  }
  writeFileSync(lockFile, String(process.pid));
}
function releaseLock(): void { try { unlinkSync(lockFile); } catch { /* noop */ } }

function isFatalLLMError(msg: string): boolean {
  return /\b401\b|\b403\b|invalid x-api-key|api key not valid|unauthorized|permission denied|spend(ing)?\s*cap|insufficient|quota exceeded|credit/i.test(msg);
}

// Member-set content hash → idempotency key. Same theme membership ⇒ same hash
// ⇒ skip on resume (borrowed from propose_takes' content_hash cache).
function themeHash(members: string[]): string {
  return createHash("sha256").update([...members].sort().join("\n")).digest("hex").slice(0, 16);
}

// ─────────────────────────── Opus call (shared backoff w/ synthesis-sweep) ──

async function callOpus(
  client: Anthropic,
  system: string,
  content: string,
  label: string,
  minLen: number,
): Promise<{ text: string; in: number; out: number }> {
  const extra = WANT_1M ? { headers: { "anthropic-beta": BETA_1M } } : undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const stream = client.messages.stream(
        { model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content }] },
        { timeout: 600_000, ...(extra ?? {}) },
      );
      const resp = await stream.finalMessage();
      const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (text.trim().length < minLen) throw new Error(`short/empty response (${text.trim().length} chars)`);
      return { text, in: resp.usage?.input_tokens ?? 0, out: resp.usage?.output_tokens ?? 0 };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (isFatalLLMError(lastErr)) throw new Error(`FATAL: ${lastErr}`);
      const status = e?.status ?? e?.statusCode ?? 0;
      const poolExhausted = status === 500 || /no available|no .*account|accounts support/i.test(lastErr);
      const rateLimited = status === 429 || status === 503 || status === 524 || status === 529 || poolExhausted
        || /overloaded|rate.?limit|too many requests|timeout occurred|error 524/i.test(lastErr);
      const retryAfterS = Number(e?.headers?.["retry-after"]) || 0;
      const base = rateLimited
        ? Math.min(Math.max(retryAfterS * 1000, 30_000 * 2 ** (attempt - 1)), 300_000)
        : Math.min(5_000 * attempt, 60_000);
      const wait = Math.round(base * (0.8 + Math.random() * 0.4));
      console.error(`    ! ${label} attempt ${attempt}/8 ${poolExhausted ? "POOL-EXHAUSTED" : rateLimited ? "RATE-LIMIT" : "transient"} (${lastErr.slice(0, 90)}) — backoff ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`${label} failed after retries: ${lastErr.slice(0, 200)}`);
}

// ─────────────────────────── Phase A — corpus map + themes ──────────────────

type CorpusMap = { text: string; slugSet: Set<string>; included: number; total: number };

function buildCorpusMap(f: Flags): CorpusMap {
  // Exclude prior corpus-synth outputs so we never synthesize syntheses.
  const sql = `
    SELECT slug, coalesce(title, slug), left(compiled_truth, ${f.mapCharCap})
    FROM pages
    WHERE source_id = ${sqlStr(f.source!)} AND deleted_at IS NULL
      AND slug NOT LIKE 'synthesis/%'
      AND coalesce(frontmatter->>'synthesized_by','') <> 'corpus-synth'
      AND coalesce(compiled_truth,'') <> ''
    ORDER BY updated_at DESC`;
  const rows = psqlRecords(sql);
  const slugSet = new Set<string>();
  const ceilingChars = MAP_TOKEN_CEILING * 1.5; // CJK ~1.5 chars/token
  let used = 0;
  let included = 0;
  const parts: string[] = [];
  for (const [slug, title, body] of rows) {
    slugSet.add(slug);
    const snippet = (body ?? "").replace(/\s+/g, " ").trim();
    const block = `### ${slug} — ${title}\n${snippet}\n`;
    if (used + block.length > ceilingChars && included > 0) continue; // overflow: skip extras, slug still known
    parts.push(block);
    used += block.length;
    included++;
  }
  return { text: parts.join("\n"), slugSet, included, total: rows.length };
}

type Theme = { title: string; slug: string; angle: string; members: string[]; kind: "theme" | "tension"; hash: string };

const PROPOSE_SYSTEM = `你是知识库的语料级主题提纲引擎。你读完一个体系化知识库的全貌后,提炼出贯穿多篇文档的【主要主题/线索】和【跨文档的张力/争议/演进】,为后续逐主题深度综合搭骨架。`;

function buildProposePrompt(f: Flags, map: CorpusMap): string {
  return [
    `下面是一个体系化知识库的「语料地图」,每条是一篇文档:其 slug、标题、和正文摘要。`,
    ``,
    `请识别这个知识库的【主要主题/线索】(theme)和【跨文档的张力/争议/演进】(tension):`,
    `- 每个主题至少由 ${f.minEvidence} 篇不同文档支撑(members 列出这些文档的 slug)。`,
    `- 最多 ${f.maxThemes} 个主题。优先覆盖面广、跨多篇、能产出洞见的主题;避免只涉及单篇的碎题。`,
    `- members 必须用地图里**出现过的 slug 原文**,不要臆造 slug。`,
    `- kind="tension" 用于"材料之间存在分歧/冲突/随时间演进"的横切主题;否则 kind="theme"。`,
    ``,
    `严格输出 JSON 数组(无其它文字、无 markdown 代码围栏),每项:`,
    `{"title":"中文主题标题","slug":"kebab-ascii-slug","angle":"一句话:这个主题的核心问题/为何成立","members":["slugA","slugB",...],"kind":"theme"|"tension"}`,
    ``,
    `=== 语料地图(${map.included}/${map.total} 篇) ===`,
    map.text,
  ].join("\n");
}

// Robust JSON-array parse (handles fences / leading prose), borrowed shape from
// propose_takes.parseExtractorOutput.
function parseThemes(raw: string): Array<Omit<Theme, "hash">> {
  let text = (raw ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? "").trim();
  const start = text.indexOf("[");
  if (start === -1) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Array<Omit<Theme, "hash">> = [];
  for (const r of parsed) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    let slug = typeof o.slug === "string" ? o.slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
    const angle = typeof o.angle === "string" ? o.angle.trim() : "";
    const members = Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === "string") : [];
    const kind = o.kind === "tension" ? "tension" : "theme";
    if (!title || !slug || members.length === 0) continue;
    out.push({ title, slug, angle, members, kind });
  }
  return out;
}

// Validate proposed members against the real slug set; drop themes below
// --min-evidence after validation (the LLM may cite slugs not in the corpus).
function validateThemes(themes: Array<Omit<Theme, "hash">>, map: CorpusMap, f: Flags): Theme[] {
  const seen = new Set<string>();
  const out: Theme[] = [];
  for (const t of themes) {
    const members = [...new Set(t.members.filter((m) => map.slugSet.has(m)))];
    if (members.length < f.minEvidence) continue;
    let slug = t.slug || "theme";
    while (seen.has(slug)) slug = `${slug}-2`;
    seen.add(slug);
    out.push({ ...t, slug, members, hash: themeHash(members) });
  }
  return out.slice(0, f.maxThemes);
}

// ─────────────────────────── Phase B — per-theme synthesis ──────────────────

type Gathered = { text: string; included: number; total: number; dropped: number };

function gatherTheme(t: Theme, f: Flags): Gathered {
  const inList = t.members.map(sqlStr).join(",");
  const sql = `
    SELECT slug, left(compiled_truth, ${f.charCap})
    FROM pages
    WHERE source_id = ${sqlStr(f.source!)} AND slug IN (${inList}) AND deleted_at IS NULL
    ORDER BY updated_at DESC`;
  const rows = psqlRecords(sql);
  const budgetChars = f.tokenBudget * 1.5;
  let used = 0, included = 0;
  const parts: string[] = [];
  for (const [slug, body] of rows) {
    const block = `### ${slug}\n${body ?? ""}\n`;
    if (used + block.length > budgetChars && included > 0) break;
    parts.push(block);
    used += block.length;
    included++;
  }
  return { text: parts.join("\n"), included, total: rows.length, dropped: rows.length - included };
}

const SYNTH_SYSTEM = `你是知识库的语料级高层综合引擎。你把一个主题下的多篇源文档综合成一页「观点与洞察」,产出的不只是事实复述,而是跨文档才能得出的判断、张力、与可迁移的模式。`;

function buildSynthPrompt(t: Theme): string {
  return [
    `主题:「${t.title}」`,
    t.angle ? `角度:${t.angle}` : ``,
    `下面是该主题下的源文档(节选)。请综合成一页中文【观点与洞察】dossier,结构:`,
    `- **一句话定性**`,
    `- **核心论点与共识**(这组材料共同主张/确立了什么)`,
    `- **内部张力与矛盾**(材料之间的分歧、冲突、或随时间的演进)`,
    `- **可迁移的模式与方法**(能抽象出、可复用到别处的方法论/范式)`,
    `- **未决问题**`,
    `- **延伸洞见**(综合多篇才能得出、单篇看不到的判断——这是"观点"不是"事实",请标明为综合推断,可被后续证据修正)`,
    ``,
    `要求:每条尽量在句尾用 \`[[完整来源slug]]\` 标注证据——slug 必须照抄下方源材料里每段 \`### \` 后的**完整 slug 原文**(如 \`docs/takes-vs-facts\`,不要简写成 \`takes-vs-facts\`);明确区分"事实陈述"与"综合观点";不臆造,材料没有的不写;只输出 markdown 正文,不要前置说明。`,
  ].filter(Boolean).join("\n");
}

function renderThemePage(t: Theme, synthesis: string, g: Gathered, model: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const kind = t.kind === "tension" ? "comparison" : "synthesis";
  const fm = [
    "---",
    `kind: ${kind}`,
    `title: ${JSON.stringify(t.title)}`,
    `source_of_truth: brain-corpus-synth-opus`,
    `scope: corpus-level`,
    `confidence: medium`,
    `theme_kind: ${t.kind}`,
    `synthesized_from: ${g.included} docs (${g.total} member${g.dropped ? `, ${g.dropped} dropped over token budget` : ""})`,
    `members: [${t.members.map((m) => JSON.stringify(m)).join(", ")}]`,
    `synthesis_model: ${model}`,
    `synthesized_by: corpus-synth`,
    `synthesized_at: ${today}`,
    "---",
    "",
  ].join("\n");
  const footer = g.dropped > 0
    ? `\n\n> _Synthesis covered ${g.included} of ${g.total} member docs (token budget); ${g.dropped} not included._`
    : `\n\n> _Synthesis covered all ${g.total} member docs._`;
  return fm + synthesis.trim() + footer + "\n";
}

function writePage(slug: string, md: string, source: string): { ok: boolean; msg: string } {
  const r = spawnSync("gbrain", ["put", slug, "--content", md, "--source", source], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return { ok: true, msg: (r.stdout || "").trim().slice(0, 120) };
  return { ok: false, msg: `gbrain put failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}` };
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const f = parseFlags(process.argv.slice(2));
  if (f.help) { console.log(HELP); process.exit(0); }
  if (f.dry) f.plan = true;
  if (!f.source) { console.error("--source <id> is required (corpus-synth synthesizes one corpus)"); process.exit(1); }

  if (!process.env.ANTHROPIC_API_KEY && !f.plan) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
  try { psql("SELECT 1"); } catch (e: any) { console.error(`DB unreachable: ${e.message}`); process.exit(1); }
  mkdirSync(CACHE_DIR, { recursive: true });

  const ckptPath = checkpointPath(f.source);
  const doneHashes = f.resume || existsSync(ckptPath) ? loadDoneHashes(ckptPath) : new Set<string>();

  console.log(`[A] building corpus map (source=${f.source}) …`);
  const map = buildCorpusMap(f);
  const mapTok = Math.round(map.text.length / 1.5 / 1000);
  console.log(`    ${map.included}/${map.total} docs in map (~${mapTok}k tok)${map.included < map.total ? `  [${map.total - map.included} dropped over map ceiling]` : ""}`);

  if (map.included === 0) { console.error("    no documents in source — nothing to synthesize"); process.exit(1); }

  if (f.plan) {
    console.log(`\n[PLAN] corpus map ready: ${map.included} docs, ~${mapTok}k tok, ${map.slugSet.size} unique slugs.`);
    console.log(`       theme proposal needs the LLM (run without --plan). Map preview (first 12 docs):`);
    for (const block of map.text.split("\n\n").slice(0, 12)) {
      console.log(`  ${block.split("\n")[0].slice(0, 90)}`);
    }
    process.exit(0);
  }

  acquireLock();
  const client = new Anthropic({ baseURL: ANTHROPIC_BASE, maxRetries: 8 });
  const summary = { themes: 0, synthesized: 0, failed: 0, skipped: 0, in_tokens: 0, out_tokens: 0, dropped_docs: 0, aborted: false };

  try {
    console.log(`[A] proposing themes via ${MODEL} …`);
    let themes: Theme[] = [];
    try {
      const r = await callOpus(client, PROPOSE_SYSTEM, buildProposePrompt(f, map), "propose-themes", 50);
      summary.in_tokens += r.in; summary.out_tokens += r.out;
      themes = validateThemes(parseThemes(r.text), map, f);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error(`[A] theme proposal failed: ${msg}\n[ABORT]`);
      releaseLock();
      process.exit(1);
    }
    if (themes.length === 0) { console.error("[A] no themes survived validation (≥min-evidence, real slugs). Try --min-evidence 2."); releaseLock(); process.exit(2); }

    let targets = themes.filter((t) => !doneHashes.has(t.hash));
    summary.skipped = themes.length - targets.length;
    if (f.limit) targets = targets.slice(0, f.limit);
    summary.themes = themes.length;
    console.log(`    ${themes.length} themes proposed (${summary.skipped} already done, skipped) → ${targets.length} to synthesize`);
    for (const t of themes) console.log(`      ${t.kind === "tension" ? "⚡" : "·"} ${t.slug.padEnd(34)} ${t.members.length} docs  ${t.title}`);
    console.log("");

    const total = targets.length;
    let i = 0;
    const processTheme = async (t: Theme): Promise<void> => {
      const n = ++i;
      const g = gatherTheme(t, f);
      try {
        const s = await callOpus(client, SYNTH_SYSTEM, `${buildSynthPrompt(t)}\n\n=== 源材料 ===\n${g.text}`, t.slug, 150);
        const w = writePage(`synthesis/${t.slug}`, renderThemePage(t, s.text, g, MODEL), f.source!);
        if (!w.ok) { summary.failed++; console.log(`[B] ${n}/${total} ${t.slug.slice(0, 38).padEnd(38)} ✗ write: ${w.msg}`); return; }
        summary.synthesized++; summary.in_tokens += s.in; summary.out_tokens += s.out; summary.dropped_docs += g.dropped;
        markDone(ckptPath, { hash: t.hash, slug: `synthesis/${t.slug}`, title: t.title, kind: t.kind, members: t.members.length, in_tokens: s.in, out_tokens: s.out, docs: g.included });
        console.log(`[B] ${n}/${total} ${t.slug.slice(0, 38).padEnd(38)} ✓ ${s.in}→${s.out} tok (${g.included}/${g.total} docs${g.dropped ? `, drop ${g.dropped}` : ""})`);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.startsWith("FATAL")) {
          summary.aborted = true;
          console.error(`[B] ${n}/${total} ${t.slug} ✗ ${msg}\n[ABORT] fatal LLM error — fix key/billing, re-run (resumes from checkpoint).`);
          return;
        }
        summary.failed++;
        console.log(`[B] ${n}/${total} ${t.slug.slice(0, 38).padEnd(38)} ✗ ${msg.slice(0, 140)}`);
      }
    };

    const queue = [...targets];
    const nWorkers = Math.max(1, Math.min(f.concurrency, queue.length || 1));
    console.log(`    concurrency: ${nWorkers}\n`);
    const workers = Array.from({ length: nWorkers }, async () => {
      while (queue.length && !summary.aborted) await processTheme(queue.shift()!);
    });
    await Promise.all(workers);
  } finally {
    releaseLock();
  }

  console.log(`\n=== corpus-synth done (source=${f.source}) ===`);
  console.log(`  themes: ${summary.themes}  synthesized: ${summary.synthesized}  failed: ${summary.failed}  skipped: ${summary.skipped}  dropped-docs: ${summary.dropped_docs}`);
  console.log(`  tokens: ${summary.in_tokens} in / ${summary.out_tokens} out`);
  console.log(`  checkpoint: ${ckptPath}`);
  process.exit(summary.aborted ? 1 : summary.failed > 0 ? 2 : 0);
}

main().catch((e) => { releaseLock(); console.error(e); process.exit(1); });
