/**
 * gbrain skillpack <list|scaffold|reference|migrate-fence|scrub-legacy-fence-rows|harvest|diff|check>
 *
 * v0.33 contract change: dropped `install` and `uninstall` (managed-block
 * model). Replaced by:
 *   - `scaffold`               — one-time, additive copy into host workspace
 *   - `reference`              — read-only update lens (per-file diff + framing)
 *                                Add `--apply-clean-hunks` to two-way auto-apply
 *   - `migrate-fence`          — one-shot strip of the legacy fence
 *   - `scrub-legacy-fence-rows` — opt-in cleanup of legacy rows post-migrate
 *   - `harvest`                — inverse: lift host skill into gbrain
 *
 * `install` and `uninstall` now exit non-zero with a hint pointing at the
 * replacement command. Clean break, no deprecated alias (D10-amended).
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve as resolvePath, join } from 'path';

import {
  bundledSkillSlugs,
  findGbrainRoot,
  loadBundleManifest,
  BundleError,
} from '../core/skillpack/bundle.ts';
import { runScaffold, ScaffoldError } from '../core/skillpack/scaffold.ts';
import { runReference, runReferenceAll, runReferenceApply } from '../core/skillpack/reference.ts';
import { runMigrateFence } from '../core/skillpack/migrate-fence.ts';
import { runScrubLegacy } from '../core/skillpack/scrub-legacy.ts';
import { runHarvest, HarvestError } from '../core/skillpack/harvest.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';

const HELP_TOP = `gbrain skillpack <subcommand> [options]

Subcommands:
  list                       Print every skill bundled in openclaw.plugin.json.

  scaffold <name>            Copy a bundled skill into your agent repo. Additive;
  scaffold --all             refuses to overwrite existing files.

  reference <name>           Read-only: diff gbrain's bundle vs your local copy.
  reference --all            Sweep over every bundled skill.
  reference <n> --apply-clean-hunks
                             Two-way diff, auto-apply non-conflicting hunks.

  migrate-fence              One-shot conversion from the old managed-block
                             model. Strips fence comments, preserves rows.

  scrub-legacy-fence-rows    Opt-in cleanup: remove preserved legacy rows
                             once frontmatter discovery is the norm.

  harvest <slug> --from <host-repo-root>
                             Lift a proven skill from a host agent repo
                             back into gbrain.

  diff <name>                (Informational) per-file status; exit 0 always.

  check                      Health report. \`check --strict\` exits non-zero
                             on any drift (for CI gating).

Run \`gbrain skillpack <subcommand> --help\` for per-subcommand options.

Removed in v0.33 (use migrate-fence to upgrade, then \`scaffold\`):
  install       — replaced by \`scaffold\`. Run \`migrate-fence\` once.
  uninstall     — removed. To remove a scaffolded skill, delete the
                  skills/<slug>/ directory (the files are yours).
`;

export async function runSkillpack(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP_TOP);
    process.exit(0);
  }
  switch (sub) {
    case 'list':
      await cmdList(rest);
      return;
    case 'scaffold':
      await cmdScaffold(rest);
      return;
    case 'reference':
      await cmdReference(rest);
      return;
    case 'migrate-fence':
      await cmdMigrateFence(rest);
      return;
    case 'scrub-legacy-fence-rows':
      await cmdScrubLegacy(rest);
      return;
    case 'harvest':
      await cmdHarvest(rest);
      return;
    case 'diff':
      await cmdDiff(rest);
      return;
    case 'check':
      await routeCheck(rest);
      return;
    case 'install':
      console.error(
        "Error: 'gbrain skillpack install' was removed in v0.33. Use 'gbrain skillpack scaffold <name>' instead.\n" +
          "If you're upgrading from an older release, run 'gbrain skillpack migrate-fence' once to strip the legacy managed block, then scaffold any new skills.",
      );
      process.exit(2);
      return;
    case 'uninstall':
      console.error(
        "Error: 'gbrain skillpack uninstall' was removed in v0.33. The new scaffold model lets you own scaffolded files outright — to remove a skill, delete its directory (rm -rf skills/<slug>/) and any paired source files declared in its frontmatter.",
      );
      process.exit(2);
      return;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.error(HELP_TOP);
      process.exit(2);
  }
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

function findGbrainOrDie(): string {
  const root = findGbrainRoot();
  if (!root) {
    console.error('Error: could not find gbrain repo root.');
    process.exit(2);
  }
  return root;
}

function resolveWorkspace(opts: { workspace?: string | null; skillsDir?: string | null }): string {
  if (opts.workspace) return resolveAbs(opts.workspace);
  if (opts.skillsDir) return resolvePath(resolveAbs(opts.skillsDir), '..');
  const detected = autoDetectSkillsDir();
  if (detected.dir) return resolvePath(detected.dir, '..');
  console.error(
    'Error: could not auto-detect a target workspace. Pass --workspace <path> or set $OPENCLAW_WORKSPACE.',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// list  — unchanged from v0.32; lightly reformatted
// ---------------------------------------------------------------------------

async function cmdList(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain skillpack list [--json]\n\nPrint every skill bundled in openclaw.plugin.json.');
    process.exit(0);
  }
  const json = args.includes('--json');
  const gbrainRoot = findGbrainOrDie();
  let manifest;
  try {
    manifest = loadBundleManifest(gbrainRoot);
  } catch (err) {
    console.error(`skillpack list: ${(err as Error).message}`);
    process.exit(2);
  }
  const slugs = bundledSkillSlugs(manifest);
  if (json) {
    const entries = slugs.map(slug => {
      const skillMd = join(gbrainRoot, 'skills', slug, 'SKILL.md');
      let description: string | null = null;
      if (existsSync(skillMd)) {
        const body = readFileSync(skillMd, 'utf-8');
        const fm = body.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const descMatch = fm[1].match(/^description:\s*["']?([^\n"']+)/m);
          if (descMatch) description = descMatch[1].trim();
        }
      }
      return { name: slug, description };
    });
    console.log(JSON.stringify({ name: manifest.name, version: manifest.version, skills: entries }, null, 2));
  } else {
    console.log(`${manifest.name} ${manifest.version} bundle — ${slugs.length} skills:`);
    for (const slug of slugs) console.log(`  ${slug}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

async function cmdScaffold(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack scaffold <name> | --all [--workspace PATH] [--dry-run] [--json]',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  let name: string | null = null;
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!all && !name) {
    console.error('Error: pass a skill name or --all.');
    process.exit(2);
  }

  const gbrainRoot = findGbrainOrDie();
  const targetWorkspace = resolveWorkspace({ workspace });

  try {
    const result = runScaffold({
      gbrainRoot,
      targetWorkspace,
      skillSlug: all ? null : name!,
      dryRun,
    });
    if (json) {
      console.log(JSON.stringify({ ok: true, dryRun: result.dryRun, summary: result.summary, files: result.files }, null, 2));
    } else {
      console.log(
        `${dryRun ? 'scaffold --dry-run' : 'scaffold'}: ${result.summary.wroteNew} wrote, ${result.summary.skippedExisting} skipped (already present), ${result.summary.pairedSourcesWritten} paired source(s)`,
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ScaffoldError || err instanceof BundleError) {
      console.error(`skillpack scaffold: ${(err as Error).message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// reference (+ --apply-clean-hunks)
// ---------------------------------------------------------------------------

async function cmdReference(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack reference <name> | --all [--workspace PATH] [--apply-clean-hunks] [--dry-run] [--json]',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const apply = args.includes('--apply-clean-hunks');
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  let name: string | null = null;
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!all && !name) {
    console.error('Error: pass a skill name or --all.');
    process.exit(2);
  }

  const gbrainRoot = findGbrainOrDie();
  const targetWorkspace = resolveWorkspace({ workspace });

  try {
    if (apply) {
      if (all) {
        console.error(
          'Error: --apply-clean-hunks is intentionally NOT supported with --all. Apply one skill at a time.',
        );
        process.exit(2);
      }
      const result = runReferenceApply({ gbrainRoot, targetWorkspace, skillSlug: name!, dryRun });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(result.framing);
        console.log(
          `reference --apply-clean-hunks: ${result.summary.totalHunksApplied} hunk(s) applied, ${result.summary.totalHunksConflicted} conflict(s)`,
        );
        for (const f of result.files) {
          if (f.status === 'identical') continue;
          console.log(`  ${f.status.padEnd(15)} ${f.target}`);
          for (const c of f.conflicts) console.log(`    ${c}`);
        }
      }
      process.exit(0);
    }

    if (all) {
      const result = runReferenceAll({ gbrainRoot, targetWorkspace });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(result.framing);
        for (const s of result.skills) {
          console.log(
            `  ${s.slug.padEnd(40)} identical:${s.summary.identical} differs:${s.summary.differs} missing:${s.summary.missing}`,
          );
        }
      }
      process.exit(0);
    }

    const result = runReference({ gbrainRoot, targetWorkspace, skillSlug: name! });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.framing);
      console.log(
        `reference: identical:${result.summary.identical} differs:${result.summary.differs} missing:${result.summary.missing}`,
      );
      for (const f of result.files) {
        if (f.status === 'identical') continue;
        console.log(`\n  ${f.status.padEnd(10)} ${f.target}`);
        if (f.unifiedDiff) console.log(f.unifiedDiff);
      }
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof BundleError) {
      console.error(`skillpack reference: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// migrate-fence
// ---------------------------------------------------------------------------

async function cmdMigrateFence(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain skillpack migrate-fence [--workspace PATH] [--dry-run] [--json]');
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    }
  }
  const gbrainRoot = findGbrainOrDie();
  const targetWorkspace = resolveWorkspace({ workspace });
  const result = runMigrateFence({ targetWorkspace, gbrainRoot, dryRun });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`migrate-fence: ${result.status}`);
    if (result.resolverFile) console.log(`  resolver: ${result.resolverFile}`);
    if (result.fenceSlugs.length) console.log(`  fenced slugs: ${result.fenceSlugs.join(', ')}`);
    if (result.skillsCopied.length) console.log(`  skills copied: ${result.skillsCopied.join(', ')}`);
    if (result.skillsAlreadyPresent.length)
      console.log(`  already present: ${result.skillsAlreadyPresent.join(', ')}`);
    if (result.usedRowFallback)
      console.log('  (used row-parsing fallback — receipt was missing or drifted)');
  }
  process.exit(result.status === 'fence_malformed' ? 2 : 0);
}

// ---------------------------------------------------------------------------
// scrub-legacy-fence-rows
// ---------------------------------------------------------------------------

async function cmdScrubLegacy(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack scrub-legacy-fence-rows [--workspace PATH] [--dry-run] [--json]',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    }
  }
  const targetWorkspace = resolveWorkspace({ workspace });
  const result = runScrubLegacy({ targetWorkspace, dryRun });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `scrub-legacy-fence-rows: ${result.removed.length} removed, ${result.preserved.length} preserved`,
    );
    if (result.removed.length) console.log(`  removed: ${result.removed.join(', ')}`);
    if (result.preserved.length) console.log(`  preserved: ${result.preserved.join(', ')}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

async function cmdHarvest(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack harvest <slug> --from <host-repo-root> [--no-lint] [--dry-run] [--overwrite-local] [--json]',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const noLint = args.includes('--no-lint');
  const overwriteLocal = args.includes('--overwrite-local');
  let slug: string | null = null;
  let from: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') {
      from = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--from=')) {
      from = a.slice('--from='.length) || null;
    } else if (a && !a.startsWith('--') && !slug) {
      slug = a;
    }
  }
  if (!slug) {
    console.error('Error: pass a slug.');
    process.exit(2);
  }
  if (!from) {
    console.error('Error: pass --from <host-repo-root>.');
    process.exit(2);
  }
  const gbrainRoot = findGbrainOrDie();

  try {
    const result = runHarvest({
      slug,
      hostRepoRoot: resolveAbs(from),
      gbrainRoot,
      noLint,
      dryRun,
      overwriteLocal,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`harvest ${slug}: ${result.status}`);
      if (result.filesCopied.length)
        console.log(`  files: ${result.filesCopied.length} copied`);
      if (result.pairedSources.length)
        console.log(`  paired sources: ${result.pairedSources.join(', ')}`);
      if (result.manifestUpdated) console.log('  openclaw.plugin.json updated');
      if (result.lintHits.length) {
        console.log('  privacy-lint hits (harvest rolled back):');
        for (const h of result.lintHits) console.log(`    ${h}`);
      }
    }
    // Exit non-zero on lint failure so the editorial workflow knows to scrub.
    process.exit(result.status === 'lint_failed' ? 1 : 0);
  } catch (err) {
    if (err instanceof HarvestError || err instanceof BundleError) {
      console.error(`skillpack harvest: ${(err as Error).message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// diff (informational — preserved from v0.32; uses legacy installer's
// diffSkill which still ships unchanged until T12 deletes it)
// ---------------------------------------------------------------------------

async function cmdDiff(args: string[]): Promise<void> {
  // Lazy-import the legacy diff helper. T12 deletes installer.ts; until
  // then this path keeps the existing semantics.
  const { diffSkill } = await import('../core/skillpack/installer.ts');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain skillpack diff <name> [--workspace PATH] [--json]');
    process.exit(0);
  }
  const json = args.includes('--json');
  let name: string | null = null;
  let skillsDir: string | null = null;
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    } else if (a === '--skills-dir') {
      skillsDir = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      skillsDir = a.slice('--skills-dir='.length) || null;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!name) {
    console.error('Error: pass a skill name.');
    process.exit(2);
  }
  const gbrainRoot = findGbrainOrDie();
  const targetSkillsDir = skillsDir
    ? resolveAbs(skillsDir)
    : join(resolveWorkspace({ workspace }), 'skills');
  try {
    const diffs = diffSkill(gbrainRoot, name, targetSkillsDir);
    const clean = diffs.every(d => d.identical && d.existing);
    if (json) console.log(JSON.stringify({ ok: true, skillName: name, diffs }, null, 2));
    else {
      console.log(`skillpack diff ${name} → ${targetSkillsDir}`);
      for (const d of diffs) {
        let tag: string;
        if (!d.existing) tag = 'missing  ';
        else if (d.identical) tag = 'identical';
        else tag = 'differs  ';
        console.log(`  ${tag}  ${d.target}  (src ${d.sourceBytes}B / tgt ${d.targetBytes}B)`);
      }
      console.log(clean ? '\n✓ all files match the bundle.' : '\n(Run `gbrain skillpack reference ' + name + '` for a unified diff.)');
    }
    // v0.33: diff is informational; exit 0 always.
    process.exit(0);
  } catch (err) {
    if (err instanceof BundleError) {
      console.error(`skillpack diff: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// check — routes to skillpack-check (T10 adds --strict)
// ---------------------------------------------------------------------------

async function routeCheck(args: string[]): Promise<void> {
  const { runSkillpackCheck } = await import('./skillpack-check.ts');
  await runSkillpackCheck(args);
}
