#!/usr/bin/env bun
/**
 * evidence-gate/run.ts — evidence-level gate per SKILL.md.
 *
 * Usage:
 *   bun run skills/kos-jarvis/evidence-gate/run.ts check <slug>
 *   bun run skills/kos-jarvis/evidence-gate/run.ts sweep           # all pages
 *   bun run skills/kos-jarvis/evidence-gate/run.ts sweep --kind decision
 *   bun run skills/kos-jarvis/evidence-gate/run.ts ... --json
 *
 * Exit:
 *   0 — all checked pages pass (or bypass via status=draft|deprecated)
 *   1 — at least one page fails the gate
 *   2 — sweep completed but some pages lack evidence_summary (warn-only)
 */
import { BrainDb, type PageRow } from "../_lib/brain-db.ts";

type Level = 0 | 1 | 2 | 3 | 4;
type Kind =
  | "source"
  | "concept"
  | "synthesis"
  | "comparison"
  | "decision"
  | "protocol"
  | "project"
  | "entity"
  | "timeline";

const THRESHOLDS: Partial<Record<Kind, Level>> = {
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

type Finding = {
  slug: string;
  kind: string;
  status: string;
  max_evidence: Level | null;
  threshold: Level | null;
  verdict: "pass" | "fail" | "warn" | "bypass";
  reason: string;
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function maxFromFrontmatter(fm: Record<string, unknown>): Level | null {
  let max: Level | null = null;

  // evidence_summary.primary
  const es = (fm.evidence_summary ?? {}) as Record<string, unknown>;
  if (es && typeof es === "object") {
    const primary = asString(es.primary);
    if (primary) {
      const m = primary.match(/^E([0-4])$/i);
      if (m) max = parseInt(m[1], 10) as Level;
    }
    const claims = es.claims;
    if (Array.isArray(claims)) {
      for (const c of claims) {
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
  }

  // Flat shortcut: some v1 pages carry `evidence: E3` directly
  const flat = asString(fm.evidence);
  if (flat) {
    const m = flat.match(/^E([0-4])$/i);
    if (m) {
      const v = parseInt(m[1], 10) as Level;
      max = max === null || v > max ? v : max;
    }
  }

  return max;
}

function maxFromBody(body: string): Level | null {
  let max: Level | null = null;
  for (const m of body.matchAll(/\[E([0-4])\]/g)) {
    const v = parseInt(m[1], 10) as Level;
    max = max === null || v > max ? v : max;
  }
  return max;
}

function checkRow(row: PageRow): Finding {
  const fm = row.frontmatter;
  const kind = asString(fm.kind) ?? row.type ?? "source";
  const status = asString(fm.status) ?? "active";
  const threshold = THRESHOLDS[kind as Kind];

  if (status === "draft" || status === "deprecated") {
    return {
      slug: row.slug,
      kind,
      status,
      max_evidence: null,
      threshold: threshold ?? null,
      verdict: "bypass",
      reason: `status=${status} (gate bypassed per SKILL.md)`,
    };
  }

  if (threshold === undefined) {
    return {
      slug: row.slug,
      kind,
      status,
      max_evidence: null,
      threshold: null,
      verdict: "warn",
      reason: `unknown kind '${kind}' — no threshold defined`,
    };
  }

  const fmMax = maxFromFrontmatter(fm);
  const bodyMax = maxFromBody(`${row.compiled_truth}\n${row.timeline}`);
  const max =
    fmMax !== null && bodyMax !== null
      ? ((Math.max(fmMax, bodyMax) as unknown) as Level)
      : fmMax ?? bodyMax;

  if (max === null) {
    return {
      slug: row.slug,
      kind,
      status,
      max_evidence: null,
      threshold,
      verdict: "warn",
      reason: `no evidence_summary or [E\\d] inline tags; kind requires ≥ E${threshold}`,
    };
  }

  if (max < threshold) {
    return {
      slug: row.slug,
      kind,
      status,
      max_evidence: max,
      threshold,
      verdict: "fail",
      reason: `max evidence E${max} below kind threshold E${threshold}; upgrade sources or demote kind`,
    };
  }

  return {
    slug: row.slug,
    kind,
    status,
    max_evidence: max,
    threshold,
    verdict: "pass",
    reason: `E${max} ≥ E${threshold}`,
  };
}

function formatText(findings: Finding[], mode: "check" | "sweep"): void {
  const fail = findings.filter((f) => f.verdict === "fail");
  const warn = findings.filter((f) => f.verdict === "warn");
  const bypass = findings.filter((f) => f.verdict === "bypass");
  const pass = findings.filter((f) => f.verdict === "pass");

  console.log(`=== evidence-gate ${mode} ===`);
  console.log(
    `pass=${pass.length} fail=${fail.length} warn=${warn.length} bypass=${bypass.length} total=${findings.length}`
  );

  for (const f of fail.slice(0, 50)) {
    console.log(`  [FAIL] ${f.slug} (kind=${f.kind}): ${f.reason}`);
  }
  if (fail.length > 50) console.log(`  ... and ${fail.length - 50} more [FAIL]`);

  if (mode === "check") {
    for (const f of warn) {
      console.log(`  [WARN] ${f.slug} (kind=${f.kind}): ${f.reason}`);
    }
    for (const f of [...pass, ...bypass]) {
      console.log(`  [${f.verdict.toUpperCase()}] ${f.slug} (kind=${f.kind}): ${f.reason}`);
    }
  } else {
    // sweep — cap warn output
    for (const f of warn.slice(0, 10)) {
      console.log(`  [WARN] ${f.slug} (kind=${f.kind}): ${f.reason}`);
    }
    if (warn.length > 10) console.log(`  ... and ${warn.length - 10} more [WARN]`);

    // By-kind summary
    const byKind = new Map<string, { pass: number; fail: number; warn: number; bypass: number }>();
    for (const f of findings) {
      const k = f.kind;
      if (!byKind.has(k)) byKind.set(k, { pass: 0, fail: 0, warn: 0, bypass: 0 });
      byKind.get(k)![f.verdict]++;
    }
    console.log("\nBy kind:");
    for (const [k, counts] of [...byKind.entries()].sort()) {
      console.log(
        `  ${k.padEnd(12)} pass=${counts.pass} fail=${counts.fail} warn=${counts.warn} bypass=${counts.bypass}`
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const cleanArgv = argv.filter((a) => a !== "--json");
  const cmd = cleanArgv[0];

  if (cmd !== "check" && cmd !== "sweep") {
    console.error(
      "usage:\n" +
        "  evidence-gate check <slug> [--json]\n" +
        "  evidence-gate sweep [--kind <name>] [--json]"
    );
    process.exit(3);
  }

  const db = new BrainDb();
  await db.open();
  try {
    if (cmd === "check") {
      const slug = cleanArgv[1];
      if (!slug) {
        console.error("usage: evidence-gate check <slug>");
        process.exit(3);
      }
      const row = await db.getPage(slug);
      if (!row) {
        console.error(`page not found: ${slug}`);
        process.exit(3);
      }
      const f = checkRow(row);
      if (jsonOut) console.log(JSON.stringify(f, null, 2));
      else formatText([f], "check");
      process.exit(f.verdict === "fail" ? 1 : f.verdict === "warn" ? 2 : 0);
    }

    // sweep
    const kindFlag = cleanArgv.indexOf("--kind");
    const filterKind = kindFlag !== -1 ? cleanArgv[kindFlag + 1] : undefined;
    const rows = await db.listAllPages(filterKind ? { type: filterKind } : undefined);
    const findings = rows.map(checkRow);

    if (jsonOut) {
      console.log(JSON.stringify({ total: findings.length, findings }, null, 2));
    } else {
      formatText(findings, "sweep");
    }

    const hasFail = findings.some((f) => f.verdict === "fail");
    const hasWarn = findings.some((f) => f.verdict === "warn");
    process.exit(hasFail ? 1 : hasWarn ? 2 : 0);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(3);
});
