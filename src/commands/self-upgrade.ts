import { VERSION } from '../version.ts';
import { isNewerVersion, isValidVersionString } from '../core/semver.ts';
import { fetchChangelog, fetchLatestRelease } from './check-update.ts';
import { detectInstallMethod, runUpgrade } from './upgrade.ts';
import { writeUpdateCache } from '../core/self-upgrade.ts';
import { loadConfig, saveConfig } from '../core/config.ts';
import { CLEAR_NEVER_INSTALLED_APPLY, findNeverInstalledFailures } from '../core/self-upgrade-recovery.ts';

/**
 * `gbrain self-upgrade --clear-never-installed [--apply] [--json]` (#6828).
 * Preview by default: lists each `self_upgrade.failed_versions` entry the
 * audit proves was never installed (a no-op swap reported "swapped" and the
 * relaunch of the same version recorded it known-bad) and the entries it
 * keeps. `--apply` removes exactly the proven entries from the file-plane
 * config. Reversible: `gbrain config set self_upgrade.failed_versions` puts
 * one back. Nothing else changes and nothing is installed.
 */
function runClearNeverInstalled(apply: boolean, json: boolean): void {
  const { failed, clearable } = findNeverInstalledFailures();
  const clear = new Set(clearable.map((e) => e.version));
  const kept = failed.filter((v) => !clear.has(v));
  if (apply && clear.size > 0) {
    const cfg = loadConfig();
    if (cfg?.self_upgrade) {
      const remaining = (cfg.self_upgrade.failed_versions ?? []).filter((v) => !clear.has(v));
      if (remaining.length > 0) cfg.self_upgrade.failed_versions = remaining;
      else delete cfg.self_upgrade.failed_versions;
      saveConfig(cfg);
    }
  }
  const applied = apply && clear.size > 0;
  if (json) {
    console.log(JSON.stringify({
      failed_versions: failed,
      never_installed: clearable,
      kept,
      applied,
      ...(!apply && clear.size > 0 ? { next: { argv: CLEAR_NEVER_INSTALLED_APPLY } } : {}),
    }, null, 2));
    return;
  }
  if (clear.size === 0) {
    console.log(failed.length === 0
      ? 'No known-bad versions are recorded (self_upgrade.failed_versions is empty).'
      : `No known-bad version is proven never installed; keeping ${failed.join(', ')}.`);
    return;
  }
  console.log(applied ? 'Cleared known-bad versions that were never installed:' : 'Known-bad versions that were never installed:');
  for (const e of clearable) {
    console.log(`  ${e.version}: the swap at ${e.swapped_at} left ${e.running} running, and the relaunch of ${e.running} recorded ${e.version} known-bad at ${e.recorded_at}.`);
  }
  if (kept.length > 0) console.log(`Kept (not proven never installed): ${kept.join(', ')}`);
  if (applied) console.log('The auto channel installs them once they are published on its release channel.');
  else console.log(`Clear them: ${CLEAR_NEVER_INSTALLED_APPLY.join(' ')}`);
}

/**
 * `gbrain self-upgrade [--check-only] [--force] [--json] [--no-bun-floor-check]`
 *
 * The universal substrate every agent ecosystem (Codex / Claude Code / Hermes /
 * OpenClaw / Perplexity-server) can call to stay current. The CLI startup hook
 * emits a marker; the agent skill / autopilot daemon act on it by running THIS
 * command. The action is always the hardcoded `gbrain upgrade` — never
 * parameterized by any marker content (forged-marker guard).
 *
 *   --check-only  Report whether an upgrade is available; never apply.
 *   --force       Apply even if not behind (re-run the install-method swap).
 *   --json        Machine-readable output for the check.
 *   --no-bun-floor-check  Passed through to `gbrain upgrade` (#5855).
 */
export async function runSelfUpgrade(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain self-upgrade [--check-only] [--force] [--json] [--no-bun-floor-check]\n' +
        '       gbrain self-upgrade --clear-never-installed [--apply] [--json]\n\n' +
        'Check for and apply gbrain updates. The shared entry point used by the\n' +
        'CLI startup marker, the gbrain-upgrade agent skill, and the autopilot\n' +
        'silent channel.\n\n' +
        '  --check-only  Report whether an upgrade is available; do not apply.\n' +
        '  --force       Apply even when not behind.\n' +
        '  --json        Machine-readable output (with --check-only).\n' +
        '  --no-bun-floor-check  Apply even when the target\'s Bun floor cannot be read or is\n' +
        '                above this host\'s Bun. Docs: docs/guides/upgrades-auto-update.md#bun-floor\n' +
        '  --clear-never-installed  Preview the known-bad versions (self_upgrade.failed_versions) the\n' +
        '                audit proves were never installed; --apply removes exactly those.\n' +
        '                Docs: docs/guides/upgrades-auto-update.md#known-bad-never-installed',
    );
    return;
  }
  if (args.includes('--clear-never-installed')) {
    runClearNeverInstalled(args.includes('--apply'), args.includes('--json'));
    return;
  }

  const checkOnly = args.includes('--check-only');
  const force = args.includes('--force');
  const json = args.includes('--json');

  const result = await fetchLatestRelease();
  const release = result.ok ? result : null;
  const latest = release ? release.tag.replace(/^v/, '') : null;
  const behind = !!latest && isValidVersionString(latest) && isNewerVersion(VERSION, latest);

  // Warm the cache so the next invocation's startup hook can emit without a fetch.
  try {
    if (latest && isValidVersionString(latest)) {
      writeUpdateCache(
        behind
          ? { kind: 'upgrade_available', current: VERSION, latest }
          : { kind: 'up_to_date', current: VERSION },
      );
    }
  } catch {
    /* best-effort */
  }

  if (checkOnly) {
    // Tell the operator WHAT they'd get: fetch the changelog only when actually
    // behind (so an up-to-date check stays a single release fetch). The agent
    // skill surfaces these "what's new" bullets in the notify prompt.
    let changelogDiff = '';
    if (behind && latest) {
      try {
        changelogDiff = await fetchChangelog(VERSION, latest);
      } catch {
        /* best-effort: an unavailable changelog must not block the check */
      }
    }
    if (json) {
      console.log(
        JSON.stringify(
          {
            current_version: VERSION,
            latest_version: latest ?? '',
            update_available: behind,
            install_method: detectInstallMethod(),
            release_url: release?.url ?? '',
            changelog_diff: changelogDiff,
          },
          null,
          2,
        ),
      );
    } else if (behind) {
      console.log(`Update available: ${VERSION} -> ${latest}. Run: gbrain self-upgrade`);
      if (changelogDiff) {
        console.log('\nWhat changed:\n');
        console.log(changelogDiff);
      }
      if (release?.url) console.log(`\nRelease: ${release.url}`);
    } else {
      console.log(`gbrain ${VERSION} is up to date.`);
    }
    return;
  }

  if (!behind && !force) {
    console.log(`gbrain ${VERSION} is up to date.`);
    return;
  }

  // Apply: delegate to the hardcoded upgrade path (full swap + post-upgrade).
  // Pass the fetched target so runUpgrade can detect exact-tag no-op
  // "upgrades" instead of reporting false success (#4366).
  await runUpgrade(args.filter((a) => a === '--no-bun-floor-check'), {
    targetVersion: latest && isValidVersionString(latest) ? latest : undefined,
  });
}
