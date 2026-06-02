/*
 * synthesis-sweep/run.ts — the "Wisdom layer" sibling of enrich-sweep.
 *
 * enrich-sweep built the entity stubs (Info). extract links/timeline built the
 * graph (Knowledge). This sweep walks each significant entity, gathers EVERY
 * source page that mentions it (via the by-mention `links` graph), feeds the
 * whole cluster into Opus 4.8 in one shot (large context), and writes back a
 * deep, evidence-cited high-level dossier — the synthesis/Wisdom layer.
 *
 * Design (validated by the 2026-06-02 echo-liu POC: 44 sources / 96k in →
 * a cited role+relationships+decision-timeline+insight dossier):
 *   Phase A  select entities (type person/company/concept/project) with
 *            >= --min-neighbors email/source neighbors, per source.
 *   Phase B  per entity (checkpointed, resumable): gather neighbor pages
 *            (recency-desc) up to a TOKEN BUDGET (hubs like notion=2161
 *            neighbors would exceed 1M — we cap and LOG the drop), synthesize
 *            via Opus, write the dossier back to the entity slug.
 *   Phase C  report (synthesized / failed / dropped-source counts + tokens).
 *
 * Writes are real-time (one `gbrain put` per entity → daemon embeds via
 * te3@avman) and resumable (per-entity JSONL checkpoint), so a crash never
 * wastes completed work. Run under nohup for the full sweep.
 *
 * Usage:
 *   bun run skills/kos-jarvis/synthesis-sweep/run.ts --plan --limit 3        # preview targets, no LLM
 *   bun run skills/kos-jarvis/synthesis-sweep/run.ts --limit 5               # small-batch live
 *   bun run skills/kos-jarvis/synthesis-sweep/run.ts --source mailagent-emails   # full source
 *
 * Exit: 0 clean | 1 fatal pre-flight / fatal LLM abort | 2 partial (some failed)
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB = process.env.GBRAIN_DATABASE_URL ?? "postgresql://chenyuanquan@127.0.0.1:5432/gbrain";
const MODEL = process.env.GBRAIN_SYNTHESIS_MODEL ?? "claude-opus-4-8";
// CRS proxy base carries `/v1` for gbrain's gateway; the official SDK appends
// `/v1/messages`, so strip a trailing `/v1` (cf. enrich-sweep NER fix).
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, "") || undefined;
// Optional 1M-context beta. Opus serves ~200k natively; for mega-hubs set
// SYNTH_CONTEXT_1M=1 to raise the budget + send the 1M beta header.
const WANT_1M = process.env.SYNTH_CONTEXT_1M === "1";
const BETA_1M = process.env.ANTHROPIC_BETA ?? "context-1m-2025-08-07";
// Output cap — set to the model max so dossiers are never truncated. >~21k
// requires streaming (API rule), so synthesize() streams. Override via env.
const MAX_TOKENS = Number(process.env.SYNTH_MAX_TOKENS) || 64000;

const ENTITY_TYPES = ["person", "company", "concept", "project", "entity"] as const;
const NEIGHBOR_TYPES = ["email", "source"] as const;

const CACHE_DIR = join(homedir(), ".cache", "kos-jarvis", "synthesis-sweep");
const LOCK = join(homedir(), ".cache", "kos-jarvis", "synthesis-sweep.lock");

type Flags = {
  source?: string;
  limit?: number;
  minNeighbors: number;
  kind?: string;
  charCap: number;
  tokenBudget: number; // budget in tokens (×1.5 → chars; CJK-measured)
  concurrency: number;
  dry: boolean;
  plan: boolean;
  resume: boolean;
  help: boolean;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    minNeighbors: 3,
    charCap: 4000,
    tokenBudget: WANT_1M ? 900_000 : 450_000,
    concurrency: 4,
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
    else if (a === "--min-neighbors") f.minNeighbors = parseInt(next(), 10);
    else if (a === "--kind") f.kind = next();
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

const HELP = `synthesis-sweep — Opus per-entity dossier synthesis (Wisdom layer)

  --source <id>        Restrict to one source (default: all non-doc sources)
  --limit N            Process only the first N entities (small-batch verify)
  --min-neighbors N    Only entities with >= N email/source neighbors (default 3)
  --kind K             Restrict to one entity type (person|company|concept|project)
  --char-cap N         Per-source-page char cap fed to the model (default 4000)
  --token-budget N     Total gathered-context token budget per entity
                       (default ${WANT_1M ? "900000 (SYNTH_CONTEXT_1M)" : "450000"} tok; hubs cap + log dropped)
  --concurrency N      Entities synthesized in parallel (default 4)
  --plan               Select + preview targets, no LLM, no writes
  --dry                Alias of --plan
  --resume             Skip entities already in the checkpoint
  -h, --help           This help

Env: ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL (CRS, /v1) required; SYNTH_CONTEXT_1M=1
for 1M context on mega-hubs; GBRAIN_SYNTHESIS_MODEL overrides the model.`;

// ─────────────────────────── helpers ───────────────────────────

function psql(sql: string): string {
  const r = spawnSync("psql", [DB, "-At", "-F", "\t", "-c", sql], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout;
}

// Records-safe psql: compiled_truth contains newlines AND tabs, so split on
// control chars (RS=\x1e between rows, US=\x1f between fields) that never
// appear in the content. Returns rows of fields.
function psqlRecords(sql: string): string[][] {
  const RS = "\x1e", US = "\x1f";
  const r = spawnSync("psql", [DB, "-At", "-R", RS, "-F", US, "-c", sql], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout.split(RS).filter((rec) => rec.length > 0).map((rec) => rec.split(US));
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.\-]/g, "_");
}

function checkpointPath(scope: string): string {
  return join(CACHE_DIR, `${sanitizeId(scope)}.jsonl`);
}

function loadDone(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).slug); } catch { /* skip */ }
  }
  return done;
}

function markDone(path: string, rec: { slug: string; in_tokens: number; out_tokens: number; sources: number; dropped: number }): void {
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

function acquireLock(): void {
  if (existsSync(LOCK)) {
    console.error(`Another synthesis-sweep is running (lock: ${LOCK}). Remove it if stale.`);
    process.exit(1);
  }
  writeFileSync(LOCK, String(process.pid));
}
function releaseLock(): void { try { unlinkSync(LOCK); } catch { /* noop */ } }

// fatal LLM errors that would hit every subsequent call → abort the whole run
function isFatalLLMError(msg: string): boolean {
  return /\b401\b|\b403\b|invalid x-api-key|api key not valid|unauthorized|permission denied|spend(ing)?\s*cap|insufficient|quota exceeded|credit/i.test(msg);
}

// ─────────────────────────── phases ───────────────────────────

type Target = { id: number; slug: string; type: string; source_id: string; neighbors: number };

function selectTargets(f: Flags): Target[] {
  const srcFilter = f.source ? `AND e.source_id = '${f.source.replace(/'/g, "''")}'` : `AND e.source_id <> 'gbrain-docs'`;
  const kindFilter = f.kind ? `AND e.type = '${f.kind.replace(/'/g, "''")}'` : `AND e.type = ANY(ARRAY[${ENTITY_TYPES.map((t) => `'${t}'`).join(",")}])`;
  const nbFilter = `ARRAY[${NEIGHBOR_TYPES.map((t) => `'${t}'`).join(",")}]`;
  const limit = f.limit ? `LIMIT ${f.limit}` : "";
  const sql = `
    SELECT e.id, e.slug, e.type, e.source_id, count(DISTINCT nb.id) AS n
    FROM pages e
    JOIN links l ON (l.to_page_id = e.id OR l.from_page_id = e.id)
    JOIN pages nb ON nb.id = (CASE WHEN l.from_page_id = e.id THEN l.to_page_id ELSE l.from_page_id END)
    WHERE e.deleted_at IS NULL ${srcFilter} ${kindFilter}
      AND nb.type = ANY(${nbFilter}) AND nb.deleted_at IS NULL
    GROUP BY e.id, e.slug, e.type, e.source_id
    HAVING count(DISTINCT nb.id) >= ${f.minNeighbors}
    ORDER BY n DESC ${limit}`;
  return psqlRecords(sql).map(([id, slug, type, source_id, n]) => ({
    id: parseInt(id, 10), slug, type, source_id, neighbors: parseInt(n, 10),
  }));
}

type Gathered = { text: string; included: number; total: number; dropped: number };

function gatherSources(t: Target, f: Flags): Gathered {
  // recency-desc so the budget keeps the most current context; the by-mention
  // graph is symmetric so the neighbor is whichever end isn't the entity.
  const sql = `
    SELECT nb.slug, left(nb.compiled_truth, ${f.charCap})
    FROM links l
    JOIN pages nb ON nb.id = (CASE WHEN l.from_page_id = ${t.id} THEN l.to_page_id ELSE l.from_page_id END)
    WHERE (l.from_page_id = ${t.id} OR l.to_page_id = ${t.id})
      AND nb.type = ANY(ARRAY[${NEIGHBOR_TYPES.map((x) => `'${x}'`).join(",")}]) AND nb.deleted_at IS NULL
    GROUP BY nb.slug, nb.compiled_truth, nb.updated_at
    ORDER BY nb.updated_at DESC`;
  const rows = psqlRecords(sql);
  const budgetChars = f.tokenBudget * 1.5; // CJK ~1.5 chars/token (measured)
  let used = 0;
  let included = 0;
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

function buildPrompt(t: Target): string {
  return [
    `你是知识库的高层综合引擎。下面是知识库里所有提及实体「${t.slug}」的源邮件/页面(按时间倒序)。`,
    `请综合成一页精准、完全由证据支撑的中文高层 dossier。结构:`,
    `- **一句话定性**`,
    `- **关键事实**`,
    `- **角色与关系**(人/组织,及其与该实体的关系)`,
    `- **关键决策与时间线**(带日期)`,
    `- **未决问题**`,
    `- **可挖掘的洞见**(综合多条源才能得出、单条看不到的判断)`,
    `要求:每条尽量在句尾用 \`[来源slug]\` 标注证据;不要臆造,材料没有的不写;只输出 markdown 正文,不要前置说明。`,
  ].join("\n");
}

function renderPage(t: Target, synthesis: string, g: Gathered, model: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const fm = [
    "---",
    `kind: synthesis`,
    `source_of_truth: brain-synthesis-opus`,
    `confidence: medium`,
    `synthesized_from: ${g.included} sources (${g.total} total${g.dropped ? `, ${g.dropped} dropped over token budget` : ""})`,
    `synthesis_model: ${model}`,
    `synthesized_at: ${today}`,
    "---",
    "",
  ].join("\n");
  const footer = g.dropped > 0
    ? `\n\n> _Synthesis covered the ${g.included} most-recent of ${g.total} mentioning sources (token budget); ${g.dropped} older sources not included._`
    : `\n\n> _Synthesis covered all ${g.total} mentioning sources._`;
  return fm + synthesis.trim() + footer + "\n";
}

async function synthesize(client: Anthropic, t: Target, g: Gathered): Promise<{ text: string; in: number; out: number }> {
  const content = `${buildPrompt(t)}\n\n=== 源材料 ===\n${g.text}`;
  const extra = WANT_1M ? { headers: { "anthropic-beta": BETA_1M } } : undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      // Stream (required for the high MAX_TOKENS cap) and await the accumulated
      // final message. Long dossiers stream over minutes without tripping the
      // non-streaming timeout/length ceiling.
      const stream = client.messages.stream(
        { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] },
        { timeout: 600_000, ...(extra ?? {}) },
      );
      const resp = await stream.finalMessage();
      const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      // Guard: a degraded retry (e.g. after a CF 524) can return a near-empty
      // body that still 200s. Don't checkpoint garbage — treat short output as
      // a retryable failure so the entity is re-synthesized, not silently lost.
      if (text.trim().length < 400) throw new Error(`short/empty response (${text.trim().length} chars)`);
      return { text, in: resp.usage?.input_tokens ?? 0, out: resp.usage?.output_tokens ?? 0 };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (isFatalLLMError(lastErr)) throw new Error(`FATAL: ${lastErr}`);
      // Rate-limit / overload → long backoff honoring Retry-After (the SDK's
      // maxRetries already retried+backed-off before surfacing here). Other
      // transient (timeout / 5xx / network) → shorter linear backoff.
      const status = e?.status ?? e?.statusCode ?? 0;
      // 429/529 = rate/overload; 503/524 = CF/origin timeout on big slow
      // requests — all want a long backoff, not a tight retry.
      const rateLimited = status === 429 || status === 503 || status === 524 || status === 529
        || /overloaded|rate.?limit|too many requests|timeout occurred|error 524/i.test(lastErr);
      const retryAfterS = Number(e?.headers?.["retry-after"]) || 0;
      const wait = rateLimited
        ? Math.min(Math.max(retryAfterS * 1000, 30_000 * 2 ** (attempt - 1)), 300_000)
        : Math.min(5_000 * attempt, 60_000);
      console.error(`    ! ${t.slug} attempt ${attempt}/6 ${rateLimited ? "RATE-LIMIT" : "transient"} (${lastErr.slice(0, 90)}) — backoff ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`synth failed after retries: ${lastErr.slice(0, 200)}`);
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

  // pre-flight
  if (!process.env.ANTHROPIC_API_KEY && !f.plan) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
  try { psql("SELECT 1"); } catch (e: any) { console.error(`DB unreachable: ${e.message}`); process.exit(1); }
  mkdirSync(CACHE_DIR, { recursive: true });

  const scope = f.source ?? "all";
  const ckptPath = checkpointPath(scope);
  const done = f.resume || existsSync(ckptPath) ? loadDone(ckptPath) : new Set<string>();

  console.log(`[A] selecting entities (source=${scope}, min-neighbors=${f.minNeighbors}${f.kind ? `, kind=${f.kind}` : ""}) …`);
  const targets = selectTargets(f).filter((t) => !done.has(t.slug));
  console.log(`    ${targets.length} entities to synthesize${done.size ? ` (${done.size} already done, skipped)` : ""}\n`);

  if (f.plan) {
    for (const t of targets.slice(0, 30)) {
      const g = gatherSources(t, f);
      console.log(`  ${t.type.padEnd(8)} ${t.slug.padEnd(42)} neighbors=${String(t.neighbors).padStart(4)}  → gather ${g.included}/${g.total}${g.dropped ? ` (drop ${g.dropped})` : ""} ~${Math.round(g.text.length / 1.5 / 1000)}k tok`);
    }
    console.log(`\n[PLAN] ${targets.length} entities total. No LLM, no writes.`);
    process.exit(0);
  }

  acquireLock();
  const summary = { synthesized: 0, failed: 0, in_tokens: 0, out_tokens: 0, dropped_sources: 0, aborted: false };
  // maxRetries: the SDK auto-backs-off 429/529/5xx (honoring Retry-After) before
  // surfacing to synthesize(), which adds a longer outer backoff on top.
  const client = new Anthropic({ baseURL: ANTHROPIC_BASE, maxRetries: 8 });
  const total = targets.length;
  let i = 0;

  const processEntity = async (t: Target): Promise<void> => {
    const n = ++i;
    const g = gatherSources(t, f);
    try {
      const s = await synthesize(client, t, g);
      const w = writePage(t.slug, renderPage(t, s.text, g, MODEL), t.source_id);
      if (!w.ok) { summary.failed++; console.log(`[B] ${n}/${total} ${t.slug.slice(0, 40).padEnd(40)} ✗ write: ${w.msg}`); return; }
      summary.synthesized++; summary.in_tokens += s.in; summary.out_tokens += s.out; summary.dropped_sources += g.dropped;
      markDone(ckptPath, { slug: t.slug, in_tokens: s.in, out_tokens: s.out, sources: g.included, dropped: g.dropped });
      console.log(`[B] ${n}/${total} ${t.slug.slice(0, 40).padEnd(40)} ✓ ${s.in}→${s.out} tok (${g.included}/${g.total} src${g.dropped ? `, drop ${g.dropped}` : ""})`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.startsWith("FATAL")) {
        summary.aborted = true;
        console.error(`[B] ${n}/${total} ${t.slug} ✗ ${msg}\n[ABORT] fatal LLM error — fix key/billing, re-run (resumes from checkpoint).`);
        return;
      }
      summary.failed++;
      console.log(`[B] ${n}/${total} ${t.slug.slice(0, 40).padEnd(40)} ✗ ${msg.slice(0, 140)}`);
    }
  };

  // Sliding concurrency pool: N runners pull from a shared queue until it is
  // empty or a fatal abort is flagged. Each entity commits independently
  // (checkpoint + gbrain put), so a crash mid-pool never wastes finished work.
  const queue = [...targets];
  const nWorkers = Math.max(1, Math.min(f.concurrency, queue.length || 1));
  console.log(`    concurrency: ${nWorkers}\n`);
  const workers = Array.from({ length: nWorkers }, async () => {
    while (queue.length && !summary.aborted) {
      await processEntity(queue.shift()!);
    }
  });
  try { await Promise.all(workers); } finally { releaseLock(); }

  console.log(`\n=== synthesis-sweep done ===`);
  console.log(`  synthesized: ${summary.synthesized}  failed: ${summary.failed}  dropped-sources: ${summary.dropped_sources}`);
  console.log(`  tokens: ${summary.in_tokens} in / ${summary.out_tokens} out`);
  console.log(`  checkpoint: ${ckptPath}`);
  process.exit(summary.aborted ? 1 : summary.failed > 0 ? 2 : 0);
}

main().catch((e) => { releaseLock(); console.error(e); process.exit(1); });
