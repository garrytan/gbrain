#!/usr/bin/env bun
/**
 * scripts/generate-plugin-tree.ts — generator for the committed `plugin/`
 * tree that the Codex and Claude Code plugin lanes ship as their skill set.
 *
 * Repo-only release/CI tooling — deliberately NOT wired into src/cli.ts
 * (same posture as generate-template-repo.ts). Consumers:
 *   - the committed `plugin/` tree at the repo root (regenerate after any
 *     curation or bundled-skill change: `bun run scripts/generate-plugin-tree.ts
 *     --out plugin`)
 *   - scripts/check-plugin-tree.sh: regenerates into a tmpdir and byte-diffs
 *     against the committed tree (drift gate, runs in `bun run verify` + CI)
 *   - .github/workflows/release.yml `publish-codex-plugin` job: publishes the
 *     tree + plugin manifests + launcher to the `codex-plugin` orphan branch.
 *
 * Curation model (one publication decision per lane, review-visible):
 *   lane set = (openclaw.plugin.json#skills ∖ base_exclusions) ∪ additions
 * where additions/base_exclusions live in skills/plugin-lanes.json with a
 * reason per entry. Shared deps (skills/conventions/, skills/_*.md and
 * _brain-filing-rules.json) always ship, mirroring the openclaw bundler.
 *
 * Starter-surface gap snapshot: each bundled skill's frontmatter `tools:`
 * list is compared against STARTER_OPS (the plugin lanes serve
 * `--surface starter`). Harness tools (shell/exec/read/write/edit/
 * web_search/web_fetch), literal `gbrain` (CLI usage marker), and unknown
 * non-op names are not MCP ops; `mcp:`-prefixed names count with the prefix
 * stripped. The computed per-skill gap set must equal the `starter_gaps`
 * snapshot recorded in skills/plugin-lanes.json — a new beyond-starter op is
 * a conscious, review-visible curation event, not silent drift. Refresh the
 * snapshot with --write-gaps.
 *
 * Usage:
 *   bun run scripts/generate-plugin-tree.ts --out <dir> [--write-gaps]
 *
 * Prints the sorted relative file list to stdout; diagnostics to stderr.
 * Exit codes: 0 ok, 1 curation/gap violation, 2 usage error.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';

// GBRAIN_PLUGIN_TREE_ROOT is the negative-fixture test seam: the manifest
// test points the generator at a synthetic repo root to prove each curation
// violation actually fails (a guard that cannot fail is not coverage).
const ROOT = process.env.GBRAIN_PLUGIN_TREE_ROOT || resolve(import.meta.dir, '..');

function usage(): never {
  console.error('usage: bun run scripts/generate-plugin-tree.ts --out <dir> [--write-gaps]');
  process.exit(2);
}

const args = process.argv.slice(2);
let out = '';
let writeGaps = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i] ?? '';
  else if (a === '--write-gaps') writeGaps = true;
  else usage();
}
if (!out) usage();

interface PluginLanes {
  starter_policy: string;
  additions: Record<string, string>;
  base_exclusions: Record<string, string>;
  not_added: Record<string, string>;
  starter_gaps: Record<string, string[]>;
}

const openclaw = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
  skills: string[];
};
const lanesPath = join(ROOT, 'skills', 'plugin-lanes.json');
const lanes = JSON.parse(readFileSync(lanesPath, 'utf8')) as PluginLanes;
const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
  skills: { name: string }[];
};
const manifestNames = new Set(manifest.skills.map(s => s.name));

const base = openclaw.skills.map(s => s.replace(/^skills\//, ''));
const baseSet = new Set(base);
let failed = false;
const fail = (msg: string) => {
  console.error(`generate-plugin-tree: ${msg}`);
  failed = true;
};

// ── Curation-record validation ──────────────────────────────────────────────
for (const slug of Object.keys(lanes.additions)) {
  if (baseSet.has(slug)) fail(`addition '${slug}' is already in the openclaw base — remove from additions`);
  if (!manifestNames.has(slug)) fail(`addition '${slug}' is not in skills/manifest.json`);
  if (!existsSync(join(ROOT, 'skills', slug, 'SKILL.md'))) fail(`addition '${slug}' has no skills/${slug}/SKILL.md`);
  if (slug in lanes.base_exclusions || slug in lanes.not_added) fail(`'${slug}' appears in additions AND an exclusion record`);
}
for (const slug of Object.keys(lanes.base_exclusions)) {
  if (!baseSet.has(slug)) fail(`base_exclusion '${slug}' is not in the openclaw base — stale record`);
  if (slug in lanes.not_added) fail(`'${slug}' appears in BOTH base_exclusions and not_added`);
}
for (const [slug, reason] of [...Object.entries(lanes.additions), ...Object.entries(lanes.base_exclusions), ...Object.entries(lanes.not_added)]) {
  if (typeof reason !== 'string' || reason.length < 10) fail(`'${slug}' needs a real reason (>=10 chars)`);
}

const laneSet = [
  ...base.filter(s => !(s in lanes.base_exclusions)),
  ...Object.keys(lanes.additions),
].sort();

// ── Starter-gap snapshot ────────────────────────────────────────────────────
// Harness-native tool names a skill may declare that are not gbrain MCP ops.
const HARNESS_TOOLS = new Set(['shell', 'exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'gbrain']);

function frontmatterTools(slug: string): string[] {
  // Canonical parser (src/core/skill-frontmatter.ts) — handles BOTH the
  // inline (`tools: [a, b]`) and block-list YAML forms; a hand-rolled
  // block-only parser here would silently drop gaps if a skill switched to
  // the inline form (the exact drift the starter_gaps snapshot exists to
  // catch).
  const text = readFileSync(join(ROOT, 'skills', slug, 'SKILL.md'), 'utf8');
  return parseSkillFrontmatter(text)?.tools ?? [];
}

const computedGaps: Record<string, string[]> = {};
for (const slug of laneSet) {
  const mcpOps = frontmatterTools(slug)
    .map(t => (t.startsWith('mcp:') ? t.slice(4) : t))
    // Multi-word entries ("gbrain schema add-type …") are CLI command
    // strings, not MCP op names — same class as the bare `gbrain` marker.
    .filter(t => !HARNESS_TOOLS.has(t) && !t.startsWith('gbrain '));
  const gaps = [...new Set(mcpOps.filter(t => !STARTER_OPS.has(t)))].sort();
  if (gaps.length > 0) computedGaps[slug] = gaps;
}

if (writeGaps) {
  const next: PluginLanes = { ...lanes, starter_gaps: computedGaps };
  writeFileSync(lanesPath, JSON.stringify(next, null, 2) + '\n');
  console.error(`generate-plugin-tree: wrote starter_gaps snapshot (${Object.keys(computedGaps).length} skills with gaps)`);
} else {
  const recorded = JSON.stringify(lanes.starter_gaps ?? {});
  const computed = JSON.stringify(computedGaps);
  if (recorded !== computed) {
    fail(
      'starter_gaps snapshot in skills/plugin-lanes.json is stale — a bundled skill now ' +
        'declares different beyond-starter MCP ops. Review the change, then refresh with ' +
        '`bun run scripts/generate-plugin-tree.ts --out plugin --write-gaps`.',
    );
  }
}

if (failed) process.exit(1);

// ── Emit the tree ───────────────────────────────────────────────────────────
const outDir = resolve(out);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'skills'), { recursive: true });

for (const slug of laneSet) {
  cpSync(join(ROOT, 'skills', slug), join(outDir, 'skills', slug), { recursive: true });
}
// Shared deps: always ship (mirrors openclaw.plugin.json#shared_deps).
cpSync(join(ROOT, 'skills', 'conventions'), join(outDir, 'skills', 'conventions'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'skills'))) {
  if (/^_.*\.(md|json)$/.test(f)) cpSync(join(ROOT, 'skills', f), join(outDir, 'skills', f));
}

const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const gapSkills = Object.keys(computedGaps).length;
writeFileSync(
  join(outDir, 'README.md'),
  `<!-- gbrain-plugin-tree-stamp: ${version} -->
# gbrain plugin skill tree (generated — do not hand-edit)

This tree is the curated skill set for the gbrain Codex and Claude Code
plugins. Regenerate with \`bun run scripts/generate-plugin-tree.ts --out plugin\`;
curation lives in \`skills/plugin-lanes.json\` (one recorded decision per
addition/exclusion).

## MCP surface note (read once)

The plugin's MCP server runs \`gbrain serve --surface starter\` — the
${STARTER_OPS.size}-op daily-driver surface (the seven memory verbs + daily
brain ops + capture). ${gapSkills}
bundled skills reference gbrain operations beyond that surface; every one of
them has a first-class \`gbrain\` CLI path, which is the primary way skills
drive gbrain. When a skill step names an operation your MCP tool list doesn't
carry, run the equivalent \`gbrain\` CLI command, or widen this machine's
plugin surface with \`GBRAIN_SURFACE=full\` (the launcher honors it; new
sessions pick it up).

## Requirements

- gbrain CLI installed: \`bun install -g github:garrytan/gbrain#latest-stable\`
  (the npm package named \`gbrain\` is unrelated — never \`npm install -g gbrain\`).
- A brain: \`gbrain init\` (the bundled \`setup\` skill walks the full path).
`,
);

// Print sorted relative file list (parity with generate-template-repo.ts).
const files: string[] = [];
const walk = (dir: string, rel: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), r);
    else files.push(r);
  }
};
walk(outDir, '');
for (const f of files.sort()) console.log(f);
console.error(`generate-plugin-tree: ${laneSet.length} skills, ${files.length} files → ${outDir}`);
