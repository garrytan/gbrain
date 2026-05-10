#!/usr/bin/env bun
/**
 * dikw-compile/run.ts — grade how well a source has been compiled.
 *
 * v1 scope: **analysis-only**. Grades existing compile state per SKILL.md
 * Phase 5 rubric. Does NOT propose or write new links — that's Phase 2/4
 * territory requiring Haiku classification + mutation, deferred as a
 * next-session extension (see TODO.md "orphan reducer" for the mutation
 * pattern this will reuse).
 *
 * Usage:
 *   bun run skills/kos-jarvis/dikw-compile/run.ts grade <slug>
 *   bun run skills/kos-jarvis/dikw-compile/run.ts sweep [--kind source]
 *   ... --json
 *
 * Exit:
 *   0 — graded cleanly
 *   1 — sweep found ≥1 F (fails evidence-gate) with --strict
 *   3 — CLI error
 */
import { BrainDb, type PageRow } from "../_lib/brain-db.ts";

type StrongType = "supplements" | "contrasts" | "implements" | "extends";
const STRONG_TYPES = new Set<string>(["supplements", "contrasts", "implements", "extends"]);

// Link types the v0.12.0+ upstream auto-linker emits. Treated as weak
// signals until reclassified by dikw-compile agent run.
const WEAK_TYPES = new Set<string>(["mentions", "related_to"]);

type Grade = "A" | "B" | "C" | "F";

type Scorecard = {
  slug: string;
  kind: string;
  status: string;
  evidence_gate: "pass" | "fail" | "warn" | "bypass" | "unknown";
  outgoing: {
    strong: number;
    weak: number;
    by_type: Record<string, number>;
  };
  strong_targets_by_kind: Record<string, number>; // counts of strong targets by downstream kind
  grade: Grade;
  reasons: string[];
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function outgoingLinks(
  db: BrainDb,
  slug: string
): Promise<{ to_slug: string; to_type: string; link_type: string }[]> {
  return db.query<{ to_slug: string; to_type: string; link_type: string }>(
    `SELECT p2.slug AS to_slug, p2.type AS to_type, l.link_type
     FROM pages p1
     JOIN links l ON l.from_page_id = p1.id
     JOIN pages p2 ON p2.id = l.to_page_id
     WHERE p1.slug = $1`,
    [slug]
  );
}

function evidenceGateStatus(row: PageRow): "pass" | "fail" | "warn" | "bypass" | "unknown" {
  const kind = asString(row.frontmatter.kind) ?? row.type ?? "source";
  const status = asString(row.frontmatter.status) ?? "active";
  if (status === "draft" || status === "deprecated") return "bypass";

  const THRESH: Record<string, number> = {
    source: 1,
    concept: 2,
    synthesis: 2,
    comparison: 2,
    decision: 3,
    protocol: 3,
    project: 1,
    entity: 1,
    timeline: 1,
  };
  const threshold = THRESH[kind];
  if (threshold === undefined) return "unknown";

  let max: number | null = null;
  const fm = row.frontmatter;
  const es = (fm.evidence_summary ?? {}) as Record<string, unknown>;
  const primary = asString(es.primary);
  if (primary) {
    const m = primary.match(/^E([0-4])$/i);
    if (m) max = parseInt(m[1], 10);
  }
  const flat = asString(fm.evidence);
  if (flat) {
    const m = flat.match(/^E([0-4])$/i);
    if (m) {
      const v = parseInt(m[1], 10);
      max = max === null || v > max ? v : max;
    }
  }
  const body = `${row.compiled_truth}\n${row.timeline}`;
  for (const m of body.matchAll(/\[E([0-4])\]/g)) {
    const v = parseInt(m[1], 10);
    max = max === null || v > max ? v : max;
  }
  if (max === null) return "warn";
  return max >= threshold ? "pass" : "fail";
}

async function gradeSource(
  db: BrainDb,
  row: PageRow
): Promise<Scorecard> {
  const kind = asString(row.frontmatter.kind) ?? row.type ?? "source";
  const status = asString(row.frontmatter.status) ?? "active";

  const links = await outgoingLinks(db, row.slug);
  const byType: Record<string, number> = {};
  for (const l of links) byType[l.link_type] = (byType[l.link_type] ?? 0) + 1;

  const strongLinks = links.filter((l) => STRONG_TYPES.has(l.link_type));
  const weakLinks = links.filter((l) => WEAK_TYPES.has(l.link_type));

  const strongByKind: Record<string, number> = {};
  for (const l of strongLinks) {
    strongByKind[l.to_type] = (strongByKind[l.to_type] ?? 0) + 1;
  }

  const gate = evidenceGateStatus(row);

  const reasons: string[] = [];
  let grade: Grade;

  if (gate === "fail") {
    grade = "F";
    reasons.push(`evidence-gate FAIL (kind=${kind} below threshold)`);
  } else if (strongLinks.length >= 3) {
    const hasSynthDecision =
      (strongByKind.synthesis ?? 0) + (strongByKind.decision ?? 0) >= 1;
    if (hasSynthDecision) {
      grade = "A";
      reasons.push(
        `${strongLinks.length} strong links; ≥1 synthesis/decision downstream (kind-mix: ${JSON.stringify(strongByKind)})`
      );
    } else {
      grade = "B";
      reasons.push(
        `${strongLinks.length} strong links but no synthesis/decision downstream (blocks A)`
      );
    }
  } else if (strongLinks.length >= 1) {
    grade = "B";
    reasons.push(`${strongLinks.length} strong link(s)`);
  } else if (weakLinks.length >= 1) {
    grade = "C";
    reasons.push(
      `only weak links (${weakLinks.length} total: ${Object.entries(byType).filter(([t]) => WEAK_TYPES.has(t)).map(([t, n]) => `${t}:${n}`).join(", ")}); no strong compilation yet`
    );
  } else {
    grade = "F";
    reasons.push("no outgoing links at all");
  }

  return {
    slug: row.slug,
    kind,
    status,
    evidence_gate: gate,
    outgoing: {
      strong: strongLinks.length,
      weak: weakLinks.length,
      by_type: byType,
    },
    strong_targets_by_kind: strongByKind,
    grade,
    reasons,
  };
}

function formatText(cards: Scorecard[], mode: "single" | "sweep"): void {
  if (mode === "single") {
    const c = cards[0];
    console.log(`=== dikw-compile grade: ${c.slug} ===`);
    console.log(`kind:            ${c.kind}`);
    console.log(`status:          ${c.status}`);
    console.log(`evidence_gate:   ${c.evidence_gate}`);
    console.log(`outgoing.strong: ${c.outgoing.strong}`);
    console.log(`outgoing.weak:   ${c.outgoing.weak}`);
    console.log(`by_type:         ${JSON.stringify(c.outgoing.by_type)}`);
    console.log(`strong_by_kind:  ${JSON.stringify(c.strong_targets_by_kind)}`);
    console.log(`grade:           ${c.grade}`);
    console.log(`reasons: ${c.reasons.join("; ")}`);
    return;
  }

  const byGrade = { A: 0, B: 0, C: 0, F: 0 } as Record<Grade, number>;
  for (const c of cards) byGrade[c.grade]++;

  const totalStrong = cards.reduce((s, c) => s + c.outgoing.strong, 0);
  const totalWeak = cards.reduce((s, c) => s + c.outgoing.weak, 0);
  const compilationRate = cards.length > 0 ? (byGrade.A + byGrade.B) / cards.length : 0;

  console.log(`=== dikw-compile sweep ===`);
  console.log(`total=${cards.length}`);
  console.log(`A=${byGrade.A}  B=${byGrade.B}  C=${byGrade.C}  F=${byGrade.F}`);
  console.log(`compilation_rate = (A+B) / total = ${(compilationRate * 100).toFixed(1)}%`);
  console.log(`total strong links: ${totalStrong}`);
  console.log(`total weak links:   ${totalWeak}`);

  const byKind = new Map<string, Record<Grade, number>>();
  for (const c of cards) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, { A: 0, B: 0, C: 0, F: 0 });
    byKind.get(c.kind)![c.grade]++;
  }
  console.log("\nBy kind:");
  for (const [k, g] of [...byKind.entries()].sort()) {
    const total = g.A + g.B + g.C + g.F;
    console.log(`  ${k.padEnd(12)} A=${g.A} B=${g.B} C=${g.C} F=${g.F}  (total=${total})`);
  }

  const graded = cards.filter((c) => c.grade === "A" || c.grade === "B");
  if (graded.length > 0) {
    console.log("\nCompiled (A/B) sample:");
    for (const c of graded.slice(0, 5))
      console.log(`  ${c.grade} ${c.slug} strong=${c.outgoing.strong}`);
  } else {
    console.log("\nNOTE: zero A/B grades — brain has no `supplements|contrasts|implements|extends` links yet.");
    console.log("      v0.12+ upstream auto-linker only emits `mentions|related_to` (both weak).");
    console.log("      Strong links require an agent-driven compile pass (future Haiku classifier).");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const strict = argv.includes("--strict");
  const cleanArgv = argv.filter((a) => a !== "--json" && a !== "--strict");
  const cmd = cleanArgv[0];

  if (cmd !== "grade" && cmd !== "sweep") {
    console.error(
      "usage:\n" +
        "  dikw-compile grade <slug> [--json]\n" +
        "  dikw-compile sweep [--kind source] [--json] [--strict]"
    );
    process.exit(3);
  }

  const db = new BrainDb();
  await db.open();
  try {
    if (cmd === "grade") {
      const slug = cleanArgv[1];
      if (!slug) {
        console.error("usage: dikw-compile grade <slug>");
        process.exit(3);
      }
      const row = await db.getPage(slug);
      if (!row) {
        console.error(`page not found: ${slug}`);
        process.exit(3);
      }
      const card = await gradeSource(db, row);
      if (jsonOut) console.log(JSON.stringify(card, null, 2));
      else formatText([card], "single");
      process.exit(strict && card.grade === "F" ? 1 : 0);
    }

    // sweep
    const kindFlag = cleanArgv.indexOf("--kind");
    const filterKind =
      kindFlag !== -1 ? cleanArgv[kindFlag + 1] : "source"; // default to source pages
    const rows = await db.listAllPages({ type: filterKind });
    const cards: Scorecard[] = [];
    for (const row of rows) {
      cards.push(await gradeSource(db, row));
    }
    if (jsonOut) {
      console.log(JSON.stringify({ total: cards.length, cards }, null, 2));
    } else {
      formatText(cards, "sweep");
    }
    const hasF = cards.some((c) => c.grade === "F");
    process.exit(strict && hasF ? 1 : 0);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(3);
});
