import { VERSION } from '../version.ts';
import { isValidVersionString } from '../core/semver.ts';
import { fetchChangelog, fetchLatestRelease } from './check-update.ts';
import { detectInstallMethod, runUpgrade } from './upgrade.ts';
import {
  invalidChannelMessage,
  offeredVersion,
  pendingUpgradeVersion,
  resolveReleaseChannel,
  writeSnooze,
  writeUpdateCache,
  type ReleaseChannel,
} from '../core/self-upgrade.ts';
import { parseChannelArg, stableFailureFix, stableFailureMessage } from '../core/stable-channel.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
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
 * `gbrain self-upgrade [--check-only] [--snooze] [--force] [--json] [--channel stable|alpha] [--no-bun-floor-check]`
 *
 * The universal substrate every agent ecosystem (Codex / Claude Code / Hermes /
 * OpenClaw / Perplexity-server) can call to stay current. The CLI startup hook
 * emits a marker; the agent skill / autopilot daemon act on it by running THIS
 * command. The action is always the hardcoded `gbrain upgrade` — never
 * parameterized by any marker content (forged-marker guard).
 *
 *   --check-only  Report whether an upgrade is available; never apply.
 *   --snooze      "Not now": hold this channel's notice for 24h, then 48h, then 7d.
 *   --force       Apply even if not behind (re-run the install-method swap).
 *   --json        Machine-readable output for the check.
 *   --channel     stable or alpha for this run (latest is an alias for alpha).
 *   --no-bun-floor-check  Passed through to `gbrain upgrade` (#5855).
 */
export async function runSelfUpgrade(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain self-upgrade [--check-only] [--force] [--json] [--channel stable|alpha] [--no-bun-floor-check]\n' +
        '       gbrain self-upgrade --snooze [--json]\n' +
        '       gbrain self-upgrade --clear-never-installed [--apply] [--json]\n\n' +
        'Check for and apply gbrain updates on this install\'s release channel (stable by default;\n' +
        'alpha follows every release). The shared entry point used by the CLI startup marker,\n' +
        'the gbrain-upgrade agent skill, and the autopilot silent channel.\n\n' +
        '  --check-only  Report whether an upgrade is available, on which channel and why; do not apply.\n' +
        '  --snooze      "Not now": hold this channel\'s update notice for 24h, then 48h, then 7d,\n' +
        '                however many releases ship meanwhile; an upgrade clears it.\n' +
        '  --force       Apply even when not behind.\n' +
        '  --json        Machine-readable output (with --check-only or --snooze).\n' +
        '  --channel     stable or alpha for this run (latest is an alias for alpha).\n' +
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
  const resolution = resolveReleaseChannel(loadConfig(), parseChannelArg(args));
  if (!resolution.ok) {
    setCliExitVerdict(writeCliError(opError('invalid_params', invalidChannelMessage(resolution), 'Use --channel stable or --channel alpha, or fix the value where it is set.'), 'self-upgrade', { json }));
    return;
  }
  const { channel } = resolution;
  if (args.includes('--snooze')) {
    runSnooze(channel, json);
    return;
  }

  const checkedAt = Date.now();
  const result = await fetchLatestRelease(channel);
  const release = result.ok ? result : null;
  const latest = release ? release.tag.replace(/^v/, '') : null;
  const offered = release ? offeredVersion(VERSION, latest, release.knownBad) : null;
  const withdrawn = !!release && offered !== null && release.knownBad.includes(VERSION);
  const stableFailure = !result.ok && 'cause' in result ? { code: result.reason, cause: result.cause } : null;

  // Warm the cache so the next invocation's startup hook can emit without a fetch.
  try {
    if (latest && isValidVersionString(latest)) {
      writeUpdateCache(
        offered ? { kind: 'upgrade_available', current: VERSION, latest: offered } : { kind: 'up_to_date', current: VERSION },
        { channel, latest, knownBad: release?.knownBad ?? [], checkedAt },
      );
    } else if (stableFailure) {
      writeUpdateCache(null, { channel, error: stableFailure, checkedAt });
    }
  } catch {
    /* best-effort */
  }

  if (checkOnly) {
    // Tell the operator WHAT they'd get: fetch the changelog only when actually
    // behind (so an up-to-date check stays a single release fetch). The agent
    // skill surfaces these "what's new" bullets in the notify prompt.
    let changelogDiff = '';
    if (offered && !withdrawn) {
      try {
        changelogDiff = await fetchChangelog(VERSION, offered);
      } catch {
        /* best-effort: an unavailable changelog must not block the check */
      }
    }
    const failure = stableFailure ? { code: stableFailure.code, message: stableFailureMessage(stableFailure), fix: stableFailureFix(stableFailure, resolution) } : null;
    if (json) {
      console.log(
        JSON.stringify(
          {
            current_version: VERSION,
            latest_version: latest ?? '',
            update_available: offered !== null,
            install_method: detectInstallMethod(),
            release_url: release?.url ?? '',
            changelog_diff: changelogDiff,
            channel,
            channel_source: resolution.source,
            ...(withdrawn ? { withdrawn: true } : {}),
            ...(failure ? { error: failure } : {}),
          },
          null,
          2,
        ),
      );
    } else if (failure) {
      console.log(`${failure.message} ${failure.fix}`);
    } else if (withdrawn) {
      console.log(`gbrain ${VERSION} was withdrawn from the stable channel. Run: gbrain self-upgrade (installs the current stable, ${offered})`);
    } else if (offered) {
      console.log(`Update available on the ${channel} channel: ${VERSION} -> ${offered}. Run: gbrain self-upgrade`);
      if (changelogDiff) {
        console.log('\nWhat changed:\n');
        console.log(changelogDiff);
      }
      if (release?.url) console.log(`\nRelease: ${release.url}`);
    } else {
      console.log(`gbrain ${VERSION} is up to date on the ${channel} channel.`);
    }
    return;
  }

  // Stable is resolved and verified again by gbrain upgrade (record + tags), which refuses with the typed code.
  if (!offered && !force && !stableFailure) {
    console.log(`gbrain ${VERSION} is up to date on the ${channel} channel.`);
    return;
  }

  // Apply: delegate to the hardcoded upgrade path (full swap + post-upgrade).
  // Pass the fetched target so runUpgrade can detect exact-tag no-op
  // "upgrades" instead of reporting false success (#4366).
  await runUpgrade([...args.filter((a) => a === '--no-bun-floor-check'), '--channel', channel], {
    targetVersion: offered && isValidVersionString(offered) ? offered : undefined,
  });
}

/** `gbrain self-upgrade --snooze`: record "Not now" for the offered version on this channel. */
function runSnooze(channel: ReleaseChannel, json: boolean): void {
  const offered = pendingUpgradeVersion(VERSION, Date.now(), channel);
  if (!offered) {
    if (json) console.log(JSON.stringify({ snoozed: false, channel, reason: 'no update is pending on this channel' }, null, 2));
    else console.log(`No gbrain update is pending on the ${channel} channel; nothing to snooze.`);
    return;
  }
  const record = writeSnooze(offered, Date.now(), channel);
  const until = new Date(record.until).toISOString();
  if (json) console.log(JSON.stringify({ snoozed: true, channel, version: offered, level: record.level, until }, null, 2));
  else console.log(`Snoozed the gbrain ${offered} update on the ${channel} channel until ${until} (run gbrain self-upgrade any time).`);
}
