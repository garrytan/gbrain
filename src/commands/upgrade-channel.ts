/**
 * GBRA-224 W1: which release `gbrain upgrade` installs. The channel comes from `--channel`, then
 * GBRAIN_RELEASE_CHANNEL, then `self_upgrade.channel`, then stable (core/self-upgrade.ts resolveReleaseChannel).
 * Alpha keeps the install method's own path (null target); stable installs exactly the evidence-backed release
 * (core/stable-channel.ts), never moves below the running build except off a version the record withdrew, and
 * refuses with a typed code when stable has no usable release.
 */
import { VERSION } from '../version.ts';
import { loadConfig } from '../core/config.ts';
import { isNewerVersion } from '../core/semver.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { invalidChannelMessage, resolveReleaseChannel, type ChannelResolution } from '../core/self-upgrade.ts';
import { parseChannelArg, resolveStableRelease, stableFailureAction, stableFailureFix, stableFailureMessage, type StableFailure } from '../core/stable-channel.ts';

export type StableTarget = { version: string; commit: string };
type Resolved = Extract<ChannelResolution, { ok: true }>;
type Plan =
  | { kind: 'invalid'; resolution: Extract<ChannelResolution, { ok: false }> }
  | { kind: 'alpha'; resolution: Resolved }
  | { kind: 'stable_failure'; resolution: Resolved; failure: StableFailure }
  | { kind: 'stable_current'; resolution: Resolved; version: string }
  | { kind: 'stable_ahead'; resolution: Resolved; version: string }
  | { kind: 'stable_install'; resolution: Resolved; target: StableTarget; withdrawn: boolean };

/** Decide what the upgrade would do on the effective channel. Reads the stable record and tags; installs nothing. */
export async function planChannelUpgrade(args: readonly string[], oldVersion: string = VERSION, deps: Parameters<typeof resolveStableRelease>[0] = {}): Promise<Plan> {
  const resolution = resolveReleaseChannel(loadConfig(), parseChannelArg(args));
  if (!resolution.ok) return { kind: 'invalid', resolution };
  if (resolution.channel === 'alpha') return { kind: 'alpha', resolution };
  const stable = await resolveStableRelease(deps);
  if (!stable.ok) return { kind: 'stable_failure', resolution, failure: stable };
  const withdrawn = stable.record.known_bad.includes(oldVersion) && stable.version !== oldVersion;
  if (!withdrawn && !isNewerVersion(oldVersion, stable.version)) {
    return oldVersion === stable.version ? { kind: 'stable_current', resolution, version: stable.version } : { kind: 'stable_ahead', resolution, version: stable.version };
  }
  return { kind: 'stable_install', resolution, target: { version: stable.version, commit: stable.commit }, withdrawn };
}

const sourceLabel = (r: ChannelResolution) => r.source === 'flag' ? '--channel' : r.source === 'env' ? 'GBRAIN_RELEASE_CHANNEL' : r.source === 'config' ? 'self_upgrade.channel' : 'default';

function refuse(plan: Extract<Plan, { kind: 'invalid' | 'stable_failure' }>, oldVersion: string, json: boolean): void {
  if (plan.kind === 'invalid') {
    setCliExitVerdict(writeCliError(opError('invalid_params', invalidChannelMessage(plan.resolution), 'Use --channel stable or --channel alpha, or fix the value where it is set.'), 'upgrade', { json }));
    return;
  }
  const { failure, resolution } = plan;
  setCliExitVerdict(writeCliError(opError(failure.code, stableFailureMessage(failure), stableFailureFix(failure, resolution), {
    fix: stableFailureAction(failure, resolution),
    detail: `channel=stable (from ${sourceLabel(resolution)}); running ${oldVersion}; cause: ${failure.cause}`,
  }), 'upgrade', { json }));
}

/**
 * The release `--channel` (default: env, config, stable) selects: null on alpha, the stable release to install, or
 * 'stop' after reporting an invalid channel, an unusable stable channel (non-zero, typed code) or nothing to install.
 */
export async function channelTarget(args: readonly string[], oldVersion: string, json: boolean): Promise<StableTarget | null | 'stop'> {
  const plan = await planChannelUpgrade(args, oldVersion);
  if (plan.kind === 'invalid' || plan.kind === 'stable_failure') { refuse(plan, oldVersion, json); return 'stop'; }
  if (plan.kind === 'alpha') return null;
  if (plan.kind === 'stable_current') { console.log(`Already on the stable channel's release: gbrain ${oldVersion}.`); return 'stop'; }
  if (plan.kind === 'stable_ahead') {
    console.log(`gbrain ${oldVersion} is newer than the stable channel's release (${plan.version}); the stable channel never downgrades. Nothing was changed.`);
    return 'stop';
  }
  console.log(plan.withdrawn
    ? `gbrain ${oldVersion} was withdrawn from the stable channel (known_bad in the stable record); installing the current stable release, gbrain ${plan.target.version}.`
    : `Stable channel: installing gbrain ${plan.target.version} (promoted after its gates passed on this exact release).`);
  return plan.target;
}

/** `gbrain upgrade --dry-run` (without --restart-only): the effective channel, where it came from and what would install. */
export async function runUpgradeDryRun(args: readonly string[], json: boolean): Promise<boolean> {
  if (!args.includes('--dry-run')) return false;
  const plan = await planChannelUpgrade(args);
  if (plan.kind === 'invalid' || plan.kind === 'stable_failure') { refuse(plan, VERSION, json); return true; }
  const target = plan.kind === 'stable_install' ? plan.target.version : plan.kind === 'alpha' ? null : plan.version;
  const action = plan.kind === 'alpha' ? 'install_method_update' : plan.kind === 'stable_install' ? (plan.withdrawn ? 'install_withdrawn_replacement' : 'install') : 'none';
  if (json) {
    await writeJsonDocument(JSON.stringify({ dry_run: true, channel: plan.resolution.channel, channel_source: plan.resolution.source, current_version: VERSION, target_version: target, action }, null, 2));
    return true;
  }
  console.log(`Channel: ${plan.resolution.channel} (from ${sourceLabel(plan.resolution)})`);
  console.log(plan.kind === 'alpha'
    ? 'Would update through the install method to the newest published release.'
    : plan.kind === 'stable_install' ? `Would install gbrain ${target}${plan.withdrawn ? `, replacing the withdrawn ${VERSION}` : ''}.`
    : plan.kind === 'stable_current' ? `Already on the stable release, gbrain ${VERSION}.`
    : `gbrain ${VERSION} is ahead of stable (${target}); nothing would change.`);
  console.log('Dry run: nothing was changed.');
  return true;
}
