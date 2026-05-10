/**
 * Step 1.6 — markdown round-trip sanity check.
 *
 * Iterates every DB page, runs it through the upstream
 * serializeMarkdown → parseMarkdown pair, and asserts that the
 * KOS-critical fields (kind / status / confidence / source_of_truth /
 * owners) survive the round-trip. This is the cheap, DB-risk-free
 * version of "export → re-import into throwaway PGLite → diff" —
 * same invariant, same upstream code paths, no DB writes.
 *
 * Why not full export+import: `gbrain import` has no --path override,
 * so a throwaway DB requires swapping ~/.gbrain/config.json and
 * disabling all DB-writing services for the full window. Round-trip
 * over the same pure functions gives us equivalent confidence.
 *
 * Exit codes:
 *   0 — every page round-trips cleanly
 *   1 — one or more pages lost fields; details printed
 *   2 — unexpected runtime error
 */
import { BrainDb } from "../_lib/brain-db.ts";
import {
  serializeMarkdown,
  parseMarkdown,
} from "../../../src/core/markdown.ts";

type FieldDiff = {
  slug: string;
  field: string;
  before: unknown;
  after: unknown;
};

const CRITICAL_FIELDS = [
  "kind",
  "status",
  "confidence",
  "source_of_truth",
  "owners",
  "evidence_summary",
  "source_refs",
  "related",
  "aliases",
  "id",
] as const;

function normalize(v: unknown): unknown {
  // YAML round-trip may subtly re-shape arrays and strings — normalize
  // for comparison. Null/undefined are equivalent here (both mean absent).
  if (v === null || v === undefined) return null;
  return v;
}

function compareFields(
  slug: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const f of CRITICAL_FIELDS) {
    const b = normalize(before[f]);
    const a = normalize(after[f]);
    const bs = JSON.stringify(b);
    const as = JSON.stringify(a);
    if (bs !== as) {
      diffs.push({ slug, field: f, before: b, after: a });
    }
  }
  return diffs;
}

async function main() {
  const db = new BrainDb();
  await db.open();

  try {
    const pages = await db.listAllPages();
    console.log(`round-trip check on ${pages.length} pages...`);

    let ok = 0;
    let failed = 0;
    const allDiffs: FieldDiff[] = [];
    const byField: Record<string, number> = {};

    for (const p of pages) {
      const tags = Array.isArray(p.frontmatter?.tags)
        ? (p.frontmatter.tags as string[])
        : [];
      const fm = { ...p.frontmatter };
      // serializeMarkdown merges type/title/tags from meta; strip from frontmatter to avoid duplication
      delete fm.type;
      delete fm.title;
      delete fm.tags;
      delete fm.slug;

      const md = serializeMarkdown(fm, p.compiled_truth, p.timeline, {
        type: p.type as any,
        title: p.title,
        tags,
      });

      const { frontmatter: parsedFm } = parseMarkdown(md);

      const diffs = compareFields(p.slug, fm, parsedFm);
      if (diffs.length === 0) {
        ok++;
      } else {
        failed++;
        allDiffs.push(...diffs);
        for (const d of diffs) {
          byField[d.field] = (byField[d.field] || 0) + 1;
        }
      }
    }

    console.log(`\n=== summary ===`);
    console.log(`  ok:     ${ok}`);
    console.log(`  failed: ${failed}`);
    console.log(`  total:  ${pages.length}`);

    if (Object.keys(byField).length > 0) {
      console.log(`\n=== diffs by field ===`);
      for (const [f, n] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${f}: ${n}`);
      }
    }

    if (allDiffs.length > 0) {
      console.log(`\n=== first 10 diffs ===`);
      for (const d of allDiffs.slice(0, 10)) {
        console.log(
          `  [${d.slug}] ${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
        );
      }
    }

    process.exit(failed === 0 ? 0 : 1);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(2);
});
