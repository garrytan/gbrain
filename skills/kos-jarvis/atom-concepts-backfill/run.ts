#!/usr/bin/env bun
/**
 * atom-concepts-backfill/run.ts — stamp `frontmatter.concepts` onto atom
 * pages so upstream `synthesize_concepts` has material to cluster.
 *
 * WHY (upstream gap, found 2026-06-11): synthesize-concepts.ts's header
 * documents that extract_atoms is supposed to stamp `concepts:` on each
 * atom ("when the Haiku 3-check from extract_atoms decides 'this atom is
 * about concept X', it stamps the field") and :92 consumes ONLY that
 * field — but extract-atoms.ts never writes it. Every page-derived atom
 * therefore skips concept synthesis forever ("no atoms with concept
 * refs"). This script is the fork-side bridge until the upstream fix
 * lands; it is idempotent (only touches atoms LACKING the field) and the
 * stamped shape matches what upstream synthesize_concepts consumes, so
 * nothing here needs re-running after the upstream fix.
 *
 * Labeling contract (mirrors synthesize-concepts.ts semantics):
 *   - `concepts` = 1-3 kebab-case English topic labels per atom.
 *   - Labels are a SHARED vocabulary: synthesize_concepts only materializes
 *     a concept page when >=2 atoms share a label (T3), so the prompt
 *     passes the running vocabulary and instructs reuse-over-coinage.
 *   - Concept pages land at `concepts/<label>` — keep labels topic-shaped
 *     (e.g. "wifi-roaming"), not entity-shaped ("tp-link").
 *
 * Model: KOS_CONCEPTS_MODEL env override, default claude-sonnet-4-6
 * (upstream design called for Haiku; Lucien's 2026-06-09 routing upgrades
 * haiku-class tasks to sonnet).
 *
 * Env: bun auto-loads repo .env.local (ANTHROPIC_API_KEY + _BASE_URL via
 * the crs proxy) when run from the repo root. CAVEAT: a pre-set
 * ANTHROPIC_BASE_URL in the calling shell (Claude Code injects one) wins
 * over .env.local and breaks the key/base pairing — run with it unset.
 *
 * Usage:
 *   bun run skills/kos-jarvis/atom-concepts-backfill/run.ts             # dry-run
 *   bun run skills/kos-jarvis/atom-concepts-backfill/run.ts --apply
 *   bun run skills/kos-jarvis/atom-concepts-backfill/run.ts --limit 60 --apply
 */

import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.KOS_CONCEPTS_MODEL ?? "claude-sonnet-4-6";
const BATCH_SIZE = 40;
const MAX_SPEND_USD = Number(process.env.KOS_CONCEPTS_MAX_SPEND ?? "5");
// sonnet pricing $3/M in, $15/M out (matches synthesize-concepts.ts estimate)
const USD_PER_M_IN = 3.0;
const USD_PER_M_OUT = 15.0;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STAMP = "atom-concepts-backfill-v1";

type AtomRow = {
  source_id: string;
  slug: string;
  title: string;
  frontmatter: {
    atom_type?: string;
    lesson?: string;
    source_quote?: string;
  };
};

function parseFlags(argv: string[]) {
  const flags = { apply: false, limit: 0, batch: BATCH_SIZE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") flags.apply = true;
    else if (argv[i] === "--limit") flags.limit = Number(argv[++i] ?? "0");
    else if (argv[i] === "--batch") flags.batch = Number(argv[++i] ?? String(BATCH_SIZE));
  }
  return flags;
}

function dbUrl(): string {
  const cfg = JSON.parse(
    readFileSync(join(homedir(), ".gbrain", "config.json"), "utf8"),
  );
  if (cfg.engine !== "postgres" || !cfg.database_url) {
    throw new Error("expected engine=postgres + database_url in ~/.gbrain/config.json");
  }
  return cfg.database_url;
}

const SYSTEM_PROMPT = `You label knowledge-base "atoms" (single extracted insights)
with concept topics so they can be clustered into concept pages.

For EACH atom, assign 1-3 concept labels:
- kebab-case English, 1-4 words (e.g. "wifi-roaming", "channel-pricing-strategy")
- TOPIC labels, not entities: "captive-portal" yes; "tp-link" / "qualcomm" no
- REUSE labels from the provided vocabulary whenever one genuinely fits;
  coin a new label only when nothing in the vocabulary applies
- generalize to the level a knowledge-base reader would browse: prefer
  "tls-certificates" over "acme-cert-renewal-cost"

Output ONLY a JSON object: {"labels": {"<atom slug>": ["label", ...], ...}}
Every input atom slug must appear exactly once. No prose, no markdown fences.`;

function buildUserMessage(atoms: AtomRow[], vocabulary: string[]): string {
  const vocab = vocabulary.length
    ? `Current vocabulary (REUSE these when applicable):\n${vocabulary.join(", ")}\n\n`
    : "";
  const lines = atoms.map((a) => {
    const fm = a.frontmatter ?? {};
    const parts = [
      `slug: ${a.slug}`,
      `title: ${a.title}`,
      fm.atom_type ? `type: ${fm.atom_type}` : "",
      fm.lesson ? `lesson: ${fm.lesson.slice(0, 300)}` : "",
      fm.source_quote ? `quote: ${fm.source_quote.slice(0, 200)}` : "",
    ].filter(Boolean);
    return parts.join("\n  ");
  });
  return `${vocab}Atoms (${atoms.length}):\n\n${lines.join("\n\n")}`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sql = postgres(dbUrl(), { onnotice: () => {}, prepare: false, idle_timeout: 20 });
  // .env.local's ANTHROPIC_BASE_URL (crs proxy) includes /v1 to suit
  // gbrain's Vercel AI SDK provider (which does NOT append /v1). The
  // official @anthropic-ai/sdk DOES append /v1 — strip a trailing /v1 so
  // both conventions resolve to the same endpoint.
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, "");
  const api = new Anthropic(baseUrl ? { baseURL: baseUrl } : {});

  try {
    const atoms = await sql<AtomRow[]>`
      SELECT source_id, slug, title, frontmatter
        FROM pages
       WHERE type = 'atom'
         AND deleted_at IS NULL
         AND NOT (frontmatter ? 'concepts')
       ORDER BY created_at
       ${flags.limit > 0 ? sql`LIMIT ${flags.limit}` : sql``}`;

    // Seed vocabulary from already-stamped atoms (re-runs stay consistent).
    const vocabRows = await sql<{ label: string }[]>`
      SELECT DISTINCT jsonb_array_elements_text(frontmatter->'concepts') AS label
        FROM pages
       WHERE type = 'atom' AND deleted_at IS NULL AND frontmatter ? 'concepts'`;
    const vocabulary = new Set<string>(vocabRows.map((r) => r.label));

    console.error(
      `[concepts-backfill] ${atoms.length} atom(s) lacking concepts; ` +
      `vocabulary seed ${vocabulary.size}; model=${MODEL}; ` +
      `${flags.apply ? "APPLY" : "dry-run"}`,
    );
    if (atoms.length === 0) return;

    let spendUsd = 0;
    let stamped = 0;
    let skippedInvalid = 0;
    const labelCounts = new Map<string, number>();

    for (let i = 0; i < atoms.length; i += flags.batch) {
      if (spendUsd >= MAX_SPEND_USD) {
        console.error(`[concepts-backfill] spend cap $${MAX_SPEND_USD} hit — stopping (rerun to continue)`);
        break;
      }
      const batch = atoms.slice(i, i + flags.batch);
      const resp = await api.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(batch, [...vocabulary].sort()) }],
      });
      spendUsd +=
        (resp.usage.input_tokens * USD_PER_M_IN + resp.usage.output_tokens * USD_PER_M_OUT) / 1e6;

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let parsed: { labels?: Record<string, unknown> };
      try {
        parsed = extractJson(text) as { labels?: Record<string, unknown> };
      } catch (err) {
        console.error(`[concepts-backfill] batch ${i / flags.batch + 1}: JSON parse failed (${(err as Error).message}) — skipping batch`);
        continue;
      }

      for (const atom of batch) {
        const raw = parsed.labels?.[atom.slug];
        const labels = Array.isArray(raw)
          ? raw.filter((l): l is string => typeof l === "string" && KEBAB_RE.test(l)).slice(0, 3)
          : [];
        if (labels.length === 0) {
          skippedInvalid++;
          continue;
        }
        for (const l of labels) {
          vocabulary.add(l);
          labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
        }
        if (flags.apply) {
          // sql.json keeps the value a jsonb ARRAY — a pre-stringified
          // param gets double-encoded into a jsonb string, which
          // synthesize_concepts' Array.isArray filter rejects.
          await sql`
            UPDATE pages
               SET frontmatter = frontmatter
                 || jsonb_build_object('concepts', ${sql.json(labels)}, 'concepts_by', ${STAMP}::text)
             WHERE source_id = ${atom.source_id} AND slug = ${atom.slug} AND type = 'atom'`;
        }
        stamped++;
      }
      console.error(
        `[concepts-backfill] batch ${Math.floor(i / flags.batch) + 1}/${Math.ceil(atoms.length / flags.batch)}: ` +
        `${stamped} labeled so far, $${spendUsd.toFixed(3)} spent`,
      );
    }

    const clusters = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]);
    const materializable = clusters.filter(([, n]) => n >= 2).length;
    console.error(
      `[concepts-backfill] done: ${stamped} atom(s) ${flags.apply ? "stamped" : "labeled (dry-run, NOT written)"}, ` +
      `${skippedInvalid} skipped-invalid, $${spendUsd.toFixed(3)} spent`,
    );
    console.error(
      `[concepts-backfill] ${labelCounts.size} distinct labels; ${materializable} cluster(s) with >=2 atoms (T3+ materializable)`,
    );
    console.error(`[concepts-backfill] top clusters: ${clusters.slice(0, 12).map(([l, n]) => `${l}(${n})`).join(", ")}`);
    if (skippedInvalid > stamped) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`[concepts-backfill] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
