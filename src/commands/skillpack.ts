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
import {
  RemoteSourceError,
  classifySpec,
  resolveSource,
} from '../core/skillpack/remote-source.ts';
import {
  ScaffoldThirdPartyError,
  runScaffoldThirdParty,
} from '../core/skillpack/scaffold-third-party.ts';
import { SkillpackManifestError } from '../core/skillpack/manifest-v1.ts';
import { VERSION } from '../version.ts';

const HELP_TOP = `gbrain skillpack <subcommand> [options]

Subcommands:
  list                       Print every skill bundled in openclaw.plugin.json.

  scaffold <name|source>     Copy a bundled skill OR a third-party skillpack
                             into your agent repo. Additive; refuses to
                             overwrite. Third-party sources: owner/repo,
                             https://...git, ./local-dir, ./local.tgz.
  scaffold --all             Scaffold every bundled skill (gbrain only).

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

  search [<query>]           Search the third-party registry catalog.
  info <name>                Show full metadata for a registry entry.
  registry [--url URL]       Show/set the configured registry URL.

  doctor <pack-dir>          Run the 10-dimension quality rubric over a
                             third-party pack. --quick (~5s), --fix to
                             auto-scaffold missing artifacts.
  init <name>                Scaffold a fresh skillpack tree (cathedral
                             default; --minimal opts out of test/e2e/evals).
  pack [<pack-dir>]          Run doctor then emit a deterministic
                             <name>-<version>.tgz tarball with SHA-256.
  endorse <name>             (Operator-only) Set the tier for a pack in
                             endorsements.json inside a registry repo clone.

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
    case 'search':
      await cmdSearch(rest);
      return;
    case 'info':
      await cmdInfo(rest);
      return;
    case 'registry':
      await cmdRegistry(rest);
      return;
    case 'doctor':
      await cmdDoctor(rest);
      return;
    case 'init':
      await cmdInit(rest);
      return;
    case 'pack':
      await cmdPack(rest);
      return;
    case 'endorse':
      await cmdEndorse(rest);
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
      'gbrain skillpack scaffold <name> | <source> | --all [--workspace PATH] [--dry-run] [--trust] [--no-cache] [--json]\n\n' +
      '<name>   — bundled skill slug (e.g. `book-mirror`)\n' +
      '<source> — third-party skillpack source. Accepted shapes:\n' +
      '             owner/repo                (expands to https://github.com/owner/repo)\n' +
      '             https://...git            (verbatim https URL)\n' +
      '             ./local/dir/              (local pack root)\n' +
      '             ./local/pack.tgz          (local tarball)\n' +
      '\nFlags:\n' +
      '  --workspace PATH    Target workspace (default: auto-detected)\n' +
      '  --all               Scaffold every bundled skill (gbrain only)\n' +
      '  --dry-run           Validate + report; no writes\n' +
      '  --trust             Skip first-install confirm prompt (CI / unattended agents)\n' +
      '  --no-cache          Force fresh clone/extract for third-party sources\n' +
      '  --json              Stable JSON envelope for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const trustFlag = args.includes('--trust');
  const noCache = args.includes('--no-cache');
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
    console.error('Error: pass a skill name, third-party source, or --all.');
    process.exit(2);
  }

  // Disambiguate bundled-skill name vs third-party source.
  //
  // Routing rules (in priority order):
  //   1. `--all`                                       → bundled --all sweep
  //   2. Spec contains `/` / `://` / ends in .tgz      → third-party direct
  //   3. Bare kebab AND matches a bundled-skill slug   → bundled (v0.36 path)
  //   4. Bare kebab AND NOT a bundled-skill slug       → third-party via registry
  const targetWorkspace = resolveWorkspace({ workspace });

  const isThirdPartyShape = !all && name !== null && /[\/:]|\.(tgz|tar\.gz)$/.test(name);

  if (!all && name !== null && !isThirdPartyShape) {
    // Check if the kebab name matches a bundled-skill slug.
    const gbrainRoot = findGbrainRoot();
    if (gbrainRoot) {
      try {
        const manifest = loadBundleManifest(gbrainRoot);
        const slugs = bundledSkillSlugs(manifest);
        if (!slugs.includes(name)) {
          // Not a bundled slug — try the registry.
          await runThirdPartyScaffold({
            spec: name,
            targetWorkspace,
            dryRun,
            trustFlag,
            noCache,
            json,
          });
          return;
        }
      } catch {
        // Fall through to the bundled path; it'll surface a clearer error.
      }
    }
  } else if (isThirdPartyShape) {
    await runThirdPartyScaffold({
      spec: name!,
      targetWorkspace,
      dryRun,
      trustFlag,
      noCache,
      json,
    });
    return;
  }

  const gbrainRoot = findGbrainOrDie();
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
      // Next-action hint for the agent + the operator. Print only on
      // actual writes (re-runs that just skip are noise-quieter).
      if (!dryRun && result.summary.wroteNew > 0) {
        const onboardingPath = join(targetWorkspace, 'skills', '_AGENT_README.md');
        console.log(
          `\nNext: your agent walks \`skills/*/SKILL.md\` frontmatter \`triggers:\` for routing.\nIf this is a fresh install, read ${onboardingPath} for the agent contract.\nWhen gbrain ships an update later, run \`gbrain skillpack reference --all\` to sweep.`,
        );
      }
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
// scaffold — third-party source path (new in v0.37)
// ---------------------------------------------------------------------------

interface ThirdPartyScaffoldOptions {
  spec: string;
  targetWorkspace: string;
  dryRun: boolean;
  trustFlag: boolean;
  noCache: boolean;
  json: boolean;
}

async function runThirdPartyScaffold(opts: ThirdPartyScaffoldOptions): Promise<void> {
  // Step 1: resolve the source. Kebab names get a registry lookup first;
  // everything else hits the direct resolveSource() path.
  let resolved;
  let registryTier: 'endorsed' | 'community' | 'experimental' | 'dead' | undefined;
  try {
    const cls = classifySpec(opts.spec);
    if (cls.kind === 'kebab') {
      // Registry path: load catalog, find pack, follow to URL.
      const { loadRegistry, findPackWithTier } = await import('../core/skillpack/registry-client.ts');
      const loaded = await loadRegistry({});
      const found = findPackWithTier(loaded, cls.normalized);
      if (!found) {
        console.error(
          `Error: no skillpack named "${cls.normalized}" in the registry (${loaded.registry_url}).\n` +
            `Run \`gbrain skillpack search ${cls.normalized}\` for matches, or pass a full source (owner/repo, https URL, ./path, ./*.tgz).`,
        );
        process.exit(2);
      }
      registryTier = found.tier;
      resolved = resolveSource(found.entry.source.url, { noCache: opts.noCache });
    } else {
      resolved = resolveSource(opts.spec, { noCache: opts.noCache });
    }
  } catch (err) {
    if (err instanceof RemoteSourceError) {
      console.error(`skillpack scaffold: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // Step 2: orchestrator handles manifest validation, trust prompt, copy,
  // state.json update, and bootstrap display.
  try {
    const result = await runScaffoldThirdParty(
      {
        resolved,
        targetWorkspace: opts.targetWorkspace,
        trustFlag: opts.trustFlag,
        dryRun: opts.dryRun,
        tier: registryTier,
      },
      VERSION,
    );

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.status !== 'aborted_no_trust',
            status: result.status,
            pack: {
              name: result.manifest.name,
              version: result.manifest.version,
              author: result.manifest.author,
            },
            source: result.resolved.source,
            source_kind: result.resolved.kind,
            pinned_commit: result.resolved.pinned_commit,
            tarball_sha256: result.resolved.tarball_sha256,
            cache_hit: result.resolved.cache_hit,
            trust: { trusted: result.trustDecision.trusted, reason: result.trustDecision.reason },
            copy: result.copy?.summary ?? null,
            bootstrap_shown: result.bootstrap.shown,
          },
          null,
          2,
        ),
      );
    } else {
      if (result.status === 'aborted_no_trust') {
        console.error(
          `skillpack scaffold: aborted (trust decision: ${result.trustDecision.reason}). No files written.`,
        );
        process.exit(1);
      }
      const m = result.manifest;
      const summary = result.copy?.summary;
      console.log(
        `${opts.dryRun ? 'scaffold (dry-run)' : 'scaffold'}: ${m.name}@${m.version} by ${m.author}` +
          (summary
            ? ` — ${summary.wroteNew} wrote, ${summary.skippedExisting} skipped`
            : ''),
      );
      if (result.resolved.kind !== 'local') {
        console.log(
          `Source: ${result.resolved.source}` +
            (result.resolved.pinned_commit ? ` @ ${result.resolved.pinned_commit.slice(0, 12)}` : ''),
        );
      }
      if (result.bootstrap.shown) {
        // Bootstrap framing on stderr so stdout stays clean for the agent contract.
        process.stderr.write('\n' + result.bootstrap.text + '\n');
      }
      if (!opts.dryRun && summary && summary.wroteNew > 0) {
        console.log(
          `\nNext: your agent walks skills/*/SKILL.md frontmatter triggers: for routing.\n` +
            `Run \`gbrain skillpack reference ${m.name}\` later if upstream changes.`,
        );
      }
    }
    process.exit(result.status === 'aborted_no_trust' ? 1 : 0);
  } catch (err) {
    if (err instanceof ScaffoldThirdPartyError || err instanceof SkillpackManifestError) {
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
        const { changedSlugsSinceVersion } = await import('../core/skillpack/bundle.ts');
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
    // Next-action hint for the agent on a successful strip.
    if (result.status === 'fence_stripped' && !dryRun) {
      console.log(
        '\nNext: your routing model just changed. The managed-block fence is gone.\nYour agent should walk `skills/*/SKILL.md` frontmatter `triggers:` for routing.\nPreserved table rows are a transitional bridge — once frontmatter walking is\nconfirmed working, run `gbrain skillpack scrub-legacy-fence-rows` to clean up.\nFresh install? Read `skills/_AGENT_README.md` for the full agent contract.',
      );
    }
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
// search / info / registry  (registry catalog reads)
// ---------------------------------------------------------------------------

async function cmdSearch(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack search [<query>] [--tier endorsed|community|experimental|dead] [--json] [--refresh] [--url URL]',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  let query: string | undefined;
  let tier: 'endorsed' | 'community' | 'experimental' | 'dead' | undefined;
  let urlOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tier') {
      tier = args[i + 1] as typeof tier;
      i++;
    } else if (a === '--url') {
      urlOverride = args[i + 1];
      i++;
    } else if (a && !a.startsWith('--') && !query) {
      query = a;
    }
  }

  const { loadRegistry, searchPacks } = await import('../core/skillpack/registry-client.ts');
  const loaded = await loadRegistry({ url: urlOverride, refresh });
  const results = searchPacks(loaded, { query, tier });

  if (json) {
    console.log(
      JSON.stringify(
        {
          registry_url: loaded.registry_url,
          origin: loaded.origin,
          cache_age_ms: loaded.cache_age_ms,
          query: query ?? null,
          tier_filter: tier ?? null,
          count: results.length,
          results: results.map((r) => ({
            name: r.entry.name,
            version: r.entry.version,
            description: r.entry.description,
            author: r.entry.author,
            tier: r.tier,
            tags: r.entry.tags,
            homepage: r.entry.homepage,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (results.length === 0) {
    console.log(`(no skillpacks matched${query ? ` "${query}"` : ''}${tier ? ` (tier=${tier})` : ''})`);
    process.exit(0);
  }
  console.log(`${results.length} skillpack${results.length === 1 ? '' : 's'} (from ${loaded.registry_url})\n`);
  for (const r of results) {
    const tierBadge = r.tier === 'endorsed' ? '★' : r.tier === 'community' ? '·' : r.tier === 'experimental' ? '?' : '✗';
    console.log(`  ${tierBadge} ${r.entry.name}@${r.entry.version}  [${r.tier}]`);
    console.log(`    ${r.entry.description}`);
    console.log(`    by ${r.entry.author}  ·  ${r.entry.homepage}`);
    if (r.entry.tags.length > 0) console.log(`    tags: ${r.entry.tags.join(', ')}`);
    console.log('');
  }
  process.exit(0);
}

async function cmdInfo(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain skillpack info <name> [--json] [--refresh] [--url URL]');
    process.exit(0);
  }
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  let name: string | undefined;
  let urlOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') {
      urlOverride = args[i + 1];
      i++;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!name) {
    console.error('Error: pass a skillpack name.');
    process.exit(2);
  }

  const { loadRegistry, findPackWithTier } = await import('../core/skillpack/registry-client.ts');
  const loaded = await loadRegistry({ url: urlOverride, refresh });
  const found = findPackWithTier(loaded, name);
  if (!found) {
    console.error(`Error: no skillpack named "${name}" in ${loaded.registry_url}.`);
    process.exit(2);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          name: found.entry.name,
          version: found.entry.version,
          description: found.entry.description,
          author: found.entry.author,
          author_handle: found.entry.author_handle,
          homepage: found.entry.homepage,
          tier: found.tier,
          tags: found.entry.tags,
          source: found.entry.source,
          tarball_sha256: found.entry.tarball_sha256,
          gbrain_min_version: found.entry.gbrain_min_version,
          validated_at: found.entry.validated_at,
          validation_run_id: found.entry.validation_run_id,
          skills_count: found.entry.skills_count,
          skills: found.entry.skills,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  console.log(`${found.entry.name}@${found.entry.version}  [${found.tier}]`);
  console.log(`  Description:   ${found.entry.description}`);
  console.log(`  Author:        ${found.entry.author} (@${found.entry.author_handle})`);
  console.log(`  Homepage:      ${found.entry.homepage}`);
  console.log(`  Source:        ${found.entry.source.url}`);
  console.log(`  Pinned commit: ${found.entry.source.pinned_commit}`);
  console.log(`  Tarball SHA:   sha256:${found.entry.tarball_sha256}`);
  console.log(`  gbrain min:    ${found.entry.gbrain_min_version}`);
  console.log(`  Validated:     ${found.entry.validated_at} (run ${found.entry.validation_run_id})`);
  console.log(`  Tags:          ${found.entry.tags.join(', ')}`);
  console.log(`  Skills (${found.entry.skills_count}):`);
  for (const s of found.entry.skills) console.log(`    - ${s}`);
  console.log('\nTo scaffold:');
  console.log(`  gbrain skillpack scaffold ${found.entry.name}`);
  process.exit(0);
}

async function cmdRegistry(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack registry [--url URL] [--refresh] [--json]\n' +
        '\n' +
        '  --url URL    Set the registry URL (writes to ~/.gbrain/config.json)\n' +
        '  --refresh    Force a fresh fetch from the current registry URL\n' +
        '  --json       JSON output for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  let setUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      setUrl = args[i + 1];
      i++;
    }
  }

  if (setUrl) {
    // Persist to ~/.gbrain/config.json under skillpack.registry_url.
    const { gbrainPath } = await import('../core/config.ts');
    const cfgPath = gbrainPath('config.json');
    let cfg: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
    }
    (cfg as Record<string, unknown>).skillpack = {
      ...((cfg.skillpack as Record<string, unknown>) ?? {}),
      registry_url: setUrl,
    };
    const tmp = cfgPath + '.tmp';
    const fs = await import('fs');
    fs.mkdirSync(require('path').dirname(cfgPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, cfgPath);
    console.log(`Set skillpack.registry_url = ${setUrl}`);
  }

  const { loadRegistry, resolveRegistryUrl } = await import('../core/skillpack/registry-client.ts');
  const url = resolveRegistryUrl({});
  try {
    const loaded = await loadRegistry({ refresh });
    if (json) {
      console.log(
        JSON.stringify(
          {
            registry_url: loaded.registry_url,
            origin: loaded.origin,
            cache_age_ms: loaded.cache_age_ms,
            skillpack_count: loaded.catalog.skillpacks.length,
            updated_at: loaded.catalog.updated_at,
            bundles: Object.keys(loaded.catalog.bundles ?? {}),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Registry: ${loaded.registry_url}`);
      console.log(`Origin:   ${loaded.origin}` + (loaded.cache_age_ms !== null ? ` (${loaded.cache_age_ms}ms old)` : ''));
      console.log(`Updated:  ${loaded.catalog.updated_at}`);
      console.log(`Skillpacks: ${loaded.catalog.skillpacks.length}`);
      const bundleNames = Object.keys(loaded.catalog.bundles ?? {});
      if (bundleNames.length > 0) console.log(`Bundles:   ${bundleNames.join(', ')}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error(`Currently configured registry: ${url}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// doctor — quality rubric runner
// ---------------------------------------------------------------------------

async function cmdDoctor(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack doctor <pack-dir> [--quick|--full] [--fix] [--yes] [--json]\n\n' +
        '  <pack-dir>   Path to the skillpack root (where skillpack.json lives)\n' +
        '  --quick      Structural rubric (~5s, no sandbox/LLM/DB) — default\n' +
        '  --full       Add publish-gate suite execution (lands in a follow-up wave)\n' +
        '  --fix        Auto-scaffold missing pieces flagged auto_fixable=true\n' +
        '  --yes        Skip confirm prompts (CI / unattended)\n' +
        '  --json       Stable JSON envelope for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const fix = args.includes('--fix');
  const yes = args.includes('--yes');
  const mode = args.includes('--full') ? 'full' : 'quick';
  let packDir: string | undefined;
  for (const a of args) {
    if (a && !a.startsWith('--') && !packDir) packDir = a;
  }
  if (!packDir) {
    console.error('Error: pass the path to the pack root (where skillpack.json lives).');
    process.exit(2);
  }
  const packRoot = resolveAbs(packDir);

  const { runDoctor, formatDoctorResult } = await import('../core/skillpack/doctor.ts');
  const result = await runDoctor({ packRoot, mode, fix, yes });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDoctorResult(result));
  }

  // Exit codes: 0 if score=10, 1 if 6-9, 2 if blocked/<5.
  if (result.tier_eligibility === 'blocked' || result.score < 5) {
    process.exit(2);
  }
  if (result.score < 10) process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// init — publisher scaffold
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack init <name> [--target PATH] [--minimal] [--author NAME] [--license SPDX] [--homepage URL] [--dry-run] [--json]\n\n' +
        '  <name>       Pack name (lowercase kebab; becomes manifest.name + dir leaf)\n' +
        '  --target     Target dir (default: ./<name>)\n' +
        '  --minimal    Skip test/, e2e/, evals/ (advanced; doctor will score lower)\n' +
        '  --dry-run    Report intent, no writes\n' +
        '  --json       JSON envelope for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const minimal = args.includes('--minimal');
  const dryRun = args.includes('--dry-run');
  let name: string | undefined;
  let target: string | undefined;
  let author: string | undefined;
  let license: string | undefined;
  let homepage: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') {
      target = args[i + 1];
      i++;
    } else if (a === '--author') {
      author = args[i + 1];
      i++;
    } else if (a === '--license') {
      license = args[i + 1];
      i++;
    } else if (a === '--homepage') {
      homepage = args[i + 1];
      i++;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!name) {
    console.error('Error: pass the new skillpack name.');
    process.exit(2);
  }

  const { runInitScaffold, InitScaffoldError } = await import('../core/skillpack/init-scaffold.ts');
  const targetDir = resolveAbs(target ?? `./${name}`);

  try {
    const result = runInitScaffold({
      targetDir,
      name,
      minimal,
      author,
      license,
      homepage,
      dryRun,
    });
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dry_run: dryRun,
            target: result.targetDir,
            files_written: result.filesWritten,
            files_skipped_existing: result.filesSkippedExisting,
            manifest: result.manifest,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `${dryRun ? 'init (dry-run)' : 'init'}: ${result.filesWritten.length} files written, ${result.filesSkippedExisting.length} skipped (already existed) at ${result.targetDir}`,
      );
      if (result.filesSkippedExisting.length > 0 && !dryRun) {
        console.log('\nSkipped existing files (preserved):');
        for (const p of result.filesSkippedExisting) console.log(`  ${p}`);
      }
      if (!dryRun) {
        console.log(
          `\nNext:\n  cd ${result.targetDir}\n  gbrain skillpack doctor . --quick\n  # iterate, then:\n  gbrain skillpack pack`,
        );
      }
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof InitScaffoldError) {
      console.error(`skillpack init: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// pack — publisher tarball emit + local validation
// ---------------------------------------------------------------------------

async function cmdPack(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack pack [<pack-dir>] [--out PATH] [--dry-run] [--skip-doctor] [--json]\n\n' +
        '  <pack-dir>    Pack root (default: .)\n' +
        '  --out PATH    Output dir for the tarball (default: <pack-dir>)\n' +
        '  --dry-run     Validate only, no tarball\n' +
        '  --skip-doctor Skip the doctor gate (publish-gate skill uses this)\n' +
        '  --json        JSON envelope for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const skipDoctor = args.includes('--skip-doctor');
  let packDir: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      outDir = args[i + 1];
      i++;
    } else if (a && !a.startsWith('--') && !packDir) {
      packDir = a;
    }
  }
  const packRoot = resolveAbs(packDir ?? '.');

  const { runPackPublish, PackPublishError } = await import('../core/skillpack/pack-publish.ts');
  try {
    const result = await runPackPublish({
      packRoot,
      outDir: outDir ? resolveAbs(outDir) : undefined,
      dryRun,
      skipDoctor,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.refused_reason) {
      console.error(`skillpack pack: refused — ${result.refused_reason}`);
      if (result.doctor) {
        const blocked = result.doctor.dimensions.filter((d) => !d.passed && d.category === 'core');
        for (const d of blocked) console.error(`  ✗ ${d.name}: ${d.detail}`);
      }
      console.error('\nRun `gbrain skillpack doctor . --fix --yes` to auto-scaffold what you can, then re-run.');
      process.exit(2);
    } else if (result.tarball) {
      console.log(`pack: ${result.pack_name}@${result.pack_version} -> ${result.tarball.outPath}`);
      console.log(`  SHA-256:        sha256:${result.tarball.sha256}`);
      console.log(`  File count:     ${result.tarball.fileCount}`);
      console.log(`  Compressed:     ${result.tarball.compressedBytes} bytes`);
      console.log(`  Tier eligible:  ${result.tarball.tier_eligibility}`);
    } else {
      console.log(`pack (dry-run): ${result.pack_name}@${result.pack_version} — doctor verdict ${result.doctor?.tier_eligibility ?? '(skipped)'}`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof PackPublishError) {
      console.error(`skillpack pack: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// endorse — Garry-only registry tier override (operator workflow)
// ---------------------------------------------------------------------------

async function cmdEndorse(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack endorse <name> [--tier endorsed|community|experimental|dead] [--repo PATH] [--note TEXT] [--push] [--dry-run] [--json]\n\n' +
        '  <name>     Pack name as it appears in registry.json\n' +
        '  --tier     Target tier (default: endorsed)\n' +
        '  --repo     Path to a clone of the registry repo (default: .)\n' +
        '  --note     Optional human note recorded in endorsements.json\n' +
        '  --push     git push origin HEAD after committing\n' +
        '  --dry-run  Report what would change without writing or committing\n' +
        '  --json     Stable JSON envelope for agent consumption\n\n' +
        'This is the Garry-only operator workflow. It writes endorsements.json + commits;\n' +
        'requires a clone of garrytan/gbrain-skillpack-registry (or any registry-shaped repo).',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const push = args.includes('--push');
  let name: string | undefined;
  let tier: 'endorsed' | 'community' | 'experimental' | 'dead' | undefined;
  let repo: string | undefined;
  let note: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tier') {
      tier = args[i + 1] as typeof tier;
      i++;
    } else if (a === '--repo') {
      repo = args[i + 1];
      i++;
    } else if (a === '--note') {
      note = args[i + 1];
      i++;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!name) {
    console.error('Error: pass a skillpack name.');
    process.exit(2);
  }

  const { runEndorse, EndorseError } = await import('../core/skillpack/endorse.ts');
  const registryRepoRoot = resolveAbs(repo ?? '.');

  try {
    const result = runEndorse({
      registryRepoRoot,
      packName: name,
      tier,
      note,
      push,
      dryRun,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const verb = dryRun ? 'would endorse' : 'endorsed';
      const fromTo = result.prior_tier
        ? `${result.prior_tier} -> ${result.new_tier}`
        : `(unset) -> ${result.new_tier}`;
      console.log(`${verb}: ${result.pack_name} ${fromTo}`);
      if (result.commit_sha) console.log(`commit: ${result.commit_sha}`);
      if (result.pushed) console.log(`pushed to origin`);
      if (dryRun) console.log(`\n(no writes; re-run without --dry-run to commit)`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof EndorseError) {
      console.error(`skillpack endorse: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
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
