#!/usr/bin/env bun
/**
 * frontmatter-ref-fix — normalize `../X/Y.md`-style frontmatter refs to
 * canonical slug form (`X/Y`), verify each target exists on disk, leave
 * unresolved refs untouched (or optionally delete brain-external /
 * dead-link refs), report everything.
 *
 * v2 (2026-04-27 evening) extends v1 with:
 *   - EXTERNAL_POINTER_KEYS: known frontmatter keys that legitimately
 *     point at brain-external paths (e.g. `raw_path:`); skipped without
 *     warning.
 *   - Bare-slug fuzzy resolve: `harness-engineering.md` (no dir
 *     prefix) is matched against a basename → full-slug index. Unique
 *     hits get rewritten; ambiguous + zero hits go to the report.
 *   - External-path detection: paths with 2+ leading `../` segments
 *     escape the brain root. Reported separately; optionally deleted
 *     with `--delete-external`.
 *   - Dead-link detection: `X/Y.md`-shape ref where `X/Y` is not on
 *     disk. Reported separately; optionally deleted with `--delete-dead`.
 *
 * v1-wiki migration legacy. See SKILL.md for context.
 *
 * Usage:
 *   bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts [flags]
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { execSync } from "node:child_process";

// ---------- Flags ----------

type Flags = {
  apply: boolean;
  noCommit: boolean;
  brainDir: string;
  fuzzy: boolean;
  deleteExternal: boolean;
  deleteDead: boolean;
  json: boolean;
  help: boolean;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    apply: false,
    noCommit: false,
    brainDir: process.env.KOS_BRAIN_DIR ?? join(homedir(), "brain"),
    fuzzy: true,
    deleteExternal: false,
    deleteDead: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        f.help = true;
        break;
      case "--dry-run":
        f.apply = false;
        break;
      case "--apply":
        f.apply = true;
        break;
      case "--no-commit":
        f.noCommit = true;
        break;
      case "--no-fuzzy":
        f.fuzzy = false;
        break;
      case "--fuzzy":
        f.fuzzy = true;
        break;
      case "--delete-external":
        f.deleteExternal = true;
        break;
      case "--delete-dead":
        f.deleteDead = true;
        break;
      case "--delete-all":
        f.deleteExternal = true;
        f.deleteDead = true;
        break;
      case "--json":
        f.json = true;
        break;
      case "--brain-dir":
        f.brainDir = argv[++i] ?? f.brainDir;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return f;
}

const USAGE = `
frontmatter-ref-fix v2 — normalize '../X/Y.md' refs, fuzzy-resolve bare
slugs, optionally delete brain-external + dead-link refs.

Usage:
  bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts [flags]

Flags:
  --dry-run              (default) report-only, no writes
  --apply                rewrite resolved refs + git commit
  --no-commit            apply without git commit (testing)
  --fuzzy                (default on) fuzzy-resolve bare slugs against basename index
  --no-fuzzy             disable fuzzy resolve (v1 behavior)
  --delete-external      with --apply, delete refs that escape brain root (../../X)
  --delete-dead          with --apply, delete refs of shape X/Y.md where target is missing
  --delete-all           shorthand for --delete-external + --delete-dead
  --brain-dir DIR        override ~/brain location
  --json                 JSONL events to stdout
  --help, -h             this message

Reports:
  <brain-dir>/.agent/reports/frontmatter-ref-fix-<ISO>.md
`;

/**
 * Frontmatter keys whose values are by-design pointers at brain-external
 * snapshots. Lines under these keys are skipped without warning.
 *
 * Add new keys here as the schema grows. Be conservative — only add a
 * key when its value is *always* an external path; otherwise the skill
 * will silently miss real ref problems on that key.
 */
const EXTERNAL_POINTER_KEYS = new Set<string>(["raw_path"]);

// ---------- Filesystem walk ----------

function walkMarkdown(dir: string, brainDir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".agent" || name === ".git" || name.startsWith(".")) continue;
      const full = join(d, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile() && name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function pathToSlug(absPath: string, brainDir: string): string {
  const rel = relative(brainDir, absPath);
  // Normalize Windows-style sep just in case (no-op on macOS).
  const norm = rel.split(sep).join("/");
  return norm.replace(/\.md$/, "");
}

/**
 * Build a basename → full-slug index for fuzzy resolve.
 * `concepts/harness-engineering` indexes basename `harness-engineering`.
 * If two slugs share a basename, both go in; the lookup returns null
 * (ambiguous) rather than picking one.
 */
function buildBaseIndex(slugs: Set<string>): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const slug of slugs) {
    const lastSlash = slug.lastIndexOf("/");
    const base = lastSlash < 0 ? slug : slug.slice(lastSlash + 1);
    if (index.has(base)) {
      index.set(base, null); // ambiguous
    } else {
      index.set(base, slug);
    }
  }
  return index;
}

// ---------- Frontmatter splitting ----------

/**
 * Returns [frontmatterBlock, body] split. frontmatterBlock includes the
 * leading and trailing `---` lines so it round-trips byte-exact when
 * concatenated back.
 *
 * If the file does not start with `---\n`, returns [null, content].
 */
function splitFrontmatter(content: string): [string | null, string] {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return [null, content];
  }
  // Find the closing `---` on its own line.
  const lines = content.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "---\r") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return [null, content];
  const fmLines = lines.slice(0, endIdx + 1);
  const bodyLines = lines.slice(endIdx + 1);
  return [fmLines.join("\n") + "\n", bodyLines.join("\n")];
}

// ---------- Ref rewriting ----------

type HitCategory =
  | "resolved" // exact slug match, rewritten
  | "fuzzy_resolved" // bare-slug → unique fuzzy match, rewritten
  | "external_key_skipped" // value under EXTERNAL_POINTER_KEYS, untouched
  | "external_path" // 2+ leading `../`, escapes brain root
  | "dead" // looks like a real slug but target missing
  | "bare_ambiguous" // bare slug with multiple basename hits
  | "bare_unresolved"; // bare slug, no basename hit at all

type RewriteHit = {
  file: string;
  line: number;
  before: string;
  candidateSlug: string;
  category: HitCategory;
  field: string | null;
  resolvedTo: string | null; // for resolved + fuzzy_resolved
  deleted: boolean; // line removed (only when --delete-external/--delete-dead)
};

/**
 * Match a frontmatter line that ends in `.md`, optionally with `../`
 * prefixes, optionally wrapped in single or double quotes, optionally
 * preceded by a yaml list dash or `key:` prefix.
 *
 * Captures:
 *   1: prefix (indent + `-` or `key:`)
 *   2: optional quote
 *   3: dotdot run (e.g. `../../`) or empty
 *   4: slug body (sans `.md`)
 */
const REF_LINE_REGEX =
  /^(\s*(?:-\s+|[A-Za-z_][A-Za-z0-9_-]*:\s*))(['"]?)((?:\.\.\/)+)?([A-Za-z0-9][A-Za-z0-9_./-]*?)\.md\2\s*$/;

const KEY_LINE_REGEX = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/;
const KEY_INLINE_REGEX = /^([A-Za-z_][A-Za-z0-9_-]*):\s+/;

function classify(
  slugBody: string,
  dotdot: string | undefined,
  slugs: Set<string>,
  baseIndex: Map<string, string | null>,
  fuzzy: boolean,
  field: string | null
): { category: HitCategory; resolvedTo: string | null } {
  // External pointer key (e.g. raw_path).
  if (field && EXTERNAL_POINTER_KEYS.has(field)) {
    return { category: "external_key_skipped", resolvedTo: null };
  }

  // Brain-external: 2+ leading `../` definitely escapes the brain root.
  // Single `../` from brain/<dir>/file.md still lands inside brain at
  // brain/<other-dir>/... so it's covered by the slug check.
  const dotdotCount = (dotdot ?? "").length / 3; // each `../` is 3 chars
  if (dotdotCount >= 2) {
    return { category: "external_path", resolvedTo: null };
  }

  // Exact slug match.
  if (slugs.has(slugBody)) {
    return { category: "resolved", resolvedTo: slugBody };
  }

  // Bare slug (no slash) → try fuzzy.
  if (!slugBody.includes("/")) {
    if (!fuzzy) {
      return { category: "bare_unresolved", resolvedTo: null };
    }
    const hit = baseIndex.get(slugBody);
    if (hit === null) {
      return { category: "bare_ambiguous", resolvedTo: null };
    }
    if (hit !== undefined) {
      return { category: "fuzzy_resolved", resolvedTo: hit };
    }
    return { category: "bare_unresolved", resolvedTo: null };
  }

  // Pathlike slug but missing on disk → dead link.
  return { category: "dead", resolvedTo: null };
}

function rewriteFrontmatter(
  fm: string,
  slugs: Set<string>,
  baseIndex: Map<string, string | null>,
  filePath: string,
  fuzzy: boolean,
  deleteExternal: boolean,
  deleteDead: boolean
): { newFm: string; hits: RewriteHit[]; changed: boolean } {
  const hits: RewriteHit[] = [];
  const lines = fm.split("\n");
  const linesToDelete = new Set<number>();
  let lastKey: string | null = null;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track the most recent yaml key for context.
    const keyOnly = line.match(KEY_LINE_REGEX);
    if (keyOnly) {
      lastKey = keyOnly[1];
    } else {
      const inline = line.match(KEY_INLINE_REGEX);
      if (inline) lastKey = inline[1];
    }

    // Skip URLs.
    if (line.includes("://")) continue;

    const m = line.match(REF_LINE_REGEX);
    if (!m) continue;

    const [, prefix, quote, dotdot, slugBody] = m;
    const { category, resolvedTo } = classify(
      slugBody,
      dotdot,
      slugs,
      baseIndex,
      fuzzy,
      lastKey
    );

    let deleted = false;
    if (
      (category === "resolved" || category === "fuzzy_resolved") &&
      resolvedTo
    ) {
      lines[i] = `${prefix}${quote}${resolvedTo}${quote}`;
      changed = true;
    } else if (category === "external_path" && deleteExternal) {
      linesToDelete.add(i);
      deleted = true;
      changed = true;
    } else if (category === "dead" && deleteDead) {
      linesToDelete.add(i);
      deleted = true;
      changed = true;
    }
    // external_key_skipped, bare_ambiguous, bare_unresolved: report only.

    hits.push({
      file: filePath,
      line: i + 1,
      before: line,
      candidateSlug: slugBody,
      category,
      field: lastKey,
      resolvedTo,
      deleted,
    });
  }

  // Apply deletions in reverse order.
  if (linesToDelete.size > 0) {
    const sorted = [...linesToDelete].sort((a, b) => b - a);
    for (const idx of sorted) {
      lines.splice(idx, 1);
    }
  }

  return { newFm: lines.join("\n"), hits, changed };
}

// ---------- Reporting ----------

type Summary = {
  startedAt: string;
  durationMs: number;
  mode: "dry-run" | "apply";
  brainDir: string;
  flags: {
    fuzzy: boolean;
    delete_external: boolean;
    delete_dead: boolean;
  };
  totals: {
    files_scanned: number;
    files_with_frontmatter: number;
    files_rewritten: number;
    refs_found: number;
    refs_resolved: number;
    refs_fuzzy_resolved: number;
    refs_external_key_skipped: number;
    refs_external_path: number;
    refs_dead: number;
    refs_bare_ambiguous: number;
    refs_bare_unresolved: number;
    refs_deleted: number;
  };
  git: { committed: boolean; sha: string | null; error: string | null } | null;
};

function buildReport(summary: Summary, hits: RewriteHit[]): string {
  const byCategory = new Map<HitCategory, RewriteHit[]>();
  for (const h of hits) {
    const arr = byCategory.get(h.category) ?? [];
    arr.push(h);
    byCategory.set(h.category, arr);
  }

  const lines: string[] = [];
  lines.push(`# Frontmatter Ref Fix v2 — ${summary.startedAt}`);
  lines.push("");
  lines.push(`**Mode**: ${summary.mode}`);
  lines.push(`**Brain dir**: ${summary.brainDir}`);
  lines.push(`**Duration**: ${(summary.durationMs / 1000).toFixed(2)}s`);
  lines.push(
    `**Flags**: fuzzy=${summary.flags.fuzzy} delete-external=${summary.flags.delete_external} delete-dead=${summary.flags.delete_dead}`
  );
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Files scanned: ${summary.totals.files_scanned}`);
  lines.push(`- Files with frontmatter: ${summary.totals.files_with_frontmatter}`);
  lines.push(`- Files rewritten: ${summary.totals.files_rewritten}`);
  lines.push(`- Refs found: ${summary.totals.refs_found}`);
  lines.push("");
  lines.push("By category:");
  lines.push(`- resolved (rewritten): ${summary.totals.refs_resolved}`);
  lines.push(`- fuzzy_resolved (rewritten): ${summary.totals.refs_fuzzy_resolved}`);
  lines.push(
    `- external_key_skipped (raw_path etc.): ${summary.totals.refs_external_key_skipped}`
  );
  lines.push(
    `- external_path (../../escapes brain): ${summary.totals.refs_external_path}`
  );
  lines.push(`- dead (target missing): ${summary.totals.refs_dead}`);
  lines.push(`- bare_ambiguous: ${summary.totals.refs_bare_ambiguous}`);
  lines.push(`- bare_unresolved: ${summary.totals.refs_bare_unresolved}`);
  if (summary.totals.refs_deleted > 0) {
    lines.push(`- deleted lines: ${summary.totals.refs_deleted}`);
  }
  if (summary.git) {
    lines.push(
      `- Git: ${summary.git.committed ? `committed ${summary.git.sha}` : `not committed${summary.git.error ? ` (${summary.git.error})` : ""}`}`
    );
  }
  lines.push("");

  // Per-category sections (skip empty + skip resolved details — they're already absorbed).
  const sectionOrder: HitCategory[] = [
    "fuzzy_resolved",
    "external_path",
    "dead",
    "bare_ambiguous",
    "bare_unresolved",
    "external_key_skipped",
    "resolved",
  ];

  for (const cat of sectionOrder) {
    const arr = byCategory.get(cat) ?? [];
    if (arr.length === 0) continue;
    lines.push(`## ${cat} (${arr.length})`);
    lines.push("");
    if (cat === "resolved") {
      lines.push(`Sample (first 30):`);
      lines.push("");
      for (const h of arr.slice(0, 30)) {
        lines.push(
          `- ${h.file.replace(summary.brainDir + "/", "")}:${h.line} → \`${h.resolvedTo}\``
        );
      }
      if (arr.length > 30) lines.push(`- ... +${arr.length - 30} more`);
      lines.push("");
      continue;
    }
    // Group by candidate slug.
    const bySlug = new Map<string, RewriteHit[]>();
    for (const h of arr) {
      const a = bySlug.get(h.candidateSlug) ?? [];
      a.push(h);
      bySlug.set(h.candidateSlug, a);
    }
    for (const slug of [...bySlug.keys()].sort()) {
      const hs = bySlug.get(slug)!;
      lines.push(
        `### \`${slug}\`${hs[0].resolvedTo ? ` → \`${hs[0].resolvedTo}\`` : ""} (${hs.length}×)`
      );
      lines.push("");
      for (const h of hs) {
        const tag = h.deleted ? " [DELETED]" : "";
        lines.push(
          `- ${h.file.replace(summary.brainDir + "/", "")}:${h.line}${h.field ? ` (key: \`${h.field}\`)` : ""}${tag}`
        );
        lines.push(`  - before: \`${h.before.trim()}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function writeReport(summary: Summary, hits: RewriteHit[]): string {
  const reportsDir = join(summary.brainDir, ".agent", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const iso = summary.startedAt.replace(/[:.]/g, "-");
  const mdPath = join(reportsDir, `frontmatter-ref-fix-${iso}.md`);
  const md = buildReport(summary, hits);
  writeFileSync(mdPath, md, "utf8");
  return mdPath;
}

// ---------- Git commit ----------

function gitCommitBrain(
  brainDir: string,
  message: string
): { committed: boolean; sha: string | null; error: string | null } {
  try {
    execSync(`git -C "${brainDir}" add -A`, { stdio: "pipe" });
    const status = execSync(`git -C "${brainDir}" status --porcelain`, {
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (status === "") {
      return { committed: false, sha: null, error: null };
    }
    execSync(`git -C "${brainDir}" commit -m "${message.replace(/"/g, '\\"')}"`, {
      stdio: "pipe",
    });
    const sha = execSync(`git -C "${brainDir}" rev-parse HEAD`, { stdio: "pipe" })
      .toString()
      .trim();
    return { committed: true, sha, error: null };
  } catch (e) {
    return {
      committed: false,
      sha: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------- Event logging ----------

function emit(json: boolean, event: string, payload: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
  } else {
    const pretty = Object.entries(payload)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    console.error(`[${event}] ${pretty}`);
  }
}

// ---------- Main ----------

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (!existsSync(flags.brainDir)) {
    console.error(`brain dir does not exist: ${flags.brainDir}`);
    return 2;
  }

  const startedAt = new Date();
  const t0 = Date.now();

  const allFiles = walkMarkdown(flags.brainDir, flags.brainDir);
  const slugs = new Set<string>(
    allFiles.map((f) => pathToSlug(f, flags.brainDir))
  );
  const baseIndex = buildBaseIndex(slugs);

  emit(flags.json, "scan.start", {
    brain_dir: flags.brainDir,
    files: allFiles.length,
    slugs: slugs.size,
    base_index_size: baseIndex.size,
    fuzzy: flags.fuzzy,
    delete_external: flags.deleteExternal,
    delete_dead: flags.deleteDead,
  });

  const allHits: RewriteHit[] = [];
  let filesWithFm = 0;
  const filesToWrite = new Map<string, string>();

  for (const file of allFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const [fm, body] = splitFrontmatter(content);
    if (fm === null) continue;
    filesWithFm += 1;

    const { newFm, hits, changed } = rewriteFrontmatter(
      fm,
      slugs,
      baseIndex,
      file,
      flags.fuzzy,
      flags.deleteExternal,
      flags.deleteDead
    );
    if (hits.length === 0) continue;
    allHits.push(...hits);

    if (changed) {
      filesToWrite.set(file, newFm + body);
    }
  }

  const tally = (cat: HitCategory) =>
    allHits.filter((h) => h.category === cat).length;

  emit(flags.json, "scan.complete", {
    refs_found: allHits.length,
    refs_resolved: tally("resolved"),
    refs_fuzzy_resolved: tally("fuzzy_resolved"),
    refs_external_key_skipped: tally("external_key_skipped"),
    refs_external_path: tally("external_path"),
    refs_dead: tally("dead"),
    refs_bare_ambiguous: tally("bare_ambiguous"),
    refs_bare_unresolved: tally("bare_unresolved"),
    files_to_rewrite: filesToWrite.size,
  });

  let gitResult: Summary["git"] = null;
  const refsDeleted = allHits.filter((h) => h.deleted).length;

  if (flags.apply) {
    for (const [file, content] of filesToWrite) {
      writeFileSync(file, content, "utf8");
    }
    if (!flags.noCommit && filesToWrite.size > 0) {
      const summary_parts: string[] = [];
      const r = tally("resolved");
      const fr = tally("fuzzy_resolved");
      if (r > 0) summary_parts.push(`${r} normalized`);
      if (fr > 0) summary_parts.push(`${fr} fuzzy-resolved`);
      if (refsDeleted > 0) summary_parts.push(`${refsDeleted} deleted`);
      const message = `chore(frontmatter-ref-fix): v2 sweep — ${summary_parts.join(", ")} across ${filesToWrite.size} files`;
      gitResult = gitCommitBrain(flags.brainDir, message);
      emit(flags.json, "git.commit", {
        committed: gitResult.committed,
        sha: gitResult.sha,
        error: gitResult.error,
      });
    }
  }

  const summary: Summary = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    mode: flags.apply ? "apply" : "dry-run",
    brainDir: flags.brainDir,
    flags: {
      fuzzy: flags.fuzzy,
      delete_external: flags.deleteExternal,
      delete_dead: flags.deleteDead,
    },
    totals: {
      files_scanned: allFiles.length,
      files_with_frontmatter: filesWithFm,
      files_rewritten: filesToWrite.size,
      refs_found: allHits.length,
      refs_resolved: tally("resolved"),
      refs_fuzzy_resolved: tally("fuzzy_resolved"),
      refs_external_key_skipped: tally("external_key_skipped"),
      refs_external_path: tally("external_path"),
      refs_dead: tally("dead"),
      refs_bare_ambiguous: tally("bare_ambiguous"),
      refs_bare_unresolved: tally("bare_unresolved"),
      refs_deleted: refsDeleted,
    },
    git: gitResult,
  };

  const mdPath = writeReport(summary, allHits);
  emit(flags.json, "report.written", { path: mdPath });

  if (!flags.json) {
    console.error("");
    console.error(
      `frontmatter-ref-fix v2 ${summary.mode} done in ${(summary.durationMs / 1000).toFixed(2)}s`
    );
    console.error(`  files scanned:        ${summary.totals.files_scanned}`);
    console.error(`  refs found:           ${summary.totals.refs_found}`);
    console.error(`  resolved:             ${summary.totals.refs_resolved}`);
    console.error(`  fuzzy_resolved:       ${summary.totals.refs_fuzzy_resolved}`);
    console.error(`  external_key_skipped: ${summary.totals.refs_external_key_skipped}`);
    console.error(`  external_path:        ${summary.totals.refs_external_path}`);
    console.error(`  dead:                 ${summary.totals.refs_dead}`);
    console.error(`  bare_ambiguous:       ${summary.totals.refs_bare_ambiguous}`);
    console.error(`  bare_unresolved:      ${summary.totals.refs_bare_unresolved}`);
    if (summary.mode === "apply") {
      console.error(`  files written:        ${summary.totals.files_rewritten}`);
      console.error(`  refs deleted:         ${summary.totals.refs_deleted}`);
      if (gitResult) {
        console.error(
          `  git:                  ${gitResult.committed ? gitResult.sha : `no commit${gitResult.error ? ` (${gitResult.error})` : ""}`}`
        );
      }
    }
    console.error(`  report:               ${mdPath}`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
