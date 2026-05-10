/**
 * slug-normalize — one-shot slug normalization for Step 1.5 of the
 * filesystem-canonical migration.
 *
 * Reads its truth from the NORMALIZATIONS + BODY_REWRITES constants
 * below. Three modes: --plan (read-only preview), --apply (transactional
 * UPDATE), --verify (post-apply inspection). Idempotent: re-running
 * --apply after completion reports "nothing to do" and exits 0.
 *
 * See SKILL.md (same dir) for safety protocol. Never run --apply
 * without first `launchctl disable`-ing the 5 DB-writing services
 * and taking a fresh rolling backup.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DB_PATH = `${homedir()}/.gbrain/brain.pglite`;
const REPORT_DIR = `${homedir()}/brain/.agent/reports`;

// ── Truth table ───────────────────────────────────────────────────

type SlugRename = {
  old_slug: string;
  new_slug: string;
  expected_id: string; // assertion that this is the page we think
};

/**
 * The 7 root-level stray pages. Verified empirically via probe
 * scripts before hand-encoding. id stays in kind-topic form
 * (matches 886/1829 pages using this shape, including all people/
 * companies/syntheses/comparisons).
 */
const NORMALIZATIONS: SlugRename[] = [
  {
    old_slug: "ai-jarvis",
    new_slug: "concepts/ai-jarvis",
    expected_id: "concept-ai-jarvis",
  },
  {
    old_slug: "github-com-aloshdenny-reverse-synthid",
    new_slug: "sources/github-com-aloshdenny-reverse-synthid",
    expected_id: "source-github-com-aloshdenny-reverse-synthid",
  },
  {
    old_slug: "arxiv-org-abs-2604-15034",
    new_slug: "sources/arxiv-org-abs-2604-15034",
    expected_id: "source-arxiv-org-abs-2604-15034",
  },
  {
    old_slug: "x-com-omarsar0-status-2045241905227915498",
    new_slug: "sources/x-com-omarsar0-status-2045241905227915498",
    expected_id: "source-x-com-omarsar0-status-2045241905227915498",
  },
  {
    old_slug: "colossus-com-article-inside-notion",
    new_slug: "sources/colossus-com-article-inside-notion",
    expected_id: "source-colossus-com-article-inside-notion",
  },
  {
    old_slug: "ingest-1776470181089",
    new_slug: "sources/ingest-1776470181089",
    expected_id: "source-ingest-1776470181089",
  },
  {
    old_slug: "www-anthropic-com-news-claude-opus-4-5",
    new_slug: "sources/www-anthropic-com-news-claude-opus-4-5",
    expected_id: "source-www-anthropic-com-news-claude-opus-4-5",
  },
];

/**
 * One known intra-brain compiled_truth reference that must be updated
 * to match the new slug path. Scoped narrowly via a literal substring
 * match: wrap in `](` and `.md)` to avoid collateral damage.
 */
type BodyRewrite = {
  find: string;
  replace: string;
  reason: string;
};

const BODY_REWRITES: BodyRewrite[] = [
  {
    find: "](www-anthropic-com-news-claude-opus-4-5.md)",
    replace: "](sources/www-anthropic-com-news-claude-opus-4-5.md)",
    reason: "rewire md-link to the page whose slug is being renamed",
  },
];

// ── Mode dispatch ─────────────────────────────────────────────────

type Mode = "plan" | "apply" | "verify" | "help";

function parseMode(argv: string[]): Mode {
  if (argv.includes("--plan")) return "plan";
  if (argv.includes("--apply")) return "apply";
  if (argv.includes("--verify")) return "verify";
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  return "help";
}

function printHelp(): void {
  console.log(`slug-normalize — KOS Step 1.5 slug normalization

Usage:
  bun run slug-normalize/run.ts --plan      # preview (read-only)
  bun run slug-normalize/run.ts --apply     # transactional UPDATE
  bun run slug-normalize/run.ts --verify    # post-apply assertions

See SKILL.md (same dir) for the mandatory safety protocol before --apply.`);
}

// ── Plan ──────────────────────────────────────────────────────────

type PlanEntry = {
  op: "slug_rename" | "body_rewrite";
  old_slug?: string;
  new_slug?: string;
  id_matches?: boolean;
  old_slug_present?: boolean;
  new_slug_conflict?: boolean;
  find?: string;
  replace?: string;
  target_pages?: { slug: string; id: number }[];
};

async function readPagesContaining(
  db: PGlite,
  needle: string,
): Promise<{ slug: string; id: number }[]> {
  const { rows } = await db.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE compiled_truth LIKE $1 ORDER BY slug`,
    [`%${needle.replace(/%/g, "\\%")}%`],
  );
  return rows;
}

async function buildPlan(db: PGlite): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = [];

  // Rename checks
  for (const r of NORMALIZATIONS) {
    const { rows: oldRows } = await db.query<{
      id: number;
      frontmatter: Record<string, unknown> | string;
    }>(`SELECT id, frontmatter FROM pages WHERE slug = $1`, [r.old_slug]);
    const { rows: newRows } = await db.query<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`,
      [r.new_slug],
    );

    let idMatches = false;
    if (oldRows.length === 1) {
      const fm =
        typeof oldRows[0].frontmatter === "string"
          ? JSON.parse(oldRows[0].frontmatter as string)
          : oldRows[0].frontmatter;
      idMatches = (fm as Record<string, unknown>)?.id === r.expected_id;
    }

    plan.push({
      op: "slug_rename",
      old_slug: r.old_slug,
      new_slug: r.new_slug,
      id_matches: idMatches,
      old_slug_present: oldRows.length === 1,
      new_slug_conflict: newRows.length > 0,
    });
  }

  // Body rewrite checks
  for (const b of BODY_REWRITES) {
    const hits = await readPagesContaining(db, b.find);
    plan.push({
      op: "body_rewrite",
      find: b.find,
      replace: b.replace,
      target_pages: hits,
    });
  }

  return plan;
}

function planIsClean(plan: PlanEntry[]): { clean: boolean; issues: string[] } {
  const issues: string[] = [];
  let allIdempotent = true;
  for (const e of plan) {
    if (e.op === "slug_rename") {
      if (!e.old_slug_present && !e.new_slug_conflict) {
        // old gone, new absent too? data went missing.
        issues.push(
          `rename ${e.old_slug} → ${e.new_slug}: neither old nor new slug exists`,
        );
        allIdempotent = false;
      }
      if (e.old_slug_present && e.new_slug_conflict) {
        issues.push(
          `rename ${e.old_slug} → ${e.new_slug}: BOTH exist, would collide`,
        );
      }
      if (e.old_slug_present && !e.id_matches) {
        issues.push(
          `rename ${e.old_slug}: page exists but frontmatter.id doesn't match expected (${e.old_slug})`,
        );
      }
    }
  }
  // If everything is in the idempotent post-apply state (old absent, new present), that's also clean.
  return { clean: issues.length === 0 && allIdempotent, issues };
}

// ── Apply ─────────────────────────────────────────────────────────

type ApplyResult = {
  ts: string;
  renames_done: number;
  renames_skipped_already_applied: number;
  body_rewrites_done: number;
  body_rewrites_skipped: number;
  total_pages_before: number;
  total_pages_after: number;
  details: string[];
};

async function runApply(db: PGlite): Promise<ApplyResult> {
  const result: ApplyResult = {
    ts: new Date().toISOString(),
    renames_done: 0,
    renames_skipped_already_applied: 0,
    body_rewrites_done: 0,
    body_rewrites_skipped: 0,
    total_pages_before: 0,
    total_pages_after: 0,
    details: [],
  };

  const before = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages`,
  );
  result.total_pages_before = Number(before.rows[0].n);

  await db.query(`BEGIN`);
  try {
    for (const r of NORMALIZATIONS) {
      // Pre-check idempotent state
      const { rows: oldRows } = await db.query<{ id: number }>(
        `SELECT id FROM pages WHERE slug = $1`,
        [r.old_slug],
      );
      const { rows: newRows } = await db.query<{ id: number }>(
        `SELECT id FROM pages WHERE slug = $1`,
        [r.new_slug],
      );
      if (oldRows.length === 0 && newRows.length === 1) {
        result.renames_skipped_already_applied++;
        result.details.push(
          `SKIP  ${r.old_slug} → ${r.new_slug}  (already applied)`,
        );
        continue;
      }
      if (oldRows.length === 1 && newRows.length === 1) {
        throw new Error(
          `COLLISION both ${r.old_slug} and ${r.new_slug} exist; aborting`,
        );
      }
      if (oldRows.length !== 1) {
        throw new Error(`UNEXPECTED ${r.old_slug} rows=${oldRows.length}`);
      }

      const { affectedRows } = await db.query(
        `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2`,
        [r.new_slug, r.old_slug],
      );
      if (affectedRows !== 1) {
        throw new Error(
          `UPDATE ${r.old_slug} → ${r.new_slug} affected ${affectedRows} rows (expected 1)`,
        );
      }
      result.renames_done++;
      result.details.push(`RENAME ${r.old_slug} → ${r.new_slug}`);
    }

    for (const b of BODY_REWRITES) {
      const { rows: hits } = await db.query<{ id: number; slug: string }>(
        `SELECT id, slug FROM pages WHERE compiled_truth LIKE $1`,
        [`%${b.find.replace(/%/g, "\\%")}%`],
      );
      if (hits.length === 0) {
        result.body_rewrites_skipped++;
        result.details.push(`SKIP-BODY no pages contain ${b.find}`);
        continue;
      }
      for (const h of hits) {
        const { affectedRows } = await db.query(
          `UPDATE pages
             SET compiled_truth = REPLACE(compiled_truth, $1, $2),
                 updated_at = now()
             WHERE id = $3`,
          [b.find, b.replace, h.id],
        );
        if (affectedRows !== 1) {
          throw new Error(
            `body REPLACE on ${h.slug} affected ${affectedRows} rows (expected 1)`,
          );
        }
        result.body_rewrites_done++;
        result.details.push(`BODY-REWRITE ${h.slug} ${b.find} → ${b.replace}`);
      }
    }

    await db.query(`COMMIT`);
  } catch (err) {
    await db.query(`ROLLBACK`);
    throw err;
  }

  const after = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages`,
  );
  result.total_pages_after = Number(after.rows[0].n);

  if (result.total_pages_after !== result.total_pages_before) {
    throw new Error(
      `page count drift: ${result.total_pages_before} → ${result.total_pages_after}`,
    );
  }

  return result;
}

// ── Verify ────────────────────────────────────────────────────────

type VerifyResult = {
  ok: boolean;
  checks: { name: string; pass: boolean; note?: string }[];
};

async function runVerify(db: PGlite): Promise<VerifyResult> {
  const checks: { name: string; pass: boolean; note?: string }[] = [];

  for (const r of NORMALIZATIONS) {
    const { rows: oldRows } = await db.query(
      `SELECT 1 FROM pages WHERE slug = $1`,
      [r.old_slug],
    );
    checks.push({
      name: `old_slug_absent::${r.old_slug}`,
      pass: oldRows.length === 0,
      note: oldRows.length === 0 ? undefined : "old slug still present",
    });
    const { rows: newRows } = await db.query(
      `SELECT 1 FROM pages WHERE slug = $1`,
      [r.new_slug],
    );
    checks.push({
      name: `new_slug_present::${r.new_slug}`,
      pass: newRows.length === 1,
      note: newRows.length === 1 ? undefined : `new slug rows=${newRows.length}`,
    });
  }

  for (const b of BODY_REWRITES) {
    const { rows: stillOld } = await db.query<{ slug: string }>(
      `SELECT slug FROM pages WHERE compiled_truth LIKE $1`,
      [`%${b.find.replace(/%/g, "\\%")}%`],
    );
    checks.push({
      name: `body_rewrite_applied::${b.find}`,
      pass: stillOld.length === 0,
      note:
        stillOld.length === 0
          ? undefined
          : `still present in: ${stillOld.map((r) => r.slug).join(", ")}`,
    });
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
  };
}

// ── Report writing ────────────────────────────────────────────────

function writeReport(result: ApplyResult): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = result.ts.slice(0, 10);
  const file = join(REPORT_DIR, `slug-normalize-${date}.md`);
  const lines: string[] = [
    `# slug-normalize report — ${date}`,
    ``,
    `_Generated: ${result.ts}_`,
    ``,
    `## Summary`,
    ``,
    `- Slug renames: ${result.renames_done} done, ${result.renames_skipped_already_applied} skipped-already-applied`,
    `- Body rewrites: ${result.body_rewrites_done} done, ${result.body_rewrites_skipped} skipped`,
    `- Total pages: ${result.total_pages_before} → ${result.total_pages_after}`,
    ``,
    `## Details`,
    ``,
    "```",
    ...result.details,
    "```",
    ``,
    `## Next step`,
    ``,
    `Run \`bun run skills/kos-jarvis/slug-normalize/run.ts --verify\` to confirm the DB state.`,
    ``,
  ];
  writeFileSync(file, lines.join("\n"));
  return file;
}

// ── Entry ─────────────────────────────────────────────────────────

async function main() {
  const mode = parseMode(process.argv.slice(2));

  if (mode === "help") {
    printHelp();
    process.exit(0);
  }

  const db = await PGlite.create({
    dataDir: `file://${DEFAULT_DB_PATH}`,
    extensions: { vector, pg_trgm },
  });
  try {
    if (mode === "plan") {
      const plan = await buildPlan(db);
      const check = planIsClean(plan);
      console.log(JSON.stringify({ plan, check }, null, 2));
      process.exit(check.clean ? 0 : 1);
    }

    if (mode === "apply") {
      const plan = await buildPlan(db);
      const check = planIsClean(plan);
      if (check.issues.length > 0) {
        console.error("plan has blocking issues:");
        for (const i of check.issues) console.error(`  ${i}`);
        process.exit(1);
      }
      const result = await runApply(db);
      const report = writeReport(result);
      console.log(
        `apply ok: ${result.renames_done} renames, ${result.body_rewrites_done} body rewrites.`,
      );
      console.log(`report: ${report}`);
      process.exit(0);
    }

    if (mode === "verify") {
      const v = await runVerify(db);
      console.log(JSON.stringify(v, null, 2));
      process.exit(v.ok ? 0 : 2);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(3);
});
