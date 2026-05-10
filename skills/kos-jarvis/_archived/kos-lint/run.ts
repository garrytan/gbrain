#!/usr/bin/env bun
/**
 * kos-lint/run.ts — six-check lint pass, wraps gbrain CLI.
 *
 * Usage:
 *   bun run skills/kos-jarvis/kos-lint/run.ts          # full text report
 *   bun run skills/kos-jarvis/kos-lint/run.ts --json   # machine-readable
 *   bun run skills/kos-jarvis/kos-lint/run.ts --check N   # single check
 *
 * Exit: 0 clean | 1 any ERROR | 2 only WARN
 */
import { spawnSync } from "node:child_process";
import { BrainDb, type PageRow } from "../_lib/brain-db.ts";

type Severity = "ERROR" | "WARN";
type Finding = { check: number; severity: Severity; slug?: string; message: string };

const REQUIRED_FIELDS = ["id", "kind", "status", "created", "updated"];

type ListRow = { slug: string; type?: string; title?: string; updated?: string };

function gbrain(args: string[]): string {
  const r = spawnSync("gbrain", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    // `config get <key>` exits non-zero on "Config key not found"; for our
    // callers that's equivalent to "not set" and should not kill the process.
    if (args[0] === "config" && args[1] === "get" && /Config key not found/i.test(r.stderr)) {
      return "";
    }
    throw new Error(`gbrain ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

// BrainDb-backed caches. Before v0.17 sync, kos-lint shelled `gbrain list` +
// `gbrain get` per page, which capped at 100 rows (MCP list_pages clamp) and
// took ~1 subprocess per page. The direct DB read is unlimited, ~100x faster,
// and gives a complete slug set for dead-link resolution.
let _allPagesCache: PageRow[] | null = null;
let _bodyCache = new Map<string, string>();

function setupBrainCache(rows: PageRow[]): void {
  _allPagesCache = rows;
  _bodyCache = new Map<string, string>();
  for (const r of rows) {
    const fmYaml = Object.entries(r.frontmatter)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    const body = `---\n${fmYaml}\n---\n\n${r.compiled_truth}\n\n${r.timeline}`.trimEnd();
    _bodyCache.set(r.slug, body);
  }
}

function listAll(): ListRow[] {
  if (_allPagesCache === null) throw new Error("setupBrainCache() not called");
  return _allPagesCache.map((p) => ({
    slug: p.slug,
    type: p.type,
    updated: p.updated_at,
    title: p.title,
  }));
}

function getPage(slug: string): string {
  return _bodyCache.get(slug) ?? "";
}

function parseFrontmatter(raw: string): Record<string, string> {
  // Minimal YAML parser for kos-lint's needs: top-level scalar fields plus
  // the two block-scalar forms (`>-`, `>`, `|`, `|-`) that `gbrain put`
  // emits for long values. Strips YAML surrounding quotes.
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(/^([a-z_]+):\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1];
    let value = mm[2].trim();
    // Block scalar: gather indented continuation lines, join with spaces (fold).
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(value.startsWith("|") ? "\n" : " ");
    }
    // Strip matching quotes.
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

// Check 1: frontmatter required fields present
function check1(rows: ListRow[]): Finding[] {
  const out: Finding[] = [];
  let ok = 0;
  for (const row of rows) {
    const body = getPage(row.slug);
    const fm = parseFrontmatter(body);
    const missing = REQUIRED_FIELDS.filter((f) => !(f in fm));
    if (missing.length > 0) {
      out.push({
        check: 1,
        severity: "ERROR",
        slug: row.slug,
        message: `missing frontmatter fields: ${missing.join(", ")}`,
      });
    } else {
      ok++;
    }
  }
  console.log(`[1] Frontmatter: ${ok}/${rows.length} OK`);
  return out;
}

// Check 2: duplicate id
function check2(rows: ListRow[]): Finding[] {
  const idMap = new Map<string, string[]>();
  for (const row of rows) {
    const body = getPage(row.slug);
    const fm = parseFrontmatter(body);
    const id = fm["id"];
    if (!id) continue;
    const arr = idMap.get(id) ?? [];
    arr.push(row.slug);
    idMap.set(id, arr);
  }
  const out: Finding[] = [];
  let dups = 0;
  for (const [id, slugs] of idMap) {
    if (slugs.length > 1) {
      dups++;
      out.push({
        check: 2,
        severity: "ERROR",
        message: `duplicate id "${id}" on pages: ${slugs.join(", ")}`,
      });
    }
  }
  console.log(`[2] Duplicate ids: ${dups} found`);
  return out;
}

// Check 3: dead internal links (markdown [...](slug.md) pointing nowhere).
// v0.17 sync: try BOTH the dir-prefixed slug (v2 gbrain shape, `sources/foo`)
// AND the flat basename (v1 legacy shape, `foo`) before declaring dead. v1
// wiki imports heavily cross-link via `../sources/foo.md`; the old resolver
// only matched the basename and falsely flagged ~112 dead links.
function candidateSlugs(target: string): string[] {
  // Strip leading `./` and any number of `../`
  const cleaned = target.replace(/^(?:\.\.?\/)+/, "").replace(/\.md$/, "");
  const basename = cleaned.replace(/.*\//, "");
  // Prefer dir-prefixed; fall back to flat basename.
  if (cleaned === basename) return [basename];
  return [cleaned, basename];
}

function check3(rows: ListRow[]): Finding[] {
  const knownSlugs = new Set(rows.map((r) => r.slug));
  const out: Finding[] = [];
  let dead = 0;
  for (const row of rows) {
    const body = getPage(row.slug);
    const re = /\]\(([^)#?]+\.md)(?:#[^)]*)?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const target = m[1];
      if (target.startsWith("http")) continue;
      const candidates = candidateSlugs(target);
      const resolved = candidates.some((s) => knownSlugs.has(s));
      if (!resolved) {
        dead++;
        out.push({
          check: 3,
          severity: "ERROR",
          slug: row.slug,
          message: `dead link → ${target} (tried: ${candidates.join(", ")})`,
        });
      }
    }
  }
  console.log(`[3] Dead links: ${dead} found`);
  return out;
}

// Check 4: orphans — zero inbound backlinks. Reads the inbound-count map
// populated by main() from BrainDb.inboundCounts (one query for the whole
// brain vs per-page `gbrain backlinks` subprocess).
let _inboundMap: Map<string, number> | null = null;
function check4(rows: ListRow[]): Finding[] {
  if (!_inboundMap) throw new Error("inbound map not initialized");
  const out: Finding[] = [];
  let orphans = 0;
  for (const row of rows) {
    if ((_inboundMap.get(row.slug) ?? 0) === 0) {
      orphans++;
      out.push({
        check: 4,
        severity: "WARN",
        slug: row.slug,
        message: "orphan (zero backlinks)",
      });
    }
  }
  console.log(`[4] Orphans: ${orphans} found`);
  return out;
}

// Check 5: weak link budget — Related/See Also > 5 or missing type annotation
function check5(rows: ListRow[]): Finding[] {
  const out: Finding[] = [];
  let weak = 0;
  let overlarge = 0;
  for (const row of rows) {
    const body = getPage(row.slug);
    const sec = body.split(/^##\s+(?:Related|See Also)/m)[1];
    if (!sec) continue;
    const links = sec.match(/\[[^\]]+\]\([^)]+\.md\)/g) ?? [];
    if (links.length > 5) {
      overlarge++;
      out.push({
        check: 5,
        severity: "WARN",
        slug: row.slug,
        message: `too many related links: ${links.length} (budget 5)`,
      });
    }
    for (const line of sec.split("\n")) {
      if (!/\.md\)/.test(line)) continue;
      if (!/supplements|contrasts|implements|extends/i.test(line)) {
        weak++;
      }
    }
  }
  console.log(`[5] Weak links: ${weak} untyped, ${overlarge} over budget`);
  return out;
}

// Check 6: evidence gap — kind demands E2+/E3+ but no evidence tag found
function check6(rows: ListRow[]): Finding[] {
  const threshold: Record<string, number> = {
    concept: 2,
    synthesis: 2,
    comparison: 2,
    decision: 3,
    protocol: 3,
  };
  const out: Finding[] = [];
  let gaps = 0;
  for (const row of rows) {
    const body = getPage(row.slug);
    const fm = parseFrontmatter(body);
    const kind = fm["kind"];
    if (!kind || !(kind in threshold)) continue;
    if (fm["status"] === "draft" || fm["status"] === "deprecated") continue;
    // accept either evidence_summary frontmatter block or inline [E\d]
    const hasFmEvidence = /evidence_summary/i.test(body.slice(0, 500));
    const inline = [...body.matchAll(/\[E(\d)\]/g)].map((m) => Number(m[1]));
    const max = Math.max(-1, ...inline);
    if (!hasFmEvidence && max < threshold[kind]) {
      gaps++;
      out.push({
        check: 6,
        severity: "WARN",
        slug: row.slug,
        message: `kind=${kind} needs E${threshold[kind]}+, found E${max < 0 ? "?" : max}`,
      });
    }
  }
  console.log(`[6] Evidence gaps: ${gaps} found`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const checkArg = args.indexOf("--check");
  const only = checkArg >= 0 ? Number(args[checkArg + 1]) : undefined;

  console.log(`=== kos-lint @ ${new Date().toISOString().slice(0, 10)} ===`);

  const db = new BrainDb();
  await db.open();
  try {
    const allPages = await db.listAllPages();
    setupBrainCache(allPages);
    _inboundMap = await db.inboundCounts();
  } finally {
    await db.close();
  }
  const rows = listAll();

  // Check 3 (dead internal links) is retired from the default sweep when
  // upstream BrainWriter lint is enabled (writer.lint_on_put_page=true).
  // BrainWriter's linkValidator runs on every put_page and covers the same
  // surface with better semantics. Pass --check 3 to force-run it manually.
  const brainWriterLintOn =
    gbrain(["config", "get", "writer.lint_on_put_page"]).trim() === "true";

  // When `--check N` is explicit, run that check regardless of the
  // brainWriterLintOn short-circuit for check 3 (the comment above claims
  // this; the code below now honors it).
  const forceCheck3 = only === 3;
  const runs: [number, (r: ListRow[]) => Finding[]][] = [
    [1, check1],
    [2, check2],
    ...((brainWriterLintOn && !forceCheck3)
      ? []
      : [[3, check3] as [number, (r: ListRow[]) => Finding[]]]),
    [4, check4],
    [5, check5],
    [6, check6],
  ];

  let findings: Finding[] = [];
  for (const [n, fn] of runs) {
    if (only !== undefined && only !== n) continue;
    findings = findings.concat(fn(rows));
  }

  const errors = findings.filter((f) => f.severity === "ERROR").length;
  const warns = findings.filter((f) => f.severity === "WARN").length;

  if (jsonMode) {
    console.log(JSON.stringify({ rows: rows.length, findings, errors, warns }, null, 2));
  } else {
    console.log(`\nSummary: ${errors} ERROR, ${warns} WARN`);
    if (findings.length > 0 && findings.length <= 30) {
      for (const f of findings) {
        console.log(`  [${f.check}] ${f.severity} ${f.slug ?? "-"}: ${f.message}`);
      }
    }
  }

  process.exit(errors > 0 ? 1 : warns > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(3);
});
