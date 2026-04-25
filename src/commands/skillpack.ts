/**
 * gbrain skillpack <list|install|diff|check> — v0.17 W5 CLI namespace.
 *
 * D-CX-2 pattern: unified subcommand namespace. The pre-existing
 * `skillpack-check` command keeps its top-level name for backwards
 * compat but is also reachable as `gbrain skillpack check` here.
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve as resolvePath, join } from 'path';

import {
  bundledSkillSlugs,
  findGbrainRoot,
  loadBundleManifest,
  BundleError,
} from '../core/skillpack/bundle.ts';
import {
  planInstall,
  applyInstall,
  diffSkill,
  InstallError,
} from '../core/skillpack/installer.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';

const HELP_TOP = `gbrain skillpack <subcommand> [options]

Subcommands:
  list             Print every skill bundled in openclaw.plugin.json.
  install <name>   Copy one skill (or --all) into a target workspace.
                   Data-loss protected: per-file diff, --overwrite-local
                   escape hatch, lockfile + atomic AGENTS.md update.
  diff <name>      Show per-file diff status between the bundle and
                   the target workspace for one skill.
  check            Run the skillpack health report (same as the
                   top-level \`gbrain skillpack-check\`).

Run \`gbrain skillpack <subcommand> --help\` for per-subcommand options.
`;

export async function runSkillpack(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP_TOP);
    process.exit(0);
  }
  if (sub === 'list') {
    await runList(rest);
    return;
  }
  if (sub === 'install') {
    await runInstall(rest);
    return;
  }
  if (sub === 'diff') {
    await runDiff(rest);
    return;
  }
  if (sub === 'check') {
    const { runSkillpackCheck } = await import('./skillpack-check.ts');
    await runSkillpackCheck(rest);
    return;
  }
  console.error(`Unknown subcommand: ${sub}\n`);
  console.error(HELP_TOP);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const HELP_LIST = `gbrain skillpack list [--json]

Print every skill bundled in openclaw.plugin.json, one per line.
Exit 0 always (unless the manifest is missing/malformed).
`;

async function runList(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP_LIST);
    process.exit(0);
  }
  const json = args.includes('--json');
  const gbrainRoot = findGbrainRoot();
  if (!gbrainRoot) {
    console.error(
      'Error: could not find gbrain repo root. Run this from inside a gbrain checkout, or pass --gbrain-root (not yet implemented).',
    );
    process.exit(2);
  }
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
    console.log(
      JSON.stringify(
        { name: manifest.name, version: manifest.version, skills: entries },
        null,
        2,
      ),
    );
  } else {
    console.log(`${manifest.name} ${manifest.version} bundle — ${slugs.length} skills:`);
    for (const slug of slugs) {
      console.log(`  ${slug}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

interface InstallFlags {
  help: boolean;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  overwriteLocal: boolean;
  forceUnlock: boolean;
  all: boolean;
  skillName: string | null;
  skillsDir: string | null;
  workspace: string | null;
}

const HELP_INSTALL = `gbrain skillpack install <name> | --all [options]

Copy bundled skills into a target OpenClaw workspace. The target is
auto-detected (\$OPENCLAW_WORKSPACE, then ~/.openclaw/workspace, then
--skills-dir). Shared convention files are installed alongside
(dependency closure per codex D-CX-10).

Arguments:
  <name>               Install a single skill by slug.
  --all                Install every skill in openclaw.plugin.json#skills.

Options:
  --dry-run            Preview file operations; no writes.
  --overwrite-local    For per-file diff: overwrite target files that
                       differ from the bundle. Default: skip locally-
                       modified files for data-loss protection.
  --force-unlock       Acquire the skillpack lockfile even if a stale
                       peer lock exists.
  --skills-dir PATH    Override target skills directory.
  --workspace PATH     Override target workspace (parent of skills/).
  --json               Machine-readable envelope.
  --help               Show this message.

Exit codes:
  0   success
  1   some files skipped due to local-modification protection
  2   setup error (no workspace, no bundle, lock held)
`;

function parseInstallFlags(argv: string[]): InstallFlags {
  const f: InstallFlags = {
    help: false,
    json: false,
    dryRun: false,
    force: false,
    overwriteLocal: false,
    forceUnlock: false,
    all: false,
    skillName: null,
    skillsDir: null,
    workspace: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--json') f.json = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--force') f.force = true;
    else if (a === '--overwrite-local') f.overwriteLocal = true;
    else if (a === '--force-unlock') f.forceUnlock = true;
    else if (a === '--all') f.all = true;
    else if (a === '--skills-dir') {
      f.skillsDir = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      f.skillsDir = a.slice('--skills-dir='.length) || null;
    } else if (a === '--workspace') {
      f.workspace = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      f.workspace = a.slice('--workspace='.length) || null;
    } else if (a && !a.startsWith('--') && !f.skillName) {
      f.skillName = a;
    }
  }
  return f;
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

async function runInstall(args: string[]): Promise<void> {
  const flags = parseInstallFlags(args);
  if (flags.help) {
    console.log(HELP_INSTALL);
    process.exit(0);
  }
  if (!flags.all && !flags.skillName) {
    console.error('Error: pass a skill name or --all.\n');
    console.error(HELP_INSTALL);
    process.exit(2);
  }
  const gbrainRoot = findGbrainRoot();
  if (!gbrainRoot) {
    console.error('Error: could not find gbrain repo root.');
    process.exit(2);
  }

  // Resolve target: workspace (parent of skills/) is required for the
  // managed block + lockfile. skillsDir defaults to workspace/skills.
  let targetWorkspace: string | null = flags.workspace
    ? resolveAbs(flags.workspace)
    : null;
  let targetSkillsDir: string | null = flags.skillsDir
    ? resolveAbs(flags.skillsDir)
    : null;

  if (!targetSkillsDir) {
    const detected = autoDetectSkillsDir();
    if (detected.dir) {
      targetSkillsDir = detected.dir;
      if (!targetWorkspace) {
        // workspace is parent of skills/
        targetWorkspace = resolvePath(targetSkillsDir, '..');
      }
    }
  }
  if (!targetSkillsDir) {
    console.error(
      'Error: could not find a target skills directory. Set $OPENCLAW_WORKSPACE or pass --skills-dir / --workspace.',
    );
    process.exit(2);
  }
  if (!targetWorkspace) {
    targetWorkspace = resolvePath(targetSkillsDir, '..');
  }

  try {
    const plan = planInstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: flags.all ? null : flags.skillName!,
      overwriteLocal: flags.overwriteLocal,
      dryRun: flags.dryRun,
      forceUnlock: flags.forceUnlock,
    });
    const result = applyInstall(plan, {
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: flags.all ? null : flags.skillName!,
      overwriteLocal: flags.overwriteLocal,
      dryRun: flags.dryRun,
      forceUnlock: flags.forceUnlock,
    });

    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.summary.skippedLocallyModified === 0,
            dryRun: result.dryRun,
            gbrainRoot,
            targetWorkspace,
            targetSkillsDir,
            summary: result.summary,
            managedBlock: result.managedBlock,
            files: result.files.map(f => ({
              source: f.source,
              target: f.target,
              outcome: f.outcome,
              sharedDep: f.sharedDep,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      const label = flags.dryRun ? 'skillpack install --dry-run' : 'skillpack install';
      console.log(
        `${label}: ${result.summary.wroteNew} new, ${result.summary.wroteOverwrite} overwrites, ${result.summary.skippedIdentical} unchanged, ${result.summary.skippedLocallyModified} skipped (local edits)`,
      );
      for (const f of result.files) {
        if (f.outcome === 'skipped_identical') continue;
        const tag = f.outcome.padEnd(25);
        const dep = f.sharedDep ? ' [shared]' : '';
        console.log(`  ${tag} ${f.target}${dep}`);
      }
      if (result.managedBlock.applied) {
        console.log(`  managed-block           ${result.managedBlock.resolverFile}`);
      } else if (result.managedBlock.skippedReason === 'resolver_not_found') {
        console.log(
          `  warn: no RESOLVER.md / AGENTS.md in ${targetWorkspace} or ${targetSkillsDir} — managed block not written. Create one and re-run.`,
        );
      }
      if (result.summary.skippedLocallyModified > 0) {
        console.log(
          `\nNote: ${result.summary.skippedLocallyModified} file(s) differ from the bundle and were skipped. Pass --overwrite-local to replace them (loses local edits) or run \`gbrain skillpack diff <name>\` to inspect.`,
        );
      }
    }

    const exitCode = result.summary.skippedLocallyModified > 0 ? 1 : 0;
    process.exit(exitCode);
  } catch (err) {
    if (err instanceof InstallError || err instanceof BundleError) {
      if (flags.json) {
        console.log(
          JSON.stringify(
            { ok: false, error: (err as Error & { code?: string }).code, message: err.message },
            null,
            2,
          ),
        );
      } else {
        console.error(`skillpack install: ${err.message}`);
      }
      process.exit(err instanceof InstallError && err.code === 'lock_held' ? 2 : 2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const HELP_DIFF = `gbrain skillpack diff <name> [options]

Show per-file diff status between the bundle and the target workspace
for one skill. Read-only; no writes.

Options:
  --skills-dir PATH    Override target skills directory.
  --json               Machine-readable envelope.
  --help               Show this message.

Exit codes:
  0   every file matches the bundle
  1   at least one file differs (or is missing)
`;

async function runDiff(args: string[]): Promise<void> {
  const help = args.includes('--help') || args.includes('-h');
  if (help) {
    console.log(HELP_DIFF);
    process.exit(0);
  }
  const json = args.includes('--json');
  let targetSkillsDir: string | null = null;
  let skillName: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skills-dir') {
      targetSkillsDir = args[i + 1] ? resolveAbs(args[i + 1]) : null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      targetSkillsDir = resolveAbs(a.slice('--skills-dir='.length));
    } else if (a && !a.startsWith('--') && !skillName) {
      skillName = a;
    }
  }
  if (!skillName) {
    console.error('Error: pass a skill name.\n');
    console.error(HELP_DIFF);
    process.exit(2);
  }
  const gbrainRoot = findGbrainRoot();
  if (!gbrainRoot) {
    console.error('Error: could not find gbrain repo root.');
    process.exit(2);
  }
  if (!targetSkillsDir) {
    const detected = autoDetectSkillsDir();
    if (detected.dir) targetSkillsDir = detected.dir;
  }
  if (!targetSkillsDir) {
    console.error('Error: pass --skills-dir or set $OPENCLAW_WORKSPACE.');
    process.exit(2);
  }

  try {
    const diffs = diffSkill(gbrainRoot, skillName, targetSkillsDir);
    const clean = diffs.every(d => d.identical && d.existing);
    if (json) {
      console.log(JSON.stringify({ ok: clean, skillName, diffs }, null, 2));
    } else {
      console.log(`skillpack diff ${skillName} → ${targetSkillsDir}`);
      for (const d of diffs) {
        let tag: string;
        if (!d.existing) tag = 'missing  ';
        else if (d.identical) tag = 'identical';
        else tag = 'differs  ';
        console.log(`  ${tag}  ${d.target}  (src ${d.sourceBytes}B / tgt ${d.targetBytes}B)`);
      }
      console.log(clean ? '\n✓ all files match the bundle.' : '\n(run `gbrain skillpack install <name> --overwrite-local` to replace local-modified files.)');
    }
    process.exit(clean ? 0 : 1);
  } catch (err) {
    if (err instanceof BundleError) {
      if (json) {
        console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }, null, 2));
      } else {
        console.error(`skillpack diff: ${err.message}`);
      }
      process.exit(2);
    }
    throw err;
  }
}
