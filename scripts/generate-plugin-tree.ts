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
// Personas: the SINGLE validation implementation (the harness-bridge CLI
// imports the same module), so CLI errors and CI errors match by construction.
import { loadPersonas, type PersonaDef } from '../src/core/skillpack/personas.ts';

// GBRAIN_PLUGIN_TREE_ROOT is the negative-fixture test seam: the manifest
// test points the generator at a synthetic repo root to prove each curation
// violation actually fails (a guard that cannot fail is not coverage).
const ROOT = process.env.GBRAIN_PLUGIN_TREE_ROOT || resolve(import.meta.dir, '..');

function usage(): never {
  console.error(
    'usage: bun run scripts/generate-plugin-tree.ts --out <dir> [--variants-out <dir>] [--write-gaps]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let out = '';
let variantsOut = '';
let writeGaps = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i] ?? '';
  else if (a === '--variants-out') variantsOut = args[++i] ?? '';
  else if (a === '--write-gaps') writeGaps = true;
  else usage();
}
if (!out) usage();

interface PluginLanes {
  starter_policy: string;
  additions: Record<string, string>;
  base_exclusions: Record<string, string>;
  not_added: Record<string, string>;
  /** Persona curation (validated by src/core/skillpack/personas.ts). The
   *  --write-gaps writer MUST spread-preserve this block — pinned by a
   *  byte-identical round-trip test. */
  personas?: Record<string, PersonaDef>;
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

// ── Persona validation (single implementation: src/core/skillpack/personas.ts)
let personas: Record<string, PersonaDef> = {};
try {
  personas = loadPersonas(ROOT).personas;
} catch (err) {
  fail((err as Error).message);
}

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

/**
 * Shared deps: always ship (mirrors openclaw.plugin.json#shared_deps). ONE
 * implementation for the main tree and every persona variant — the two copy
 * sites must never diverge (the shared_deps reconciliation follow-up in
 * TODOS.md gets fixed in one place).
 */
// Semgrep path-join suppressions in this file: repo-only build/CI tooling,
// deliberately not wired into src/cli.ts. ROOT is the repo root (or the
// test-seam env var our own manifest test sets), persona names come from the
// committed skills/plugin-lanes.json via loadPersonas validation, and
// --out/--variants-out are operator flags with their own refuse() guards —
// there is no untrusted input in these paths.
function copySharedDeps(destSkillsDir: string): void {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  cpSync(join(ROOT, 'skills', 'conventions'), join(destSkillsDir, 'conventions'), { recursive: true });
  for (const f of readdirSync(join(ROOT, 'skills'))) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    if (/^_.*\.(md|json)$/.test(f)) cpSync(join(ROOT, 'skills', f), join(destSkillsDir, f));
  }
}

for (const slug of laneSet) {
  cpSync(join(ROOT, 'skills', slug), join(outDir, 'skills', slug), { recursive: true });
}
copySharedDeps(join(outDir, 'skills'));

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

// ── Persona variant trees (marketplace entries gbrain-coding / gbrain-daily) ─
// Each variant root is SELF-CONTAINED (Claude Code installs the plugin source
// dir only): its own generated .claude-plugin/plugin.json + .codex-plugin/
// manifests (version from VERSION → variant lockstep is automatic under the
// byte-diff drift gate), a byte-copy of the launcher, the persona's skills,
// and the same shared-dep set the main tree ships.
function emitVariant(variantsDir: string, personaName: string, def: PersonaDef, version: string): void {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const root = join(variantsDir, def.plugin_name);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  mkdirSync(join(root, 'skills'), { recursive: true });

  const slugs = Object.keys(def.skills).sort();
  for (const slug of slugs) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    cpSync(join(ROOT, 'skills', slug), join(root, 'skills', slug), { recursive: true });
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  copySharedDeps(join(root, 'skills'));

  // Launcher byte-copy (cpSync preserves the executable bit).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  cpSync(join(ROOT, '.agents', 'gbrain-launcher'), join(root, '.agents', 'gbrain-launcher'));

  // Claude plugin manifest: model on the root manifest, retargeted at the
  // variant root (skills live at ./skills/ here, not ./plugin/skills/).
  const claudeBase = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const claudeVariant = {
    ...claudeBase,
    name: def.plugin_name,
    version,
    description: `${def.description} (persona variant of the gbrain plugin — ${slugs.length} skills)`,
    skills: './skills/',
  };
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(claudeVariant, null, 2) + '\n');

  // Codex plugin manifest + mcp.json: same retarget; mcp.json is verbatim
  // (its paths are already variant-root-relative: ./.agents/gbrain-launcher).
  const codexBase = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const codexVariant = {
    ...codexBase,
    name: def.plugin_name,
    version,
    description: `${def.description} (persona variant of the gbrain plugin — ${slugs.length} skills)`,
    skills: './skills/',
    mcpServers: './.codex-plugin/mcp.json',
  };
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify(codexVariant, null, 2) + '\n');
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  cpSync(join(ROOT, '.codex-plugin', 'mcp.json'), join(root, '.codex-plugin', 'mcp.json'));

  writeFileSync(
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    join(root, 'README.md'),
    `<!-- gbrain-plugin-tree-stamp: ${version} -->
# ${def.plugin_name} (generated persona variant — do not hand-edit)

${def.description}

${slugs.length} skills curated from the gbrain plugin lane (persona
\`${personaName}\` in \`skills/plugin-lanes.json#personas\`, one recorded
reason per skill). Install exactly ONE gbrain plugin per machine — every
variant serves the same \`gbrain\` MCP server name, so two installed variants
would double-serve. The full-lane plugin's README carries the MCP surface
note; it applies verbatim here.

Regenerate with \`bun run scripts/generate-plugin-tree.ts --out plugin
--variants-out plugin-variants\`.
`,
  );
}

if (variantsOut) {
  const variantsDir = resolve(variantsOut);
  // rmSync guard: --variants-out is recursively DELETED before emission, so
  // a mistyped path must refuse rather than eat a real directory. Refuse:
  // filesystem root, the repo root or any ancestor of it, the --out dir, and
  // any existing NON-generated non-empty dir (a prior emission is
  // recognizable by a variant README carrying the tree stamp).
  const refuse = (why: string): never => {
    console.error(`generate-plugin-tree: refusing --variants-out ${variantsDir}: ${why}`);
    process.exit(2);
  };
  if (variantsDir === '/' || variantsDir === resolve(out)) refuse('unsafe target');
  if (ROOT === variantsDir || ROOT.startsWith(variantsDir + '/')) refuse('would delete the repo root');
  if (existsSync(variantsDir) && readdirSync(variantsDir).length > 0) {
    const looksGenerated = readdirSync(variantsDir).some(d => {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const readme = join(variantsDir, d, 'README.md');
      try {
        return existsSync(readme) && readFileSync(readme, 'utf8').includes('gbrain-plugin-tree-stamp');
      } catch {
        return false;
      }
    });
    if (!looksGenerated) refuse('existing non-empty directory without a generated tree stamp');
  }
  rmSync(variantsDir, { recursive: true, force: true });
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  for (const [personaName, def] of Object.entries(personas)) {
    emitVariant(variantsDir, personaName, def, version);
  }
  console.error(
    `generate-plugin-tree: ${Object.keys(personas).length} persona variant(s) → ${variantsDir}`,
  );
}

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
