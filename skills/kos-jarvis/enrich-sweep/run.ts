#!/usr/bin/env bun
/**
 * enrich-sweep/run.ts — primary G1 payoff: batch entity extraction
 * across the whole brain, stub page creation, Tier 2 web augmentation.
 *
 * See ./SKILL.md for protocol, flags, and pre-flight checks.
 *
 * Usage:
 *   bun run skills/kos-jarvis/enrich-sweep/run.ts --dry        # fastest sanity
 *   bun run skills/kos-jarvis/enrich-sweep/run.ts --plan       # Haiku NER only
 *   bun run skills/kos-jarvis/enrich-sweep/run.ts              # full live run
 *
 * Exit: 0 clean | 1 fatal pre-flight failure | 2 partial success
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";

import { extractWithRetry, type Extraction, type EntityKind } from "./lib/ner.ts";
import { tavilySearch, buildEntityQuery, condense } from "./lib/tavily.ts";
import { chooseSlug, renderStub, writeStub, type StubInput, type Tier } from "./lib/stub.ts";
import {
  nerCachePath,
  loadNerCache,
  appendNer,
  candidatesCachePath,
  saveCandidates,
  loadCandidates,
} from "./lib/checkpoint.ts";

// ─────────────────────────── config ───────────────────────────

const BRAIN = process.env.GBRAIN_HOME ?? join(homedir(), "brain");
const REPORT_DIR = join(BRAIN, ".agent", "reports");
const LOCK_PATH = join(homedir(), ".cache", "kos-jarvis", "enrich-sweep.lock");
// NOTE: pre-M3 (2026-05-10), this skill checked an embed-shim health endpoint
// at :7222. Shim was retired in M3 (§6.23) — embedding now goes through the
// native Vercel AI SDK gateway inside `gbrain` itself. The `gbrain list`
// pre-flight check below covers DB+gateway connectivity transitively.

type Flags = {
  dry: boolean;
  plan: boolean;
  maxTier2: number;
  tier3Only: boolean;
  minMentions: number;
  onlyKind?: EntityKind;
  limit?: number;
  resume: boolean;
  help: boolean;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = { dry: false, plan: false, maxTier2: 30, tier3Only: false, minMentions: 2, resume: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") f.dry = true;
    else if (a === "--plan") f.plan = true;
    else if (a === "--max-tier2") f.maxTier2 = Number(argv[++i]);
    else if (a === "--tier3-only") f.tier3Only = true;
    else if (a === "--min-mentions") f.minMentions = Number(argv[++i]);
    else if (a === "--kind") f.onlyKind = argv[++i] as EntityKind;
    else if (a === "--limit") f.limit = Number(argv[++i]);
    else if (a === "--resume") f.resume = true;
    else if (a === "--help" || a === "-h") f.help = true;
  }
  // --tier3-only forces maxTier2 to 0 — skip all Tavily Tier 2 augmentation.
  // Right default for company-internal entity corpora (e.g. mailagent-emails
  // source) where Tavily web search finds wrong people / misses internal
  // projects. SKILL.md §pre-flight expects this flag to short-circuit the
  // TAVILY_API_KEY check below; matched by `!flags.tier3Only` guard there.
  if (f.tier3Only) f.maxTier2 = 0;
  return f;
}

function usage() {
  console.log(`enrich-sweep — scan brain, extract entities, create stubs

Flags:
  --dry                 Plan only; no Haiku calls, no Tavily, no writes
  --plan                Haiku NER + Tier decisions, no stub writes, no Tavily
  --max-tier2 N         Cap Tavily calls (default 30)
  --tier3-only          Skip all Tavily Tier 2 augmentation (brain-only synthesis;
                        right default for company-internal corpora where web
                        search returns wrong people / misses internal projects)
  --min-mentions N      Drop entities below N mentions across sources (default 2)
  --kind K              person | company | concept | project (single-kind mode)
  --limit N             Process only first N source pages (smoke test)
  --resume              Skip NER/dedupe; re-run Phase D only from the candidates
                        cache (written after Phase C of the last run). Idempotent:
                        already-written stubs are skipped. Use after a fatal write
                        abort (e.g. fixed a Google embedding spend cap / key).
  --help                This message
`);
}

// ─────────────────────────── pre-flight ───────────────────────────

async function preflight(flags: Flags): Promise<string[]> {
  const errors: string[] = [];

  // gbrain CLI (also transitively proves DB engine + native embedding gateway
  // are wired — `list` reads the active source registry and needs a working
  // connection; M3 cutover removed the standalone embed-shim health check
  // that used to live here, see header comment).
  const r = spawnSync("gbrain", ["list", "--limit", "1"], { encoding: "utf-8" });
  if (r.status !== 0) errors.push(`gbrain list failed: ${r.stderr}`);

  // API keys
  if (!flags.dry) {
    if (!process.env.ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY not set");
  }
  if (!flags.dry && !flags.plan && !flags.tier3Only && !process.env.TAVILY_API_KEY) {
    console.warn("⚠ TAVILY_API_KEY not set — Tier 2 candidates will degrade to Tier 3 (brain-only)");
  }

  // Lock
  if (existsSync(LOCK_PATH)) {
    errors.push(`lock exists at ${LOCK_PATH} (another sweep running or crashed — delete to retry)`);
  }

  return errors;
}

function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

// ─────────────────────────── gbrain wrappers ───────────────────────────

type ListRow = { slug: string; type: string; updated: string; title: string };

function gbrainList(): ListRow[] {
  // FORK PATCH (2026-05-26): upstream `gbrain list --limit N` has an
  // internal 100-row hard cap that ignores --limit (verified empirically:
  // --limit 100/200/500/1000/99999 all return 100 rows). The CLI was
  // designed for "what's recent" UX, not for full source enumeration.
  // enrich-sweep MUST iterate every input page, so we bypass via psql.
  //
  // Also filters OUT entity-stub types (person/company/concept/project) —
  // those were created by prior sweep runs; re-NER'ing them just wastes
  // Haiku tokens (Phase B dedup catches them downstream anyway, but
  // skipping NER saves ~10% cost on a brain with many existing stubs).
  //
  // Source resolution mirrors gbrain CLI's tier order:
  //   GBRAIN_SOURCE env → sole non-default source (v0.41.13 tier 5.5)
  //   → 'default' fallback
  const dbUrl = process.env.DATABASE_URL
    ?? `postgresql://${process.env.USER ?? 'chenyuanquan'}@127.0.0.1:5432/gbrain`;
  const sourceSql = `COALESCE(
      NULLIF('${(process.env.GBRAIN_SOURCE ?? '').replace(/'/g, "''")}', ''),
      (SELECT id FROM sources WHERE id != 'default' AND archived = false LIMIT 1),
      'default'
    )`;
  const sql = `
    SELECT slug,
           type,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated,
           COALESCE(NULLIF(title, ''), slug) AS title
    FROM pages
    WHERE source_id = ${sourceSql}
      AND deleted_at IS NULL
      AND type NOT IN ('person', 'company', 'concept', 'project')
    ORDER BY id;
  `;
  const r = spawnSync("psql", [dbUrl, "-At", "-F", "\t", "-c", sql], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`psql enumerate failed: ${r.stderr}`);
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return {
        slug: parts[0],
        type: parts[1] ?? "",
        updated: parts[2] ?? "",
        title: parts.slice(3).join("\t") ?? "",
      };
    });
}

// Resolve the active source id the same way gbrainList does (GBRAIN_SOURCE env
// → sole non-default source → 'default'). Used to key the on-disk checkpoints
// so a mailagent-emails sweep and a default-source sweep never share a cache.
function resolveSourceId(): string {
  const dbUrl = process.env.DATABASE_URL
    ?? `postgresql://${process.env.USER ?? 'chenyuanquan'}@127.0.0.1:5432/gbrain`;
  const sql = `SELECT COALESCE(
      NULLIF('${(process.env.GBRAIN_SOURCE ?? '').replace(/'/g, "''")}', ''),
      (SELECT id FROM sources WHERE id != 'default' AND archived = false LIMIT 1),
      'default'
    );`;
  const r = spawnSync("psql", [dbUrl, "-At", "-c", sql], { encoding: "utf-8" });
  if (r.status !== 0) return process.env.GBRAIN_SOURCE || "default";
  return r.stdout.trim() || "default";
}

function gbrainGet(slug: string): string {
  const r = spawnSync("gbrain", ["get", slug], { encoding: "utf-8" });
  if (r.status !== 0) return "";
  return r.stdout;
}

function parseKindFromFrontmatter(body: string): string | undefined {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const kind = m[1].match(/^kind:\s*(\S+)/m);
  return kind?.[1];
}

function parseUpdatedFromFrontmatter(body: string): string | undefined {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const u = m[1].match(/^updated:\s*'?([0-9]{4}-[0-9]{2}-[0-9]{2})'?/m);
  return u?.[1];
}

// ─────────────────────────── dedupe ───────────────────────────

type Canonical = {
  key: string;            // lowercase normalized key
  name: string;           // display name
  aliases: Set<string>;
  kind: EntityKind;
  mentions: Extraction[];
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bmr\.?|\bmrs\.?|\bdr\.?|\bprof\.?/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(extractions: Extraction[]): Canonical[] {
  const byKey = new Map<string, Canonical>();
  for (const ex of extractions) {
    const key = normalizeName(ex.name);
    if (!key || key.length < 2) continue;
    const kindKey = `${ex.kind}:${key}`;
    let c = byKey.get(kindKey);
    if (!c) {
      c = { key, name: ex.name, aliases: new Set([ex.name]), kind: ex.kind, mentions: [] };
      byKey.set(kindKey, c);
    } else {
      c.aliases.add(ex.name);
      // Prefer the longer / capitalized variant as display name
      if (ex.name.length > c.name.length || /[A-Z]/.test(ex.name)) c.name = ex.name;
    }
    c.mentions.push(ex);
  }
  return Array.from(byKey.values());
}

// ─────────────────────────── tier classification ───────────────────────────

function classifyTier(c: Canonical): { tier: Tier; tier1_blocked: boolean } {
  const count = c.mentions.length;
  const sources = new Set(c.mentions.map((m) => m.source_slug));
  const touchesDecision = [...sources].some(
    (s) => s.includes("decision") || s.includes("meeting") || s.includes("protocol"),
  );
  if (count >= 8 || touchesDecision) {
    // Wants Tier 1 but no Crustdata — degrade to Tier 2 processing
    return { tier: 2, tier1_blocked: true };
  }
  if (count >= 3 && sources.size >= 2) {
    return { tier: 2, tier1_blocked: false };
  }
  return { tier: 3, tier1_blocked: false };
}

// Documentation-file naming conventions masquerading as concepts
const DOC_FILE_STOPWORDS = new Set([
  "soul md", "soulmd", "skill md", "skillmd", "agents md", "agentsmd",
  "memory md", "memorymd", "user md", "usermd", "claude md", "claudemd",
  "todos md", "todosmd", "readme md", "readmemd", "plan md", "planmd",
  "resolver md", "resolvermd", "prompt md", "promptmd",
]);

function mentionNoise(c: Canonical): boolean {
  // Single mention with very short context = likely header noise
  if (c.mentions.length === 1) {
    const ctx = c.mentions[0].context.length;
    if (ctx < 50) return true;
  }
  // Documentation filename conventions picked up as "concepts"
  if (c.kind === "concept" && DOC_FILE_STOPWORDS.has(c.key)) return true;
  // Raw markdown filename survivors from NER (e.g. "SOUL.md" → "soul md")
  if (c.kind === "concept" && /\bmd$/.test(c.key) && c.key.length < 16) return true;
  // Bug-tracker IDs + pure-numeric tokens — work-email corpus noise misclassified
  // as concept/project. Validated 2026-05-27 vs the killed Sweep #2 partial:
  // 22/637 hits, 0 false positives (product codes like "8021x", "sg2008",
  // "nist-sp-800-53" keep a non-digit char, so they survive). c.key is the
  // normalizeName output (hyphens→spaces), so \s* covers "bug-123" and "bug123".
  if (/^\d+$/.test(c.key)) return true;
  if (/^bug\s*\d+$/.test(c.key)) return true;
  return false;
}

// Fatal write errors that should ABORT the whole Phase D loop immediately
// rather than retrying every remaining candidate. These are config/billing
// problems (not transient): the same error will hit every single write, so
// grinding through thousands of them (Sweep #2: 637 × 3 retries) is pure waste.
// Transient errors (network blips, 500s, 429 rate-limits) are NOT matched here
// and keep the per-candidate "count as failed, continue" behavior.
function isFatalWriteError(msg: string): boolean {
  return /spend(ing)?\s*cap|RESOURCE_EXHAUSTED|quota|api key not valid|invalid api key|\b401\b|\b403\b|unauthorized|permission denied/i.test(
    msg,
  );
}

// ─────────────────────────── existence check ───────────────────────────

function pageExists(slug: string, knownSlugs: Set<string>, knownAliasKeys: Map<string, string>, aliases: Set<string>): boolean {
  if (knownSlugs.has(slug)) return true;
  // Check aliases against existing slug basenames
  for (const alias of aliases) {
    const normKey = normalizeName(alias);
    if (knownAliasKeys.has(normKey)) return true;
  }
  return false;
}

function buildAliasIndex(rows: ListRow[]): Map<string, string> {
  // Map normalized_title → slug. Also index each individual token of
  // multi-word titles (first names, company roots) so NER hits like
  // "Lucien" match existing "lucien-chen" page.
  const idx = new Map<string, string>();
  const recordKey = (key: string, slug: string) => {
    if (!key || key.length < 2) return;
    if (!idx.has(key)) idx.set(key, slug);
  };
  for (const row of rows) {
    const title = row.title || row.slug.split("/").pop() || row.slug;
    recordKey(normalizeName(title), row.slug);

    const slugBase = row.slug.split("/").pop()?.replace(/-/g, " ") ?? "";
    recordKey(normalizeName(slugBase), row.slug);

    // Index individual tokens of 2-3 word titles (persons, short orgs)
    const tokens = normalizeName(title).split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.length <= 3) {
      for (const t of tokens) if (t.length >= 3) recordKey(t, row.slug);
    }
    const slugTokens = normalizeName(slugBase).split(/\s+/).filter(Boolean);
    if (slugTokens.length >= 2 && slugTokens.length <= 3) {
      for (const t of slugTokens) if (t.length >= 3) recordKey(t, row.slug);
    }
  }
  return idx;
}

// ─────────────────────────── main ───────────────────────────

type Summary = {
  started: string;
  finished: string;
  flags: Flags;
  total_pages: number;
  extraction_errors: number;
  total_extractions: number;
  unique_entities: number;
  pre_existing: number;
  by_tier: Record<string, number>;
  by_kind: Record<string, number>;
  tavily_calls: number;
  stubs_written: number;
  stubs_failed: number;
  tier1_blocked: string[];
  created_slugs: string[];
  failed_slugs: string[];
  aborted: boolean;
};

// ─────────────────────────── Phase D + E (shared by full run and --resume) ───────────────────────────

type PlannedCandidate = { canonical: Canonical; tier: Tier; tier1_blocked: boolean; slug: string };

async function runWritePhase(newCandidates: PlannedCandidate[], summary: Summary, flags: Flags): Promise<void> {
  // ── Phase D: write stubs (with Tavily for Tier 2) ──
  console.log("[D] Writing stubs …");
  let tavilyBudget = flags.maxTier2;
  for (let di = 0; di < newCandidates.length; di++) {
    const cand = newCandidates[di];
    let tavilyBlock: string | undefined;
    if (cand.tier === 2 && tavilyBudget > 0 && (cand.canonical.kind === "person" || cand.canonical.kind === "company")) {
      const q = buildEntityQuery(cand.canonical.name, cand.canonical.kind);
      const result = await tavilySearch(q);
      summary.tavily_calls++;
      tavilyBudget--;
      tavilyBlock = condense(result);
    }

    const firstMention = cand.canonical.mentions
      .map((m) => parseUpdatedFromFrontmatter(gbrainGet(m.source_slug)))
      .filter((x): x is string => !!x)
      .sort()[0];

    const input: StubInput = {
      slug: cand.slug,
      name: cand.canonical.name,
      aliases: [...cand.canonical.aliases],
      kind: cand.canonical.kind,
      tier: cand.tier,
      mention_count: cand.canonical.mentions.length,
      source_slugs: [...new Set(cand.canonical.mentions.map((m) => m.source_slug))],
      first_mention_date: firstMention,
      tavily_block: tavilyBlock,
      seed_context: cand.canonical.mentions[0]?.context ?? "",
      tier1_blocked: cand.tier1_blocked,
    };

    const res = writeStub(input, false);
    if (res.ok) {
      summary.stubs_written++;
      summary.created_slugs.push(cand.slug);
      console.log(`  ✓ ${cand.slug} (tier ${cand.tier}${cand.tier1_blocked ? "*" : ""})`);
    } else {
      summary.stubs_failed++;
      summary.failed_slugs.push(cand.slug);
      console.error(`  ✗ ${cand.slug}: ${res.message}`);
      // Fail-fast: a fatal write error (spend cap / bad key) will hit EVERY
      // remaining write the same way. Abort instead of grinding thousands of
      // retries (Sweep #2 burned ~5h doing exactly that).
      if (isFatalWriteError(res.message)) {
        summary.aborted = true;
        console.error(`\n✗✗ ABORT — fatal write error (likely Google embedding spend cap / invalid key).`);
        console.error(`   Stopped before ${newCandidates.length - di - 1} remaining candidate(s) to avoid a pointless grind.`);
        console.error(`   Fix billing / GOOGLE_GENERATIVE_AI_API_KEY, then resume WITHOUT re-running NER:`);
        console.error(`     bun run skills/kos-jarvis/enrich-sweep/run.ts --resume`);
        break;
      }
    }
  }

  // ── Phase E: report ──
  summary.finished = new Date().toISOString();
  writeReport(summary, newCandidates);
  console.log(`\nReport: ${reportPath()}`);
  console.log(
    `Summary: ${summary.stubs_written} written, ${summary.stubs_failed} failed, ` +
      `${summary.tavily_calls} Tavily calls${summary.aborted ? " — ABORTED early (resume with --resume)" : ""}`,
  );
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    usage();
    process.exit(0);
  }

  console.log(`=== enrich-sweep @ ${new Date().toISOString()} ===`);
  console.log(`flags: ${JSON.stringify(flags)}`);

  const errors = await preflight(flags);
  if (errors.length > 0) {
    console.error("\n✗ Pre-flight failed:");
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log("✓ Pre-flight OK\n");

  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });

  const summary: Summary = {
    started: new Date().toISOString(),
    finished: "",
    flags,
    total_pages: 0,
    extraction_errors: 0,
    total_extractions: 0,
    unique_entities: 0,
    pre_existing: 0,
    by_tier: { "2": 0, "3": 0 },
    by_kind: { person: 0, company: 0, concept: 0, project: 0 },
    tavily_calls: 0,
    stubs_written: 0,
    stubs_failed: 0,
    tier1_blocked: [],
    created_slugs: [],
    failed_slugs: [],
    aborted: false,
  };

  try {
    const sourceId = resolveSourceId();
    console.log(`source: ${sourceId}`);

    // ── --resume: skip NER/dedupe, re-run Phase D only from the candidates cache ──
    if (flags.resume) {
      console.log("[resume] loading candidates cache (no NER) …");
      const rows = gbrainList();
      const knownSlugs = new Set(rows.map((r) => r.slug));
      const aliasIndex = buildAliasIndex(rows);
      const cached = loadCandidates(candidatesCachePath(sourceId));
      if (!cached || cached.length === 0) {
        console.error(`✗ no candidates cache at ${candidatesCachePath(sourceId)} — run a full sweep (or --plan) first.`);
        process.exit(1);
      }
      let skipped = 0;
      const resumeCandidates: PlannedCandidate[] = [];
      for (const c of cached) {
        const aliases = new Set(c.aliases);
        if (pageExists(c.slug, knownSlugs, aliasIndex, aliases)) {
          skipped++;
          continue;
        }
        resumeCandidates.push({
          canonical: {
            key: "",
            name: c.name,
            aliases,
            kind: c.kind,
            mentions: c.mentions.map((m) => ({ name: c.name, kind: c.kind, context: m.context, source_slug: m.source_slug })),
          },
          tier: c.tier,
          tier1_blocked: c.tier1_blocked,
          slug: c.slug,
        });
        summary.by_tier[String(c.tier)]++;
        summary.by_kind[c.kind]++;
      }
      summary.unique_entities = cached.length;
      console.log(`[resume] ${resumeCandidates.length} to write, ${skipped} already exist (skipped)`);
      await runWritePhase(resumeCandidates, summary, flags);
      process.exit(summary.aborted ? 1 : summary.stubs_failed > 0 ? 2 : 0);
    }

    // ── Phase A: collect ──
    console.log("[A] Listing brain …");
    let rows = gbrainList();
    if (flags.limit) rows = rows.slice(0, flags.limit);
    summary.total_pages = rows.length;
    console.log(`    ${rows.length} pages`);

    const knownSlugs = new Set(rows.map((r) => r.slug));
    const aliasIndex = buildAliasIndex(rows);

    const extractions: Extraction[] = [];
    if (flags.dry) {
      console.log("[A] --dry: skipping Haiku NER (would call Haiku for each page)");
    } else {
      // Resumable NER: a per-page JSONL checkpoint means a killed / timed-out
      // run picks up where it left off instead of re-paying for all the Haiku
      // calls. A page is reused only when its `updated` is unchanged.
      const nerPath = nerCachePath(sourceId);
      const nerCache = loadNerCache(nerPath);
      let resumed = 0;
      const anthropic = new Anthropic();
      let i = 0;
      for (const row of rows) {
        i++;
        const hit = nerCache.get(row.slug);
        if (hit && hit.updated === row.updated) {
          extractions.push(...hit.ex);
          resumed++;
          process.stdout.write(`\r[A] NER ${i}/${rows.length} (cached) ${row.slug.slice(0, 42).padEnd(42)}`);
          continue;
        }
        process.stdout.write(`\r[A] NER ${i}/${rows.length} ${row.slug.slice(0, 50).padEnd(50)}`);
        const body = gbrainGet(row.slug);
        if (!body.trim()) continue;
        try {
          const ex = await extractWithRetry(body, row.slug, anthropic);
          extractions.push(...ex);
          appendNer(nerPath, { slug: row.slug, updated: row.updated, ex });
        } catch (e) {
          summary.extraction_errors++;
          console.error(`\n    ! NER failed for ${row.slug}: ${e instanceof Error ? e.message : e}`);
        }
      }
      process.stdout.write("\n");
      if (resumed > 0) console.log(`    resumed ${resumed}/${rows.length} from NER checkpoint (${nerPath})`);
    }
    summary.total_extractions = extractions.length;
    console.log(`[A] collected ${extractions.length} extractions (${summary.extraction_errors} errors)\n`);

    // ── Phase B: dedupe ──
    console.log("[B] Deduping …");
    let canonicals = dedupe(extractions);
    const preFilter = canonicals.length;
    canonicals = canonicals.filter((c) => !mentionNoise(c));
    canonicals = canonicals.filter((c) => c.mentions.length >= flags.minMentions);
    if (flags.onlyKind) canonicals = canonicals.filter((c) => c.kind === flags.onlyKind);
    summary.unique_entities = canonicals.length;
    console.log(
      `    ${canonicals.length} unique entities after dedupe ` +
        `(${preFilter - canonicals.length} dropped: noise / below --min-mentions=${flags.minMentions})\n`,
    );

    // ── Phase C: existence check + tier ──
    console.log("[C] Filtering existing + tiering …");
    const newCandidates: Array<{ canonical: Canonical; tier: Tier; tier1_blocked: boolean; slug: string }> = [];
    for (const c of canonicals) {
      const slug = chooseSlug(c.name, c.kind);
      if (pageExists(slug, knownSlugs, aliasIndex, c.aliases)) {
        summary.pre_existing++;
        continue;
      }
      const { tier, tier1_blocked } = classifyTier(c);
      newCandidates.push({ canonical: c, tier, tier1_blocked, slug });
      summary.by_tier[String(tier)]++;
      summary.by_kind[c.kind]++;
      if (tier1_blocked) summary.tier1_blocked.push(c.name);
    }
    console.log(
      `    ${newCandidates.length} new stubs planned ` +
        `(${summary.pre_existing} pre-existing, ` +
        `tier2=${summary.by_tier["2"]}, tier3=${summary.by_tier["3"]})\n`,
    );

    // Persist the planned candidates so --resume can re-run Phase D without
    // re-paying for NER. Skip in --dry (no real candidates — don't clobber a
    // good cache with []). --plan DOES write it, so a plan run can be resumed.
    if (!flags.dry) {
      saveCandidates(
        candidatesCachePath(sourceId),
        newCandidates.map((c) => ({
          slug: c.slug,
          name: c.canonical.name,
          aliases: [...c.canonical.aliases],
          kind: c.canonical.kind,
          tier: c.tier,
          tier1_blocked: c.tier1_blocked,
          mentions: c.canonical.mentions.map((m) => ({ source_slug: m.source_slug, context: m.context })),
        })),
      );
    }

    // Early exit for dry or plan modes
    if (flags.dry || flags.plan) {
      console.log(`[${flags.dry ? "DRY" : "PLAN"}] Candidate preview (top 20 by mentions):`);
      const preview = [...newCandidates]
        .sort((a, b) => b.canonical.mentions.length - a.canonical.mentions.length)
        .slice(0, 20);
      for (const c of preview) {
        console.log(
          `  [${c.tier}${c.tier1_blocked ? "!" : " "}] ${c.canonical.kind.padEnd(7)} ${c.slug.padEnd(40)} ` +
            `(${c.canonical.mentions.length} mentions, ${new Set(c.canonical.mentions.map((m) => m.source_slug)).size} sources)`,
        );
      }
      summary.finished = new Date().toISOString();
      writeReport(summary, newCandidates);
      console.log(`\nReport written: ${reportPath()}`);
      process.exit(0);
    }

    await runWritePhase(newCandidates, summary, flags);
    process.exit(summary.aborted ? 1 : summary.stubs_failed > 0 ? 2 : 0);
  } finally {
    releaseLock();
  }
}

// ─────────────────────────── report ───────────────────────────

function reportPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(REPORT_DIR, `enrich-sweep-${date}.md`);
}

function writeReport(
  s: Summary,
  candidates: Array<{ canonical: Canonical; tier: Tier; tier1_blocked: boolean; slug: string }>,
) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const md: string[] = [
    `# enrich-sweep — ${date}`,
    "",
    `Started: ${s.started}  `,
    `Finished: ${s.finished}  `,
    `Mode: ${s.flags.dry ? "DRY" : s.flags.plan ? "PLAN" : "LIVE"}`,
    "",
    "## Inventory",
    `- Source pages scanned: ${s.total_pages}`,
    `- Raw extractions: ${s.total_extractions}`,
    `- Unique entities after dedupe: ${s.unique_entities}`,
    `- Pre-existing entity pages skipped: ${s.pre_existing}`,
    `- NER errors: ${s.extraction_errors}`,
    "",
    "## Tier distribution",
    `- Tier 2 (Tavily-augmented): ${s.by_tier["2"]}`,
    `- Tier 3 (brain-only): ${s.by_tier["3"]}`,
    "",
    "## Kind distribution",
    `- person: ${s.by_kind.person}`,
    `- company: ${s.by_kind.company}`,
    `- concept: ${s.by_kind.concept}`,
    `- project: ${s.by_kind.project}`,
    "",
    "## Stubs",
    `- Written: ${s.stubs_written}`,
    `- Failed: ${s.stubs_failed}`,
    `- Tavily calls: ${s.tavily_calls}`,
    "",
    "### Created slugs",
    ...(s.created_slugs.length > 0 ? s.created_slugs.map((x) => `- \`${x}\``) : ["_none_"]),
    "",
    "### Failed slugs",
    ...(s.failed_slugs.length > 0 ? s.failed_slugs.map((x) => `- \`${x}\``) : ["_none_"]),
    "",
    "## Tier 1 blocked (wanted Tier 1, no Crustdata key)",
    s.tier1_blocked.length > 0
      ? s.tier1_blocked.map((n) => `- ${n}`).join("\n")
      : "_none_",
    "",
    "## Candidate preview (top 30 by mentions)",
    "",
    "| Tier | Kind | Slug | Mentions | Sources |",
    "|------|------|------|----------|---------|",
    ...[...candidates]
      .sort((a, b) => b.canonical.mentions.length - a.canonical.mentions.length)
      .slice(0, 30)
      .map(
        (c) =>
          `| ${c.tier}${c.tier1_blocked ? "*" : ""} | ${c.canonical.kind} | \`${c.slug}\` | ${c.canonical.mentions.length} | ${new Set(c.canonical.mentions.map((m) => m.source_slug)).size} |`,
      ),
    "",
    "_`*` next to tier = wanted Tier 1, degraded due to missing Crustdata key._",
    "",
    "## Rollback",
    "",
    "```bash",
    ...s.created_slugs.map((x) => `gbrain delete ${x}`),
    "```",
  ];

  const path = reportPath();
  writeFileSync(path, md.join("\n"), "utf-8");

  // JSON sidecar for machine rollback
  writeFileSync(path + ".json", JSON.stringify(s, null, 2), "utf-8");
}

main().catch((e) => {
  console.error("FATAL:", e);
  releaseLock();
  process.exit(1);
});
