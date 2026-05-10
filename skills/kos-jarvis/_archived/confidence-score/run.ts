#!/usr/bin/env bun
/**
 * confidence-score/run.ts — score pages high/medium/low per SKILL.md.
 *
 * Usage:
 *   bun run skills/kos-jarvis/confidence-score/run.ts <slug>
 *   bun run skills/kos-jarvis/confidence-score/run.ts sweep [--kind <name>]
 *   ... --json
 *
 * Exit:
 *   0 — scored (or sweep completed)
 *   1 — low-confidence findings (failure to compile) on `--strict`
 *   3 — CLI/argument error
 *
 * Does NOT write frontmatter. Downstream writer skill applies the value
 * (kos-patrol or dikw-compile will consume `--json`).
 */
import { BrainDb, type PageRow } from "../_lib/brain-db.ts";

type Level = 0 | 1 | 2 | 3 | 4;
type Confidence = "high" | "medium" | "low";

type Score = {
  slug: string;
  kind: string;
  status: string;
  confidence: Confidence;
  evidence_max: Level | null;
  backlinks_in: number;
  age_days: number;
  citation_density: number;
  reasons: string[];
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function maxEvidence(row: PageRow): Level | null {
  let max: Level | null = null;
  const fm = row.frontmatter;

  const es = (fm.evidence_summary ?? {}) as Record<string, unknown>;
  const primary = asString(es.primary);
  if (primary) {
    const m = primary.match(/^E([0-4])$/i);
    if (m) max = parseInt(m[1], 10) as Level;
  }
  if (Array.isArray(es.claims)) {
    for (const c of es.claims) {
      if (c && typeof c === "object") {
        const lvl = asString((c as Record<string, unknown>).level);
        const m = lvl?.match(/^E([0-4])$/i);
        if (m) {
          const v = parseInt(m[1], 10) as Level;
          max = max === null || v > max ? v : max;
        }
      }
    }
  }

  const flat = asString(fm.evidence);
  if (flat) {
    const m = flat.match(/^E([0-4])$/i);
    if (m) {
      const v = parseInt(m[1], 10) as Level;
      max = max === null || v > max ? v : max;
    }
  }

  const body = `${row.compiled_truth}\n${row.timeline}`;
  for (const m of body.matchAll(/\[E([0-4])\]/g)) {
    const v = parseInt(m[1], 10) as Level;
    max = max === null || v > max ? v : max;
  }
  return max;
}

function citationDensity(body: string): number {
  // Heuristic: a "paragraph" is a block separated by blank lines and with
  // at least 40 chars of alphanumeric content. A "citation" is any of:
  //   - [E\d] evidence tag
  //   - (http...) inline URL
  //   - [text](path) markdown link
  //   - [[wiki-link]] wikilink
  //   - [^refname] footnote reference
  const paragraphs = body
    .split(/\n\s*\n/)
    .filter((p) => p.replace(/\s+/g, "").length >= 40);
  if (paragraphs.length === 0) return 0;

  let citations = 0;
  for (const p of paragraphs) {
    const patterns = [
      /\[E[0-4]\]/g,
      /\(https?:\/\/[^)]+\)/g,
      /\[[^\]]+\]\([^)]+\)/g,
      /\[\[[^\]]+\]\]/g,
      /\[\^[^\]]+\]/g,
    ];
    for (const re of patterns) {
      const m = p.match(re);
      if (m) citations += m.length;
    }
  }
  return citations / paragraphs.length;
}

function ageDays(updated_at: string): number {
  const d = new Date(updated_at);
  if (isNaN(d.getTime())) return 9999;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function scoreRow(
  row: PageRow,
  inbound: number
): Score {
  const fm = row.frontmatter;
  const kind = asString(fm.kind) ?? row.type ?? "source";
  const status = asString(fm.status) ?? "active";
  const e = maxEvidence(row);
  const age = ageDays(row.updated_at);
  const body = `${row.compiled_truth}\n${row.timeline}`;
  const dens = citationDensity(body);

  const reasons: string[] = [];
  let conf: Confidence = "low";

  const highOK =
    e !== null && e >= 3 && inbound >= 2 && age <= 90 && dens >= 0.5;
  const mediumOK = e !== null && e >= 2 && inbound >= 1 && age <= 180;

  if (highOK) {
    conf = "high";
    reasons.push(`E${e}≥E3 ✓`, `inbound=${inbound}≥2 ✓`, `age=${age}d≤90 ✓`, `density=${dens.toFixed(2)}≥0.5 ✓`);
  } else if (mediumOK) {
    conf = "medium";
    reasons.push(`E${e}≥E2 ✓`, `inbound=${inbound}≥1 ✓`, `age=${age}d≤180 ✓`);
    if (e !== null && e < 3) reasons.push(`E${e}<E3 (blocks high)`);
    if (inbound < 2) reasons.push(`inbound=${inbound}<2 (blocks high)`);
    if (age > 90) reasons.push(`age=${age}d>90 (blocks high)`);
    if (dens < 0.5) reasons.push(`density=${dens.toFixed(2)}<0.5 (blocks high)`);
  } else {
    if (e === null) reasons.push("no evidence tags");
    else if (e < 2) reasons.push(`E${e}<E2 (blocks medium)`);
    if (inbound < 1) reasons.push(`inbound=${inbound}<1 (blocks medium)`);
    if (age > 180) reasons.push(`age=${age}d>180 (blocks medium)`);
  }

  return {
    slug: row.slug,
    kind,
    status,
    confidence: conf,
    evidence_max: e,
    backlinks_in: inbound,
    age_days: age,
    citation_density: Number(dens.toFixed(3)),
    reasons,
  };
}

function formatText(scores: Score[], mode: "single" | "sweep"): void {
  if (mode === "single") {
    const s = scores[0];
    console.log(`=== confidence-score: ${s.slug} ===`);
    console.log(`confidence:      ${s.confidence}`);
    console.log(`evidence_max:    ${s.evidence_max === null ? "none" : `E${s.evidence_max}`}`);
    console.log(`backlinks_in:    ${s.backlinks_in}`);
    console.log(`age_days:        ${s.age_days}`);
    console.log(`citation_density: ${s.citation_density}`);
    console.log(`reasons: ${s.reasons.join("; ")}`);
    return;
  }

  const high = scores.filter((s) => s.confidence === "high").length;
  const medium = scores.filter((s) => s.confidence === "medium").length;
  const low = scores.filter((s) => s.confidence === "low").length;

  console.log(`=== confidence-score sweep ===`);
  console.log(`total=${scores.length} high=${high} medium=${medium} low=${low}`);

  const byKind = new Map<string, { high: number; medium: number; low: number }>();
  for (const s of scores) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, { high: 0, medium: 0, low: 0 });
    byKind.get(s.kind)![s.confidence]++;
  }
  console.log("\nBy kind:");
  for (const [k, c] of [...byKind.entries()].sort()) {
    const total = c.high + c.medium + c.low;
    console.log(`  ${k.padEnd(12)} high=${c.high} medium=${c.medium} low=${c.low}  (total=${total})`);
  }

  const topHigh = scores.filter((s) => s.confidence === "high").slice(0, 5);
  if (topHigh.length > 0) {
    console.log("\nHigh-confidence sample:");
    for (const s of topHigh) console.log(`  ${s.slug} (kind=${s.kind}, E${s.evidence_max}, ${s.backlinks_in}←, ${s.age_days}d)`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const strict = argv.includes("--strict");
  const cleanArgv = argv.filter((a) => a !== "--json" && a !== "--strict");

  const db = new BrainDb();
  await db.open();
  try {
    if (cleanArgv[0] === "sweep") {
      const kindFlag = cleanArgv.indexOf("--kind");
      const filterKind = kindFlag !== -1 ? cleanArgv[kindFlag + 1] : undefined;
      const rows = await db.listAllPages(filterKind ? { type: filterKind } : undefined);
      const inboundMap = await db.inboundCounts();
      const scores = rows.map((r) => scoreRow(r, inboundMap.get(r.slug) ?? 0));

      if (jsonOut) {
        console.log(JSON.stringify({ total: scores.length, scores }, null, 2));
      } else {
        formatText(scores, "sweep");
      }
      const lowCount = scores.filter((s) => s.confidence === "low").length;
      process.exit(strict && lowCount > 0 ? 1 : 0);
    }

    const slug = cleanArgv[0];
    if (!slug) {
      console.error("usage:\n  confidence-score <slug> [--json]\n  confidence-score sweep [--kind <name>] [--json] [--strict]");
      process.exit(3);
    }
    const row = await db.getPage(slug);
    if (!row) {
      console.error(`page not found: ${slug}`);
      process.exit(3);
    }
    const inboundMap = await db.inboundCounts();
    const score = scoreRow(row, inboundMap.get(slug) ?? 0);
    if (jsonOut) console.log(JSON.stringify(score, null, 2));
    else formatText([score], "single");
    process.exit(strict && score.confidence === "low" ? 1 : 0);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(3);
});
