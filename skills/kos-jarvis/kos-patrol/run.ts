#!/usr/bin/env bun
/**
 * kos-patrol/run.ts — daily brain health check.
 *
 * Implements the six-phase protocol in ./SKILL.md:
 *   1. Inventory (counts by kind / confidence / status)
 *   2. Lint (delegate to kos-lint/run.ts)
 *   3. Staleness (decision/protocol/project updated >180d, status=active)
 *   4. Gap detection (entity mentions ≥3 across pages, no page exists)
 *   5. Dashboard → ~/brain/.agent/dashboards/knowledge-health-<date>.md
 *   6. Digest → ~/brain/.agent/digests/patrol-<date>.md
 *
 * Exit: 0 clean | 1 ERROR from lint | 2 WARN-only
 *
 * This is the P0 TODO from skills/kos-jarvis/TODO.md. It's a read-only
 * patrol — it does NOT write to the brain. Only report files under
 * ~/brain/.agent/ are created.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { BrainDb } from "../_lib/brain-db.ts";

const BRAIN = process.env.GBRAIN_HOME ?? join(homedir(), "brain");
const DASH_DIR = join(BRAIN, ".agent", "dashboards");
const DIGEST_DIR = join(BRAIN, ".agent", "digests");

const TODAY = new Date().toISOString().slice(0, 10);
const STALE_DAYS = 180;

type Page = {
  slug: string;
  listed_type: string;
  kind?: string;
  title?: string;
  status?: string;
  confidence?: string;
  updated?: string;
  review_after?: string;
  body: string;
  aliases?: string[]; // frontmatter aliases — used by phase4 to suppress known-entity variants
};

type Severity = "ERROR" | "WARN";
type Finding = { check: number; severity: Severity; slug?: string; message: string };
type LintSummary = { rows: number; findings: Finding[]; errors: number; warns: number };

// ─────────────────────────── helpers ───────────────────────────

/**
 * Load ALL pages from PGLite in one query — replaces the old 1-RPC
 * `gbrain list` + N-RPC `gbrain get <slug>` fan-out (which triggered
 * the macOS 26.3 PGLite WASM init bug under nested subprocess context,
 * see skills/kos-jarvis/TODO.md § "kos-patrol cron exit-1"). In-process
 * open keeps PGLite in this process's memory; `gbrain list` bug was
 * also hitting the upstream 100-row cap on the `list_pages` MCP op.
 *
 * Returns the same `Page` shape as the old loader so downstream phases
 * (staleness, gap detection, dashboard rendering) are untouched.
 */
async function loadAllPages(db: BrainDb): Promise<Page[]> {
  const rows = await db.listAllPages();
  return rows.map((r) => {
    const fm = r.frontmatter as Record<string, unknown>;
    const fmStr = (k: string): string | undefined => {
      const v = fm?.[k];
      return typeof v === "string" ? v : undefined;
    };
    // Extract aliases array from frontmatter (string[] or null)
    const fmAliases = fm?.["aliases"];
    const aliases: string[] | undefined = Array.isArray(fmAliases)
      ? (fmAliases as unknown[]).filter((a): a is string => typeof a === "string")
      : undefined;
    return {
      slug: r.slug,
      listed_type: r.type,
      kind: fmStr("kind"),
      title: r.title,
      status: fmStr("status"),
      confidence: fmStr("confidence"),
      // r.updated_at is a Date from PGLite; frontmatter `updated:` is typically a YYYY-MM-DD string.
      updated: fmStr("updated") ?? new Date(r.updated_at as unknown as string).toISOString().slice(0, 10),
      review_after: fmStr("review_after"),
      // compiled_truth + timeline approximates the post-frontmatter body that
      // the legacy `gbrain get` path returned. Phase 4 strips a frontmatter
      // prefix if present, which is a no-op here.
      body: r.compiled_truth + (r.timeline ? "\n" + r.timeline : ""),
      aliases,
    };
  });
}

function daysAgo(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return undefined;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function writeFileMk(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

// ─────────────────────────── Phase 1: Inventory ───────────────────────────

type Inventory = {
  total: number;
  byKind: Record<string, number>;
  byConfidence: Record<string, number>;
  byStatus: Record<string, number>;
};

function phase1(pages: Page[]): Inventory {
  const inv: Inventory = {
    total: pages.length,
    byKind: {},
    byConfidence: {},
    byStatus: {},
  };
  for (const p of pages) {
    const k = p.kind ?? p.listed_type ?? "unknown";
    inv.byKind[k] = (inv.byKind[k] ?? 0) + 1;
    const c = p.confidence ?? "unspecified";
    inv.byConfidence[c] = (inv.byConfidence[c] ?? 0) + 1;
    const s = p.status ?? "unspecified";
    inv.byStatus[s] = (inv.byStatus[s] ?? 0) + 1;
  }
  return inv;
}

// ─────────────────────────── Phase 2: Lint ───────────────────────────

/**
 * kos-lint retired 2026-05-10 (M1 milestone). Six-check coverage moved to:
 *   - check 1 (frontmatter): upstream `frontmatter-guard` skill + `gbrain doctor`
 *   - check 2 (duplicate id): `gbrain doctor` schema integrity
 *   - check 3 (dead links): upstream BrainWriter linkValidator (sync gate)
 *   - check 4 (orphans): `gbrain orphans` + dream-cycle phase
 *   - check 5 (weak links), check 6 (evidence gap): not yet rehomed; future
 *     `kos-quality` ~150 LOC shim if Lucien wants them back.
 *
 * Phase 2 is now a no-op so dashboard/digest signatures remain stable. The
 * old runner is archived at skills/kos-jarvis/_archived/kos-lint/.
 */
function phase2(): LintSummary {
  return { rows: 0, findings: [], errors: 0, warns: 0 };
}

// ─────────────────────────── Phase 3: Staleness ───────────────────────────

type StaleHit = { slug: string; kind: string; days: number; reason: string };

const STALE_KINDS = new Set(["decision", "protocol", "project"]);

function phase3(pages: Page[]): StaleHit[] {
  const hits: StaleHit[] = [];
  for (const p of pages) {
    const kind = p.kind ?? p.listed_type;
    if (!kind || !STALE_KINDS.has(kind)) continue;
    if (p.status !== "active") continue;
    const ago = daysAgo(p.updated);
    if (ago !== undefined && ago > STALE_DAYS) {
      hits.push({ slug: p.slug, kind, days: ago, reason: `updated ${ago}d ago` });
    }
    if (p.review_after) {
      const overdue = daysAgo(p.review_after);
      if (overdue !== undefined && overdue > 0) {
        hits.push({
          slug: p.slug,
          kind,
          days: overdue,
          reason: `review_after overdue by ${overdue}d`,
        });
      }
    }
  }
  return hits;
}

// ─────────────────────────── Phase 4: Gaps ───────────────────────────

type Gap = { entity: string; mentions: number; sample_pages: string[] };

const GAP_THRESHOLD = 3;

/**
 * Stoplist for phase 4 ProperName extraction. The regex
 * `[A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]{2,}){1,3}` happily matches Notion
 * email-template column headers ("Has Attachments", "Action Required",
 * "From Name", ...) and generic UI / process labels ("In Progress", "To
 * Do", ...) that show up ≥ 3 times across the source corpus but carry
 * zero entity meaning.
 *
 * Surfaced 2026-04-23 by P1-C kos-patrol output (TODO §P2 entry); fixed
 * 2026-04-25 with this stoplist + the (lower) lookup below. Comparison is
 * case-insensitive — store every term lowercased.
 *
 * Add new terms here when phase 4 starts surfacing fresh noise. Do NOT
 * suppress legit entities — when in doubt, file as a separate skill
 * (enrich-sweep) decision.
 */
const PHASE4_STOPLIST: ReadonlySet<string> = new Set([
  // Notion email/header noise (the original 2026-04-23 trigger)
  "has attachments", "action required", "from name", "from email",
  "processing status", "sender priority", "daily digests", "mail actions",
  "reply to", "forward to", "subject line", "received at", "sent at",
  // Notion database column headers (auto-generated)
  "created time", "last edited", "created by", "last edited by", "due date",
  "page id", "page title", "rich text", "multi select",
  // Calendar / fiscal labels
  "year end", "quarter start", "quarter end", "fiscal year", "calendar year",
  // Process status labels
  "in progress", "in review", "not started", "on hold", "to do",
  // Generic UI affordances
  "see more", "show all", "click here", "learn more", "read more",
  "view all", "view more",
  // 2026-04-29 post Path 3 sweep — Notion column headers + UI labels that
  // re-surfaced when notion-poller resumed against the Postgres engine.
  // Keep "Link Systems Inc" OFF this list (real company candidate) — the
  // ≥2-kind rule below will silence it when it only appears in
  // sources/notion/ pages.
  "original eml", "action type", "key points", "best regards", "open threads",
  "parent item", "what they believe", "what they", "all day", "related project",
  "organizer email", "reply suggestion", "product engineer", "attendee count",
  "last synced", "email inbox", "sync status", "daily log", "last modified",
  // 2026-04-29 second pass — job-title / UI-term noise that survives ≥2-kind
  // because the same role appears in both source and people pages, but a
  // role isn't a wiki entity. (Specific people get their own people/<slug>
  // pages from the enrich pipeline.)
  "product manager", "content marketing manager", "product security",
  "enterprise security", "global sales", "ebg marketing",
  "order form", "remote access", "camera license",
  // 2026-04-29 third pass — generic terms / geo / process / team labels
  // that aren't entity-worthy by themselves.
  "video content creator", "network service provider", "united states",
  "alpha test", "legal review request", "mapbox commercial license agreement",
  "link product security team",
  // 2026-04-29 fourth pass — remaining role/geo noise.
  "software engineer", "sales engineer", "key account manager",
  "san francisco",
]);

/**
 * Coarse gap detection: find "ProperName LikeThis" tokens that appear
 * ≥ 3 times across pages but don't match any existing slug/title and
 * aren't in the stoplist.
 * Intentionally approximate — the enrich-sweep skill does the real
 * work. This is a cheap signal for the dashboard.
 *
 * Per-name we also track which `kind`s (source / project / person /
 * concept …) the mentions came from. A real entity gap shows up across
 * ≥ 2 distinct kinds (e.g. mentioned in a project page AND a meeting
 * source). Notion column-header noise like "Original EML" / "Sync
 * Status" appears only in `kind=source` pages — the ≥2-kind rule
 * silences that whole class of noise without per-term stoplist work.
 */
function phase4(pages: Page[]): Gap[] {
  const counts = new Map<string, { count: number; pages: Set<string>; kinds: Set<string> }>();
  const re = /\b([A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]{2,}){1,3})\b/g;
  for (const p of pages) {
    // skip frontmatter
    const body = p.body.replace(/^---\n[\s\S]*?\n---/, "");
    const pageKind = String(p.kind ?? p.listed_type ?? "unknown");
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const slot = counts.get(name) ?? { count: 0, pages: new Set(), kinds: new Set() };
      slot.count++;
      slot.pages.add(p.slug);
      slot.kinds.add(pageKind);
      counts.set(name, slot);
    }
  }

  const knownTitles = new Set<string>();
  const knownSlugTails = new Set<string>();
  for (const p of pages) {
    if (p.title) knownTitles.add(p.title.toLowerCase());
    const tail = p.slug.split("/").pop()?.replace(/-/g, " ").toLowerCase();
    if (tail) knownSlugTails.add(tail);
    // Also suppress all frontmatter aliases — 2026-05-14 fix:
    // aliases like "Link Systems Inc" / "Peters Canyon" / "Link Canada Inc"
    // were registered in entity page frontmatter but phase4 never read them,
    // causing known-entity variants to surface as gaps every patrol run.
    if (p.aliases) {
      for (const a of p.aliases) knownTitles.add(a.toLowerCase());
    }
  }

  const gaps: Gap[] = [];
  for (const [name, { count, pages: ps, kinds }] of counts) {
    if (count < GAP_THRESHOLD) continue;
    if (kinds.size < 2) continue; // single-kind hits are almost always Notion noise
    const lower = name.toLowerCase();
    if (PHASE4_STOPLIST.has(lower)) continue;
    if (knownTitles.has(lower) || knownSlugTails.has(lower)) continue;
    gaps.push({ entity: name, mentions: count, sample_pages: [...ps].slice(0, 3) });
  }
  gaps.sort((a, b) => b.mentions - a.mentions);

  // 2026-04-30 case-variant + edit-distance dedup. The 04-30 dashboard
  // surfaced "Link Systems Inc" / "Link System Inc" / "LINK SYSTEMS INC" /
  // "Link System" — five variants of one company occupying five of the
  // twenty dashboard slots. Two-stage merge:
  //   1) lowercase + drop non-alphanum + drop common company suffixes
  //      (Inc/LLC/Ltd/Corp/Co/GmbH) → exact-match merge.
  //   2) Levenshtein ≤ 1 on the normalized form (≥ 4 chars) → singular/
  //      plural merge ("linksystems" ↔ "linksystem").
  // Highest-mention variant wins as canonical entity name; merged entries
  // sum mentions and union sample_pages (cap 3). Items processed in
  // mention-desc order so the top variant becomes the rep.
  const SUFFIX_RE = /\b(inc|llc|ltd|corp|co|company|corporation|gmbh|sa|bv)\b/g;
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(SUFFIX_RE, "")
      .replace(/\s+/g, "").trim();
  const lev = (a: string, b: string): number => {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return 2; // can't reach ≤ 1
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur.push(Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
      }
      prev = cur;
    }
    return prev[b.length];
  };
  const reps: { canonical: string; gap: Gap }[] = [];
  for (const g of gaps) {
    const n = normalize(g.entity);
    let merged = false;
    if (n) {
      for (const r of reps) {
        if (n === r.canonical ||
            (n.length >= 4 && r.canonical.length >= 4 && lev(n, r.canonical) <= 1)) {
          r.gap.mentions += g.mentions;
          const union = new Set([...r.gap.sample_pages, ...g.sample_pages]);
          r.gap.sample_pages = [...union].slice(0, 3);
          merged = true;
          break;
        }
      }
    }
    if (!merged) {
      reps.push({ canonical: n, gap: { ...g, sample_pages: [...g.sample_pages] } });
    }
  }
  return reps.map((r) => r.gap).slice(0, 20); // cap for dashboard readability
}

// ─────────────────────────── Phase 5: Dashboard ───────────────────────────

function renderDashboard(
  inv: Inventory,
  lint: LintSummary,
  stale: StaleHit[],
  gaps: Gap[],
): string {
  const kinds = Object.entries(inv.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const confs = Object.entries(inv.byConfidence)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const statuses = Object.entries(inv.byStatus)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");

  const lines = [
    `# Knowledge Health — ${TODAY}`,
    "",
    "## Inventory",
    `- Total pages: ${inv.total}`,
    `- By kind: ${kinds}`,
    `- Confidence: ${confs}`,
    `- Status: ${statuses}`,
    "",
    "## Lint",
    `- ${lint.errors} ERROR, ${lint.warns} WARN across ${lint.rows} pages`,
    ...(lint.findings.length > 0 && lint.findings.length <= 30
      ? ["", ...lint.findings.slice(0, 30).map((f) => `  - [${f.check}] ${f.severity} ${f.slug ?? "-"}: ${f.message}`)]
      : []),
    ...(lint.findings.length > 30
      ? ["", `  (${lint.findings.length} findings; top 15 below)`, ...lint.findings.slice(0, 15).map((f) => `  - [${f.check}] ${f.severity} ${f.slug ?? "-"}: ${f.message}`)]
      : []),
    "",
    "## Staleness",
    `- ${stale.length} pages flagged (kind ∈ {decision, protocol, project}, status=active)`,
    ...stale.slice(0, 20).map((s) => `  - [${s.kind}] ${s.slug} — ${s.reason}`),
    ...(stale.length > 20 ? [`  … and ${stale.length - 20} more`] : []),
    "",
    "## Gaps",
    `- ${gaps.length} frequently-mentioned entities without pages (threshold ${GAP_THRESHOLD}+ mentions)`,
    ...gaps.map((g) => `  - "${g.entity}" — ${g.mentions} mentions, samples: ${g.sample_pages.join(", ")}`),
    "",
    "## Next actions",
    ...(lint.errors > 0 ? ["- Fix kos-lint ERROR findings before next ingest"] : []),
    ...(stale.length > 0 ? [`- Triage ${stale.length} stale decision/protocol/project pages`] : []),
    ...(gaps.length > 0 ? [`- Run \`bun run skills/kos-jarvis/enrich-sweep/run.ts --plan\` to convert ${gaps.length} gaps into stubs`] : []),
    ...(lint.errors === 0 && stale.length === 0 && gaps.length === 0 ? ["- All green. No action."] : []),
  ];
  return lines.join("\n") + "\n";
}

// ─────────────────────────── Phase 6: Digest ───────────────────────────

function renderDigest(inv: Inventory, lint: LintSummary, stale: StaleHit[], gaps: Gap[]): string {
  return (
    `[knowledge-os] ${TODAY} patrol: ${inv.total}p / ${lint.errors}E ${lint.warns}W / ` +
    `stale=${stale.length} / gaps=${gaps.length}.\n` +
    `  Kinds: ${Object.entries(inv.byKind)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ")}.\n` +
    (gaps.length > 0
      ? `  Top gaps: ${gaps.slice(0, 3).map((g) => `${g.entity}(${g.mentions})`).join(", ")}.\n`
      : `  No entity gaps ≥ ${GAP_THRESHOLD}.\n`)
  );
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");

  console.log(`=== kos-patrol @ ${TODAY} ===`);

  console.log("[1] Inventory …");
  const db = new BrainDb();
  let pages: Page[];
  try {
    await db.open();
    pages = await loadAllPages(db);
  } finally {
    await db.close().catch(() => {});
  }
  const inv = phase1(pages);
  console.log(
    `    ${inv.total} pages; kinds: ${Object.entries(inv.byKind).map(([k, n]) => `${k}=${n}`).join(", ")}`,
  );

  console.log("[2] Lint …");
  const lint = phase2();
  console.log(`    ${lint.errors} ERROR, ${lint.warns} WARN`);

  console.log("[3] Staleness …");
  const stale = phase3(pages);
  console.log(`    ${stale.length} flagged`);

  console.log("[4] Gap detection …");
  const gaps = phase4(pages);
  console.log(`    ${gaps.length} entity gaps`);

  const dashboard = renderDashboard(inv, lint, stale, gaps);
  const digest = renderDigest(inv, lint, stale, gaps);

  const dashPath = join(DASH_DIR, `knowledge-health-${TODAY}.md`);
  const digestPath = join(DIGEST_DIR, `patrol-${TODAY}.md`);

  if (dryRun) {
    console.log("\n[5/6] --dry: would write:");
    console.log(`       ${dashPath}`);
    console.log(`       ${digestPath}`);
    console.log("\n--- dashboard preview ---");
    console.log(dashboard);
    console.log("--- digest preview ---");
    console.log(digest);
  } else {
    writeFileMk(dashPath, dashboard);
    writeFileMk(digestPath, digest);
    console.log(`[5] Dashboard → ${dashPath}`);
    console.log(`[6] Digest    → ${digestPath}`);
  }

  const code = lint.errors > 0 ? 1 : lint.warns > 0 ? 2 : 0;
  console.log(`\nExit: ${code}`);
  process.exit(code);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
