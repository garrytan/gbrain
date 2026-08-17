/**
 * `gbrain skillpack reference` — read-only diff lens + --apply-clean-hunks.
 *
 * Peeled from src/commands/skillpack.ts (module-size ratchet). Behavior is
 * unchanged from the façade version. Flag-registry note: this file is scanned
 * for skillpack's flag allowlist — spell foreign (non-skillpack) CLI flags
 * WITHOUT leading dashes in comments and strings.
 */

import { BundleError } from '../../core/skillpack/bundle.ts';
import {
  runReference,
  runReferenceAll,
  runReferenceApply,
} from '../../core/skillpack/reference.ts';
import { findGbrainOrDie, resolveWorkspace } from './shared.ts';

export async function cmdReference(args: string[]): Promise<void> {
  // Harness lane (cathedral-7): diff a harness install (stub-aware,
  // three-way local_edit vs upstream_drift) instead of a workspace.
  if (args.some(a => a === '--harness' || a.startsWith('--harness='))) {
    const { cmdReferenceHarness } = await import('./harness.ts');
    await cmdReferenceHarness(args);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack reference <name> | --all [--workspace PATH] [--apply-clean-hunks] [--since <version>] [--dry-run] [--json]\n\n' +
        '  --since <version>   With --all, restrict the sweep to skills whose source\n' +
        '                      changed in gbrain between <version> and HEAD. Useful\n' +
        '                      after `gbrain upgrade` to see only what moved.',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const apply = args.includes('--apply-clean-hunks');
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  let name: string | null = null;
  let workspace: string | null = null;
  let since: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    } else if (a === '--since') {
      since = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--since=')) {
      since = a.slice('--since='.length) || null;
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
      // Two-way merge warning fires BEFORE the apply. Goes to stderr so
      // it survives stdout redirection. Suppressed in --json mode so
      // machine consumers (CI, agent scripts) get a clean envelope; the
      // human-facing reason for the warning is documented in the JSON
      // output's `framing` field already, and the docstring on the
      // command-help covers it.
      const twoWayWarning =
        'WARNING: --apply-clean-hunks is a two-way diff against gbrain\'s CURRENT bundle.\n' +
        '         gbrain does NOT have access to the version you originally scaffolded.\n' +
        '         Hunks where your LOCAL edits differ from gbrain WILL be aligned to gbrain.\n' +
        '         If you have intentional local edits, run `gbrain skillpack reference ' + name + '`\n' +
        '         (read-only) first to inspect, OR pass --dry-run on this command.';
      if (!dryRun && !json) console.error(twoWayWarning);

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
        if (result.summary.totalHunksConflicted > 0) {
          console.log(
            '\nConflicts left in place. Run `gbrain skillpack reference ' + name + '` to inspect\nthe unified diffs and patch by hand. The conflict_missing / conflict_ambiguous\nlabels above indicate WHY the hunk could not be applied automatically.',
          );
        }
      }
      process.exit(0);
    }

    if (all) {
      const result = runReferenceAll({ gbrainRoot, targetWorkspace });
      // --since filter: keep only skills whose source changed in gbrain
      // since the given version. Falls back loudly when git can't resolve
      // the ref (tarball install, missing tag, etc).
      let sinceFilter: Set<string> | null = null;
      if (since) {
        const { changedSlugsSinceVersion } = await import('../../core/skillpack/bundle.ts');
        const slugs = changedSlugsSinceVersion(gbrainRoot, since);
        if (slugs === null) {
          console.error(
            `warn: --since '${since}' could not be resolved (no git checkout, missing tag, or git error). Falling back to full sweep.`,
          );
        } else {
          sinceFilter = new Set(slugs);
        }
      }
      const filteredSkills = sinceFilter
        ? result.skills.filter(s => sinceFilter!.has(s.slug))
        : result.skills;
      const filtered = { ...result, skills: filteredSkills };
      if (json) console.log(JSON.stringify(filtered, null, 2));
      else {
        console.log(result.framing);
        if (since && sinceFilter) {
          console.log(`(filtered to ${filteredSkills.length} skill(s) changed since ${since})`);
        }
        if (filteredSkills.length === 0) {
          console.log('  (no skills changed in the requested window)');
        }
        for (const s of filteredSkills) {
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
      // Per-category action hints for the agent.
      if (result.summary.missing > 0 || result.summary.differs > 0) {
        console.log('\nAgent decision policy per file:');
        if (result.summary.missing > 0) {
          console.log(
            '  missing → gbrain has a file you don\'t. Usually safe to `gbrain skillpack scaffold ' + name + '` again to land it.',
          );
        }
        if (result.summary.differs > 0) {
          console.log(
            '  differs → was your local edit intentional? Keep it (gbrain is reference, not law).\n            Accidental drift? Patch by hand, or `gbrain skillpack reference ' + name + ' --apply-clean-hunks`\n            (READ the two-way merge warning in that command\'s output first).',
          );
        }
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
