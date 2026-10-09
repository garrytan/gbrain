import type { BrainEngine } from '../core/engine.ts';
import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { parseSemver, semverGt } from '../core/semver.ts';
import { jsonRequested, setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { opError, type OperationError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { VERSION } from '../version.ts';
import type { InteractiveProbe } from '../core/interaction.ts';
import { migrationLedgerSummary } from '../core/migration-ledger.ts';
import { MIGRATIONS_RUNNING_EXIT_CODE, readMigrationLockHolder } from '../core/migration-orchestration-lock.ts';
import {
  BUN_FLOOR_EXIT_CODE,
  evaluateBunFloor,
  globalGbrainSpec,
  readBunLinkTarget,
  readHostBun,
  readPackageTarget,
  type TargetFloor,
} from '../core/bun-floor.ts';

const GBRAIN_GITHUB_REPO = 'garrytan/gbrain';

/**
 * Compare the post-swap resolved version against the caller's target (#4366).
 * `bun update` exits 0 without upgrading exact-tag Git installs (the pin
 * wins), so exit status alone cannot prove a swap happened. 'unverified'
 * (missing/unparseable observed version) keeps legacy fail-open behavior —
 * only a confirmed still-older version is a 'mismatch'.
 */
export function assessUpgradeOutcome(
  target: string | undefined,
  observed: string,
): 'ok' | 'mismatch' | 'unverified' {
  if (!target) return 'ok';
  const t = parseSemver(target);
  const o = parseSemver(observed.trim());
  if (!t || !o) return 'unverified';
  return semverGt(t, o) ? 'mismatch' : 'ok';
}

export async function runUpgrade(args: string[], opts: { targetVersion?: string } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain upgrade [--swap-only] [--no-autopilot-install] [--no-bun-floor-check]\n\nSelf-update the CLI.\n\nDetects install method (bun, binary, clawhub) and runs the appropriate update.\nAfter upgrading, shows what\'s new and offers to set up new features.\n\n--no-autopilot-install  Skip autopilot installation and service rewrites, including package postinstall.\n                       Also supported as GBRAIN_NO_AUTOPILOT_INSTALL=1.\n--no-bun-floor-check    Upgrade even when the target release\'s Bun floor cannot be read or is above\n                       this host\'s Bun (manual upgrades only). Docs: docs/guides/upgrades-auto-update.md#bun-floor.\n--swap-only  Perform ONLY the binary/source swap and skip post-upgrade\n             (migrations run on the next launch). Used by the autopilot\n             silent self-upgrade channel so the daemon can swap + relaunch\n             without a 30-min blocking post-upgrade inside its tick.');
    return;
  }

  // --swap-only: do the swap, skip the (potentially 30-min) post-upgrade. The
  // relaunched binary runs migrations on boot (split-brain guard). v0.42.
  const swapOnly = args.includes('--swap-only');
  const noAutopilotInstall = args.includes('--no-autopilot-install') || process.env.GBRAIN_NO_AUTOPILOT_INSTALL === '1';
  const checkBunFloor = !args.includes('--no-bun-floor-check');
  // #5693: post-upgrade owns migrations, so package postinstall skips them.
  const upgradeEnv = { ...process.env, GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1', ...(noAutopilotInstall ? { GBRAIN_NO_AUTOPILOT_INSTALL: '1' } : {}) };

  // Capture old version BEFORE upgrading (Codex finding: old binary runs this code)
  const oldVersion = VERSION;
  const method = detectInstallMethod();

  console.log(`Detected install method: ${method}`);

  let upgraded = false;
  const recovery: SmokeRecovery = { method, oldVersion };
  switch (method) {
    case 'bun-link': {
      const linkInfo = detectBunLink();
      if (!linkInfo) {
        console.error('bun-link detected but could not resolve repo root.');
        break;
      }
      console.log(`Upgrading bun-link source clone at ${linkInfo.repoRoot}...`);
      // #5855: fast-forward to the exact commit whose Bun floor was checked.
      const checked = checkBunFloor ? readBunLinkTarget(linkInfo.repoRoot) : null;
      if (checked && refuseForBunFloor(checked.target, opts.targetVersion)) return;
      const sha = checked?.sha;
      try { recovery.previousSha = execFileSync('git', ['-C', linkInfo.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 10_000 }).trim(); } catch { /* recovery text falls back */ }
      recovery.repoRoot = linkInfo.repoRoot;
      try {
        execFileSync('git', ['-C', linkInfo.repoRoot, ...(sha ? ['merge', '--ff-only', sha] : ['pull', '--ff-only'])], { stdio: 'inherit', timeout: 120_000 });
        execFileSync('bun', ['install'], { cwd: linkInfo.repoRoot, env: upgradeEnv, stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        if (installedDespiteFailure(oldVersion)) upgraded = true;
        else {
          console.error('Auto-upgrade failed. Try manually:');
          console.error(`  cd ${linkInfo.repoRoot} && git pull && bun install`);
        }
      }
      break;
    }

    case 'bun': {
      console.log('Upgrading via bun...');
      const bunGlobalRoot = resolveBunGlobalRoot();
      if (checkBunFloor && refuseForBunFloor(await readPackageTarget(globalGbrainSpec(bunGlobalRoot)), opts.targetVersion)) return;
      try {
        execFileSync('bun', ['update', 'gbrain'], { cwd: bunGlobalRoot, env: upgradeEnv, stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        if (installedDespiteFailure(oldVersion)) upgraded = true;
        else {
          console.error('Upgrade failed. Try running manually:');
          console.error(`  cd ${bunGlobalRoot} && bun update gbrain`);
        }
      }
      break;
    }

    case 'binary': {
      // v0.42: real atomic self-update on the published targets
      // (darwin-arm64, linux-x64). Other platforms have no asset → notify.
      const { runBinarySelfUpdate } = await import('../core/binary-self-update.ts');
      console.log('Updating gbrain binary (atomic download + replace)...');
      const result = await runBinarySelfUpdate();
      if (result.ok) {
        upgraded = true;
      } else if (result.reason === 'unsupported_platform' || result.reason === 'no_asset') {
        console.log('No published binary for this platform/arch.');
        console.log('Download the latest binary from GitHub Releases:');
        console.log('  https://github.com/garrytan/gbrain/releases');
      } else if (
        result.reason === 'integrity_failed' ||
        result.reason === 'integrity_unavailable' ||
        result.reason === 'version_mismatch'
      ) {
        // Fail-closed: the downloaded binary was never installed (renamed over
        // the live path). "signed" is intentionally omitted — we match against
        // the build-provenance attestation's digest + builder identity fetched
        // over TLS from the GitHub API; we do NOT independently verify the
        // Sigstore signature chain (see src/core/binary-self-update.ts header).
        const detail =
          result.reason === 'integrity_failed'
            ? 'the downloaded binary did not match its build-provenance attestation (digest/builder mismatch)'
            : result.reason === 'version_mismatch'
              ? 'the downloaded binary reported a different version than the release it was fetched for (possible downgrade)'
              : 'the build-provenance attestation could not be fetched (offline, rate-limited, or missing)';
        console.error(`Binary self-update rejected — integrity not confirmed: ${detail}.`);
        console.error('Your existing binary is unchanged and the download was discarded.');
        console.error('Retry later, or download + verify manually:');
        console.error('  https://github.com/garrytan/gbrain/releases');
        recordUpgradeError({
          phase: 'binary-self-update',
          fromVersion: oldVersion,
          toVersion: opts.targetVersion ?? result.targetVersion ?? 'unknown',
          error: result.reason,
          hint: 'Integrity check failed; existing binary retained. Retry or download manually.',
        });
      } else {
        console.error(`Binary self-update failed (${result.reason}${result.error ? `: ${result.error}` : ''}).`);
        console.error('Your existing binary is unchanged. Download manually if needed:');
        console.error('  https://github.com/garrytan/gbrain/releases');
        recordUpgradeError({
          phase: 'binary-self-update',
          fromVersion: oldVersion,
          toVersion: opts.targetVersion ?? result.targetVersion ?? 'unknown',
          error: `${result.reason}${result.error ? `: ${result.error}` : ''}`,
          hint: 'Download from https://github.com/garrytan/gbrain/releases',
        });
      }
      break;
    }

    case 'clawhub':
      console.log('Upgrading via ClawHub...');
      if (checkBunFloor && refuseForBunFloor(await readPackageTarget(null), opts.targetVersion)) return;
      try {
        execSync('clawhub update gbrain', { env: upgradeEnv, stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error('ClawHub upgrade failed. Try: clawhub update gbrain');
      }
      break;

    default:
      console.error('Could not detect installation method.');
      console.log('Try one of:');
      console.log('  bun update gbrain');
      console.log('  clawhub update gbrain');
      console.log('  Download from https://github.com/garrytan/gbrain/releases');
  }

  if (!upgraded) {
    console.log('Binary: upgrade failed');
    return;
  }
  const newVersion = verifyUpgrade();
  // #4366: a still-older resolved version means the swap never happened
  // (exact-tag Git pins make `bun update` a successful no-op). Fail loudly
  // and return BEFORE the breadcrumb/cache bookkeeping below, so the
  // pending-upgrade marker survives and keeps nagging.
  const target = opts.targetVersion;
  if (target && assessUpgradeOutcome(target, newVersion) === 'mismatch') {
    console.error(`Upgrade did not take effect: still running ${newVersion}, expected ${target}.`);
    console.error('Exact-tag Git installs stay pinned through `bun update`. Reinstall with:');
    console.error(`  ${bunReinstallCommand(`#v${target}`)}`);
    recordUpgradeError({
      phase: 'verify-target',
      fromVersion: oldVersion,
      toVersion: target,
      error: `still running ${newVersion} after upgrade`,
      hint: bunReinstallCommand(`#v${target}`),
    });
    setCliExitVerdict(1);
    return;
  }
  // #5311: a bare `gbrain upgrade` has no target, so the check above cannot
  // fire, and on an exact-tag Git pin `bun update` is a successful no-op.
  // When the version did not change and the global install pins a tag, say
  // so and exit non-zero instead of reporting an upgrade.
  if (!target && method === 'bun' && newVersion && newVersion === oldVersion) {
    const pin = bunGlobalExactTagPin(resolveBunGlobalRoot());
    if (pin) {
      const { pendingUpgradeVersion } = await import('../core/self-upgrade.ts');
      const latest = pendingUpgradeVersion(oldVersion);
      const reinstall = bunReinstallCommand(latest ? `#v${latest}` : '');
      console.error(`Upgrade did not take effect: still running ${newVersion}, because the global install is pinned to ${pin} and \`bun update\` keeps a pinned tag.`);
      console.error('Reinstall to move off the pin:');
      console.error(`  ${reinstall}`);
      recordUpgradeError({
        phase: 'verify-pin',
        fromVersion: oldVersion,
        toVersion: latest ?? 'latest',
        error: `pinned to ${pin}; still running ${newVersion} after upgrade`,
        hint: reinstall,
      });
      setCliExitVerdict(1);
      return;
    }
  }
  // Save old version for post-upgrade migration detection
  saveUpgradeState(oldVersion, newVersion);
  // #5855: `--version` answers on any Bun, so prove the new release starts.
  if (!postSwapSmoke(newVersion, recovery)) return;

  // Self-upgrade breadcrumb + cache reset (covers both the full and
  // --swap-only paths, so the autopilot silent channel benefits too):
  //   - write just-upgraded-from so the next invocation's startup hook prints
  //     the one-time JUST_UPGRADED confirmation;
  //   - clear the update-check cache + snooze so a now-stale "upgrade
  //     available" marker doesn't keep nudging after we've already applied it.
  try {
    const su = await import('../core/self-upgrade.ts');
    su.writeJustUpgraded(oldVersion);
    su.clearUpdateCache();
    su.clearSnooze();
  } catch {
    /* best-effort: never block the upgrade on confirmation bookkeeping */
  }

  // --swap-only stops here: the swap is done + smoke-verified, but the
  // (potentially 30-min) post-upgrade is deferred to the next launch so the
  // autopilot silent channel can swap + relaunch without freezing its tick.
  // connectEngine's pending-migration probe + runPostUpgrade run on boot.
  if (swapOnly) {
    return;
  }
  // Run post-upgrade feature discovery (reads migration files from the NEW binary).
  // Timeout bumped 300s → 1800s (30 min) in v0.15.2 because v0.12.0 graph
  // backfill on 50K+ brains regularly exceeded the old ceiling. The heartbeat
  // wiring added in v0.15.2 makes the long wait observable; a hard 300s
  // cap would still kill legit migrations mid-run. Override via
  // GBRAIN_POST_UPGRADE_TIMEOUT_MS env var.
  const postUpgradeTimeoutMs = Number(
    process.env.GBRAIN_POST_UPGRADE_TIMEOUT_MS || 1_800_000,
  );
  let migrationsLine = 'Migrations: complete';
  try {
    execFileSync('gbrain', ['post-upgrade', ...(noAutopilotInstall ? ['--no-autopilot-install'] : [])], { env: upgradeEnv, stdio: 'inherit', timeout: postUpgradeTimeoutMs });
  } catch (e) {
    migrationsLine = await describeMigrationFailure(e, newVersion);
    // post-upgrade is best-effort, don't fail the upgrade. BUT leave a
    // trail so `gbrain doctor` can surface it and give the user a clear
    // paste-ready recovery command. Silent failure here is how users end
    // up with half-upgraded brains and no signal. A competing runner is
    // not a failure: its own run finishes the migrations.
    if ((e as { status?: number }).status !== MIGRATIONS_RUNNING_EXIT_CODE) recordUpgradeError({
      phase: 'post-upgrade',
      fromVersion: oldVersion,
      toVersion: newVersion,
      error: e instanceof Error ? e.message : String(e),
      hint: 'Run: gbrain apply-migrations --yes',
    });
  }
  // Run features scan to show what's new and what to fix
  try {
    execSync('gbrain features', { stdio: 'inherit', timeout: 30_000 });
  } catch {
    // features scan is best-effort
  }
  console.log(`Binary: installed ${newVersion || 'a new version (could not verify)'}`);
  console.log(migrationsLine);
  // #6317 (I2): upgrade owns no relaunch, so the supervisor proves data movement after it restarts serve and the workers.
  console.log(`Next: ${(await import('./sources-writer-movement.ts')).MOVEMENT_SUPERVISOR_STEP}`);
}

/**
 * #5855: the Bun floor of the release `gbrain upgrade` would install for this
 * install method (the autopilot channel's pre-swap check). The swap re-reads
 * it, so a floor raised in between still refuses there.
 */
export async function readInstallTargetFloor(method: string): Promise<TargetFloor> {
  if (method === 'bun-link') {
    const link = detectBunLink();
    return link ? readBunLinkTarget(link.repoRoot).target : { ok: false, failedRead: 'the bun-link source clone could not be found' };
  }
  return readPackageTarget(method === 'bun' ? globalGbrainSpec(resolveBunGlobalRoot()) : null);
}

/**
 * #5855: refuse a swap whose target the host's Bun cannot start, or whose
 * floor cannot be read. Prints the refusal and sets the floor exit code,
 * which the autopilot channel treats as a hold rather than a failed version.
 */
function refuseForBunFloor(target: TargetFloor, targetVersion: string | undefined): boolean {
  const verdict = evaluateBunFloor(target, readHostBun(), targetVersion);
  if (verdict.ok) return false;
  console.error(verdict.message);
  console.error(verdict.kind === 'unreadable'
    ? 'Nothing was changed. Re-run with --no-bun-floor-check to upgrade without this check.'
    : 'Nothing was changed.');
  setCliExitVerdict(BUN_FLOOR_EXIT_CODE);
  return true;
}

interface SmokeRecovery { method: string; oldVersion: string; repoRoot?: string; previousSha?: string }

/**
 * #5855: after the swap, run a command that passes the CLI's runtime gate
 * (`--version` is exempt from it). A failure prints per-method recovery and
 * exits non-zero; nothing is rolled back automatically.
 */
function postSwapSmoke(newVersion: string, r: SmokeRecovery): boolean {
  const run = spawnSync('gbrain', ['--help'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 60_000,
    env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
  });
  if (run.status === 0) return true;
  const why = run.error ? run.error.message : `exit ${run.status ?? run.signal}`;
  const detail = (run.stderr ?? '').trim().split('\n')[0];
  const back = r.method === 'bun-link' && r.repoRoot && r.previousSha
    ? `git -C ${r.repoRoot} checkout ${r.previousSha} && bun install`
    : r.method === 'bun' ? bunReinstallCommand(`#v${r.oldVersion}`) : null;
  console.error(`gbrain ${newVersion || '(new version)'} was installed but does not start: \`gbrain --help\` failed (${why}).${detail ? `\n  ${detail}` : ''}`);
  console.error('Recovery:');
  console.error('  If it names an old Bun: bun upgrade, then gbrain post-upgrade');
  if (back) console.error(`  To return to ${r.oldVersion}: ${back}`);
  recordUpgradeError({
    phase: 'post-swap-smoke',
    fromVersion: r.oldVersion,
    toVersion: newVersion || 'unknown',
    error: `gbrain --help failed after the swap (${why})${detail ? `: ${detail}` : ''}`,
    hint: back ? `bun upgrade && gbrain post-upgrade, or return to ${r.oldVersion}: ${back}` : 'bun upgrade && gbrain post-upgrade',
  });
  setCliExitVerdict(1);
  return false;
}

/**
 * #5693: an install step can fail or time out after the new version is
 * already in place (postinstall work outlived the install timeout). Treat a
 * newer `gbrain --version` as a completed swap instead of reporting failure.
 */
function installedDespiteFailure(oldVersion: string): boolean {
  try {
    const observed = execSync('gbrain --version', { encoding: 'utf-8', timeout: 10_000 }).trim().replace(/^gbrain\s*/i, '');
    const o = parseSemver(observed), prior = parseSemver(oldVersion);
    if (!o || !prior || !semverGt(o, prior)) return false;
    console.log(`The install step did not finish cleanly, but gbrain ${observed} is installed. Migrations run in post-upgrade.`);
    return true;
  } catch {
    return false;
  }
}

export async function describeMigrationFailure(error: unknown, newVersion: string): Promise<string> {
  if ((error as { status?: number }).status === MIGRATIONS_RUNNING_EXIT_CODE) {
    const { loadConfig } = await import('../core/config.ts');
    const config = loadConfig();
    const holder = config ? await readMigrationLockHolder(config) : null;
    return `Migrations: running (host ${holder?.host ?? 'unknown'}, pid ${holder?.pid ?? 'unknown'}) in another apply-migrations. `
      + 'Wait for it to finish; `gbrain doctor` shows migration progress.';
  }
  const wedged = newVersion ? migrationLedgerSummary(newVersion).wedged : [];
  const command = wedged.length > 0
    ? `${wedged.map(v => `gbrain apply-migrations --force-retry ${v}`).join(' && ')} && gbrain apply-migrations --yes`
    : 'gbrain apply-migrations --yes';
  return `Migrations: failed. Run: ${command}`;
}

export function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    return join(bunInstall, 'install', 'global');
  }

  const defaultRoot = join(process.env.HOME || '', '.bun', 'install', 'global');
  if (isBunGlobalRoot(defaultRoot)) {
    return defaultRoot;
  }

  const installRoot = findBunInstallRootFromArgv();
  return installRoot ?? defaultRoot;
}

/**
 * #5034 / B-NEW-5: reinstall the global Bun package at `ref` by removing it
 * first. An in-place `bun add -g` / `bun install --global` tag swap over an
 * existing global install fails with DependencyLoop on Bun 1.3 and, on Bun
 * 1.4, exits 0 without swapping while it corrupts the global package.json
 * and bun.lock.
 */
export function bunReinstallCommand(ref: string): string {
  return `bun remove -g gbrain && bun add -g github:${GBRAIN_GITHUB_REPO}${ref}`;
}

/**
 * #5311: the exact Git tag the bun global install pins gbrain to
 * (`github:garrytan/gbrain#v0.51.0`), or null for an unpinned or branch spec.
 */
export function bunGlobalExactTagPin(globalRoot: string): string | null {
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- globalRoot is resolveBunGlobalRoot(): Bun's own global install dir from BUN_INSTALL or HOME
    const pkg = JSON.parse(readFileSync(join(globalRoot, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> };
    const spec = pkg.dependencies?.gbrain;
    if (typeof spec !== 'string') return null;
    return /#v?\d+\.\d+(\.\d+)*$/.test(spec.trim()) ? spec.trim() : null;
  } catch {
    return null;
  }
}

function isBunGlobalRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

function findBunInstallRootFromArgv(): string | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 10; i++) {
      if (basename(dir) === 'gbrain' && basename(dirname(dir)) === 'node_modules') {
        const root = dirname(dirname(dir));
        if (isBunGlobalRoot(root)) return root;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function verifyUpgrade(): string {
  try {
    const output = execSync('gbrain --version', { encoding: 'utf-8', timeout: 10_000 }).trim();
    console.log(`Upgrade complete. Now running: ${output}`);
    return output.replace(/^gbrain\s*/i, '').trim();
  } catch {
    console.log('Upgrade complete. Could not verify new version.');
    return '';
  }
}

/**
 * Append a structured record to ~/.gbrain/upgrade-errors.jsonl when a
 * best-effort phase of the upgrade fails (e.g., `gbrain post-upgrade`
 * silently bombing). Without this trail, users end up with half-upgraded
 * brains and no signal. `gbrain doctor` reads this file and surfaces the
 * paste-ready recovery hint. Failures here are themselves best-effort.
 */
export function recordUpgradeError(record: {
  phase: string;
  fromVersion: string;
  toVersion: string;
  error: string;
  hint: string;
}): void {
  try {
    const dir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'upgrade-errors.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      phase: record.phase,
      from_version: record.fromVersion,
      to_version: record.toVersion,
      error: record.error,
      hint: record.hint,
    }) + '\n';
    appendFileSync(path, line);
  } catch {
    // Recording errors is itself best-effort. The user will still see the
    // underlying failure in stdout/stderr from the original command.
  }
}

function saveUpgradeState(oldVersion: string, newVersion: string) {
  try {
    const dir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'upgrade-state.json');
    const state: Record<string, unknown> = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf-8'))
      : {};
    state.last_upgrade = {
      from: oldVersion,
      to: newVersion,
      ts: new Date().toISOString(),
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

/**
 * Post-upgrade feature discovery + migration application.
 *
 * Two responsibilities:
 *   1. Print feature_pitch headlines for migrations newer than the prior
 *      binary (cosmetic; runs only when upgrade-state.json is readable and
 *      has a from/to pair).
 *   2. Invoke `gbrain apply-migrations --yes` so the mechanical side of
 *      every outstanding migration actually executes (schema, smoke, prefs,
 *      host rewrites, autopilot install). This is the Codex H8 fix:
 *      previously runPostUpgrade early-returned when upgrade-state.json
 *      was missing, which meant every broken-v0.11.0 install stayed broken.
 *      apply-migrations now runs unconditionally (idempotent; cheap when
 *      nothing is pending).
 *
 * Migration enumeration uses the TS registry at
 * src/commands/migrations/index.ts (Codex K) — no filesystem walk of
 * skills/migrations/*.md, so compiled binaries see the same set source
 * installs do.
 */
/**
 * v0.32.3 search-lite mode banner, moved out of runPostUpgrade unchanged.
 */
async function printSearchModeUpgradeBanner(engine: BrainEngine): Promise<void> {
  // One-shot: fires at most once per install (state persisted via `search.mode_upgrade_notice_shown`).
  // Reframes from "behavior is regressing" to "named modes available" per [CDX-1+2+3]: the production
  // query op still defaults expand=true and limit=20.
  try {
    const shown = await engine.getConfig('search.mode_upgrade_notice_shown');
    const existingMode = await engine.getConfig('search.mode');
    if (shown !== 'true' && !existingMode) {
      printSearchModeBanner();
      await engine.setConfig('search.mode_upgrade_notice_shown', 'true');
    }
  } catch {
    // Banner is cosmetic; never block the upgrade.
  }
}

/**
 * v0.42 self-upgrade setup (file plane; idempotent). Default existing installs
 * to `notify` (a nudge, not autonomy — `auto` stays an explicit opt-in), show a
 * one-time informational banner, and rewrite an existing autopilot systemd unit
 * to Restart=always so the silent channel's exit-for-relaunch respawns.
 */
async function applySelfUpgradeSetup(noAutopilotInstall: boolean): Promise<void> {
  try {
    const { loadConfig, saveConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (cfg) {
      const su = cfg.self_upgrade ?? {};
      let changed = false;
      if (su.mode === undefined) {
        su.mode = 'notify';
        changed = true;
      }
      if (!su.mode_prompted) {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[gbrain] Self-upgrade is ON in NOTIFY mode.');
        console.log('[gbrain] Every gbrain invocation now checks for new versions and');
        console.log('[gbrain] nudges when one is available. Apply with: gbrain self-upgrade');
        console.log('[gbrain]');
        console.log('[gbrain] Hands-off (silent quiet-hours auto-upgrade for always-on installs):');
        console.log('[gbrain]   gbrain config set self_upgrade.mode auto');
        console.log('[gbrain] Turn it off entirely: gbrain config set self_upgrade.mode off');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
        su.mode_prompted = true;
        changed = true;
      }
      if (changed) {
        cfg.self_upgrade = su;
        saveConfig(cfg);
      }
    }
  } catch {
    /* best-effort */
  }
  if (noAutopilotInstall) return;
  try {
    const { migrateSystemdUnitToRestartAlways } = await import('./autopilot.ts');
    const r = migrateSystemdUnitToRestartAlways();
    if (r.rewritten) {
      console.log('[gbrain] Updated autopilot systemd unit to Restart=always (self-upgrade relaunch).');
    }
  } catch {
    /* best-effort */
  }
}

export async function runPostUpgrade(args: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain post-upgrade [--no-autopilot-install] [--json]');
    console.log('Prints feature pitches for new migrations and runs apply-migrations.');
    console.log('--no-autopilot-install (or GBRAIN_NO_AUTOPILOT_INSTALL=1) skips autopilot installation and service rewrites.');
    console.log('--json prints one result document on stdout (progress and banners go to stderr).');
    console.log('Idempotent — safe to re-run any time.');
    return;
  }
  // D2: under --json the human lines go to stderr (the guard) and this report is the one document.
  const json = jsonRequested(args);
  const report: PostUpgradeReport = { status: 'ok', warnings: [] };

  // v0.35.8.0: lay down ~/.gbrain/.gitignore retroactively. Existing users
  // never re-run `gbrain init`, so init-only coverage misses them entirely
  // (codex F-CDX-8). Idempotent + non-clobbering — safe to run every upgrade.
  try {
    const { ensureGitignore } = await import('../core/config.ts');
    ensureGitignore();
  } catch { /* Best-effort hygiene; never block upgrade. */ }

  // v0.42 self-upgrade setup: default existing installs to NOTIFY (a nudge, no
  // autonomy), inform once, and rewrite an existing systemd unit to
  // Restart=always so the silent channel's exit-for-relaunch respawns. All
  // file-plane + mechanical + idempotent; never blocks the upgrade.
  const noAutopilotInstall = args.includes('--no-autopilot-install') || process.env.GBRAIN_NO_AUTOPILOT_INSTALL === '1';
  await applySelfUpgradeSetup(noAutopilotInstall);
  // Cosmetic: print feature pitches for migrations newer than the prior binary.
  try {
    const statePath = join(process.env.HOME || '', '.gbrain', 'upgrade-state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const from = state?.last_upgrade?.from;
      if (from) {
        const { migrations } = await import('./migrations/index.ts');
        for (const m of migrations) {
          if (isNewerThan(m.version, from)) {
            console.log('');
            console.log(`NEW: ${m.featurePitch.headline}`);
            if (m.featurePitch.description) console.log(m.featurePitch.description);
            if (m.featurePitch.recipe) {
              console.log(`Run \`gbrain integrations show ${m.featurePitch.recipe}\` to set it up.`);
            }
            console.log('');
          }
        }
      }
    }
  } catch {
    // Pitch printing is cosmetic — don't gate migrations on it.
  }

  (await import('../core/post-upgrade-notice.ts')).writePostUpgradeCliNotice(); // F7: safety notice ([AGENT] block for agents)
  // Mechanical: run every outstanding migration. Idempotent; exits 0 quickly
  // when nothing is pending. Stays inside the same process so a long Phase F
  // (autopilot install) doesn't hit a subprocess boundary.
  try {
    const { applyMigrations } = await import('./apply-migrations.ts');
    const { exitCode, failure } = await applyMigrations(['--yes', '--non-interactive', ...(noAutopilotInstall ? ['--no-autopilot-install'] : [])]);
    report.apply_migrations = { exit_code: exitCode ?? 0 };
    // A failure, a consent refusal (3) or a held migration lock (75) ends
    // post-upgrade here. 0 ("all migrations up to date", the common case on
    // an upgrade with no new orchestrator migration) continues: the schema
    // pass, banners, prompts and recovery checks below still run.
    if (exitCode !== undefined && exitCode !== 0) process.exit(finishPostUpgrade(json, report, exitCode, failure));
  } catch (e) {
    // Surface the error but don't throw — post-upgrade is best-effort.
    // Users can re-run `gbrain apply-migrations` manually if they want
    // to retry.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\napply-migrations failed: ${msg}`);
    console.error('Run `gbrain apply-migrations --yes` manually to retry.');
    report.warnings.push(`apply-migrations failed: ${msg}`);
  }

  // v0.28.5 (X1): explicitly apply pending schema migrations.
  // Since #3085, apply-migrations --yes applies schema-version drift itself
  // (it previously only WARNed), so the in-process call above may have
  // already run these — runMigrations is idempotent, making this hook a
  // harmless second pass. It stays because it also covers paths where the
  // preflight was skipped. We've shipped 11 wedge incidents asking users to
  // read warnings; keep the loop closed here.
  // A1's hasPendingMigrations probe in connectEngine is belt-and-suspenders
  // for any path that bypasses upgrade (autopilot, direct CLI on stale brain).
  try {
    const { loadConfig: lcSchema, toEngineConfig: toCfgSchema } = await import('../core/config.ts');
    const { createEngine } = await import('../core/engine-factory.ts');
    const cfgSchema = lcSchema();
    if (cfgSchema) {
      const engine = await createEngine(toCfgSchema(cfgSchema));
      try {
        await engine.connect(toCfgSchema(cfgSchema));
        await engine.initSchema();
        console.log('  Schema up to date.');
        report.schema = 'up_to_date';

        // v0.32.3 search-lite mode banner (one-shot, `search.mode_upgrade_notice_shown`).
        await printSearchModeUpgradeBanner(engine);

        // #5876: auto_chronicle now defaults on; one-shot [AGENT] cost + opt-out notice, best-effort.
        await (await import('../core/chronicle/upgrade-notice.ts')).printAutoChronicleUpgradeNotice(engine);
        await (await import('../core/feedback/upgrade-notice.ts')).printRetrievalFeedbackUpgradeNotice(engine);
        // Entity mention index: [AGENT] catch-up line while pages are due (best-effort).
        await (await import('../core/mentions/upgrade-notice.ts')).printMentionIndexUpgradeNotice(engine);

        // Temporal typed edges: one-shot [AGENT] notice (live-by-default graph reads + relationship check), best-effort.
        await (await import('../core/temporal-edges-upgrade-notice.ts')).printTemporalEdgesUpgradeNotice(engine);
        // #5575 memory trust: [AGENT] ask_user while unclaimed sources hold legacy rows; never claims or scans (best-effort).
        await (await import('../core/trust/claim-notice.ts')).printTrustClaimUpgradeNotice(engine);

        // Ambient-writeback consent ask (WP8): one-shot for EXISTING installs
        // upgrading into the feature. Personal brains only; double-gated on
        // its own sentinel + the setting being unset; [AGENT]-relayed;
        // never auto-enables; its own try/catch lives inside.
        {
          const { runWritebackNudge } = await import('../core/onboard/writeback-nudge.ts');
          await runWritebackNudge(engine, { context: 'post-upgrade' });
        }

        // Waiting-TTL pre-notice (one-shot, warn-before-act). The worker
        // gates its first sweep behind the SAME flag via runWaitingTtlTick
        // (notice → grace window → sweep) because daemon restarts never run
        // this CLI path — this banner is the interactive channel. Stamping
        // the ISO timestamp here starts the same grace clock, so an operator
        // who sees this banner gets the full window to tune before anything
        // is cancelled.
        try {
          const { admissionKilled, resolveTtlNames, countTtlExpiredWaiting, ttlNoticeGraceMs, TTL_NOTICE_SHOWN_KEY } =
            await import('../core/minions/admission.ts');
          const shown = await engine.getConfig(TTL_NOTICE_SHOWN_KEY);
          if ((shown == null || shown.trim() === '') && !admissionKilled()) {
            const ttlNames = await resolveTtlNames(engine);
            const { total: affected, by_name } = await countTtlExpiredWaiting(engine, ttlNames);
            const parts = [...ttlNames].map(([name, hours]) => `${name} > ${hours}h: ${by_name[name] ?? 0}`);
            console.log('');
            console.log(`⚠ [gbrain] Waiting-TTL is now active: queued jobs that never get claimed are`);
            console.log(`  cancelled after their per-type TTL (${parts.join('; ') || 'defaults'}).`);
            if (affected > 0) {
              console.log(`  ${affected} currently-queued job(s) already exceed their TTL and will be`);
              console.log(`  cancelled after a ${Math.round(ttlNoticeGraceMs() / 60_000)}min grace window`);
              console.log(`  (auditable error_text; visible in 'gbrain jobs stats').`);
            }
            console.log(`  Tune or disable: gbrain config set minions.ttl_waiting_hours.<name> <hours|0>`);
            console.log('');
            await engine.setConfig(TTL_NOTICE_SHOWN_KEY, new Date().toISOString());
          }
        } catch {
          // Banner is cosmetic; never block the upgrade.
        }

        // PR1: skill-catalog publish consent. New installs default ON at
        // `gbrain init`; EXISTING installs stay OFF (default-OFF runtime = no
        // silent capability grant on upgrade) until the owner opts in HERE.
        // One-time, gated by `mcp.publish_skills_prompted`. Strongly recommended.
        try {
          const prompted = await engine.getConfig('mcp.publish_skills_prompted');
          const { loadConfigFileOnly } = await import('../core/config.ts');
          const filePublication = loadConfigFileOnly()?.mcp?.publish_skills;
          const current = await engine.getConfig('mcp.publish_skills') ?? (filePublication == null ? null : String(filePublication));
          if (prompted !== 'true' && current == null) {
            const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived AND local_path IS NOT NULL');
            const dirLine = sources.length
              ? `${sources.length} registered content source(s); shared skills require reviewed source-local publication.`
              : 'No registered content root: choose a canonical source and complete host content migration first.';
            console.log('');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[gbrain] Publish your skills to MCP clients?');
            console.log('[gbrain] Codex desktop, Claude Code/Cowork, and Perplexity can then');
            console.log('[gbrain] DISCOVER approved source-scoped skill prose over `gbrain serve`.');
            console.log('[gbrain] This makes your MCP server dramatically more useful.');
            console.log('[gbrain]');
            console.log(`[gbrain] ${dirLine}`);
            console.log('[gbrain] Effect: the CONTENTS of your SKILL.md files become readable by');
            console.log('[gbrain] remote MCP callers you have authorized. Source code is NOT exposed.');
            console.log('[gbrain] Following updates, bundle bytes and skill editing require separate approval.');
            console.log('═══════════════════════════════════════════════════════════════');
            const { isInteractive } = await import('../core/interaction.ts');
            const isTty = isInteractive();
            let enabled = false;
            if (isTty) {
              enabled = await promptEnableSkillPublishing();
            } else {
              console.log('[AGENT] Relay this to your operator. Recommended: enable it.');
              console.log('[AGENT] Enable with: gbrain config set mcp.publish_skills true');
            }
            if (enabled) {
              await engine.setConfig('mcp.publish_skills', 'true');
              console.log('[gbrain] Skill publishing ENABLED. Disable anytime: gbrain config set mcp.publish_skills false');
            } else if (isTty) {
              console.log('[gbrain] Left disabled. Enable later: gbrain config set mcp.publish_skills true');
            }
            await engine.setConfig('mcp.publish_skills_prompted', 'true');
          }
        } catch {
          // Consent prompt is best-effort; never block the upgrade.
        }

        // v0.32.7 CJK wave: chunker-version bump → re-embed sweep.
        // Idempotent — `runReindex` short-circuits when no pages are pending.
        // A managed brain refuses the markdown reindex; name its drain instead.
        try {
          const { managedPersistenceEnabled } = await import('../core/persistence/ownership.ts');
          const managed = await managedPersistenceEnabled(engine);
          if (!managed) {
            const { runPostUpgradeReembedPrompt } = await import('../core/post-upgrade-reembed.ts');
            const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
            let modelString = 'openai:text-embedding-3-large';
            try { modelString = getEmbeddingModel(); } catch { /* gateway not configured — keep default */ }
            const promptResult = await runPostUpgradeReembedPrompt(engine, modelString);
            if (promptResult.proceeded) {
              const { runReindex } = await import('./reindex.ts');
              await runReindex(engine, ['--markdown'], { authorized: true }); // the TTY yes above is the consent
            }
          }
        } catch (re) {
          const msg = re instanceof Error ? re.message : String(re);
          console.warn(`\nChunker-bump reindex skipped: ${msg}`);
          report.warnings.push(`chunker-bump reindex skipped: ${msg}`);
          console.warn('Run `gbrain reindex --markdown` manually when ready.');
        }

        // Fix wave 3: run the wave checks once (full, not --fast) and relay a
        // preview-only recovery banner; applying stays the user's decision.
        try {
          const { postUpgradeRecoveryBanner } = await import('./doctor/upgrade-banner.ts');
          const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
          for (const line of await postUpgradeRecoveryBanner(engine, `host (${engine.kind}${brain ? `, id ${brain.brain_id}` : ''})`)) console.log(line);
        } catch (be) {
          console.warn(`\nRecovery checks skipped: ${be instanceof Error ? be.message : String(be)}. Run \`gbrain doctor --remediation-plan\` to preview.`);
        }
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    // Non-fatal: connection or DDL failure here falls back to the existing
    // user-facing WARN. apply-migrations.ts:296-302 already surfaces the
    // hint to run `gbrain init --migrate-only`.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`\nSchema auto-apply skipped: ${msg}`);
    report.schema = 'skipped';
    report.warnings.push(`schema auto-apply skipped: ${msg}`);
    console.warn('Run `gbrain init --migrate-only` manually if your brain is wedged.');
  }

  // v0.25.1: agent-readable advisory listing recommended skills the
  // workspace hasn't installed yet. No-op when everything is installed.
  try {
    const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
    const { VERSION } = await import('../version.ts');
    printAdvisoryIfRecommended({ version: VERSION, context: 'upgrade' });
  } catch {
    // Best-effort cosmetic surface; never block post-upgrade.
  }

  // v0.36 DX: skillpack reference sweep. After an upgrade, the gbrain bundle
  // may have shipped changes to scaffolded skills the host already has on
  // disk. Run `reference --all` automatically and print a one-line-per-skill
  // summary so the agent + operator see what drifted without manually
  // running the sweep. Skipped silently when:
  //   - GBRAIN_SKIP_REFERENCE_SWEEP=1 in env
  //   - no target workspace can be auto-detected (gbrain installed but
  //     never scaffolded anywhere)
  //   - the detected workspace IS the gbrain repo (dev-mode, would just
  //     compare gbrain against itself)
  //   - every scaffolded skill is identical (nothing to say)
  await postUpgradeReferenceSweep();

  // v0.41.18.0 (A4 + A18, T14): post-upgrade onboard banner. Fail-open;
  // doesn't engine-connect (lightweight TTY check only). The actual
  // recommendations need engine access via `gbrain onboard --check`;
  // the banner just nudges the user to run it.
  try {
    const { runUpgradeBanner } = await import('../core/onboard/init-nudge.ts');
    // The banner doesn't actually use the engine today; passing null-equivalent
    // would require a type widening. Skip the engine arg and let the banner
    // print the static nudge text.
    await runUpgradeBanner(null as never);
  } catch {
    // Fail-open per A18: never crash post-upgrade from the banner.
  }
  // #6317 (I2): the supervisor's step; bare, so the check inherits its default window.
  (json ? console.error : console.log)(`Next: ${(await import('./sources-writer-movement.ts')).MOVEMENT_SUPERVISOR_STEP}`);
  if (json) await writeJsonDocument(JSON.stringify(report));
}

/** The v0.32.3 one-shot search-mode banner post-upgrade prints (stdout; stderr under --json). */
function printSearchModeBanner(): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('[gbrain] v0.32.3 added named search modes (conservative/balanced/tokenmax).');
  console.log('[gbrain] Your current behavior is unchanged — the `query` op still defaults');
  console.log('[gbrain] expand=true and limit=20, same as v0.31.x.');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('[AGENT] Relay this matrix to your operator and ask which mode they want.');
  console.log('[AGENT] Recommended default: tokenmax (preserves current retrieval shape).');
  console.log('[AGENT] Run `gbrain config set search.mode <mode>` after they decide.');
  console.log('');
  console.log('Per-query cost @ 10K queries/mo (typical single-user volume):');
  console.log('');
  console.log('                  Haiku 4.5    Sonnet 4.6   Opus 4.7');
  console.log('                  ($1/M)       ($3/M)       ($5/M)');
  console.log('  conservative    $40/mo       $120/mo      $200/mo');
  console.log('  balanced        $100/mo      $300/mo      $500/mo');
  console.log('  tokenmax        $200/mo      $600/mo      $1,000/mo');
  console.log('');
  console.log('  (scales linearly — multiply by 10 for 100K/mo)');
  console.log('  25x corner-to-corner spread. Natural diagonal pairings span ~4x.');
  console.log('');
  console.log('To pick:');
  console.log('  gbrain search modes              # see what is running');
  console.log('  gbrain config set search.mode <conservative|balanced|tokenmax>');
  console.log('  gbrain search tune               # data-driven recommendations');
  console.log('');
  console.log('tokenmax bumps limit to 50 (current default is 20). To preserve');
  console.log('your EXACT current shape:');
  console.log('  gbrain config set search.mode tokenmax');
  console.log('  gbrain config set search.searchLimit 20');
  console.log('');
}

interface PostUpgradeReport {
  status: 'ok' | 'failed';
  apply_migrations?: { exit_code: number };
  schema?: 'up_to_date' | 'skipped';
  warnings: string[];
}

/**
 * D2: the exit status once apply-migrations ended the run. Success under
 * --json writes the report; a failure (apply-migrations already printed its
 * human lines) is one envelope leading with the report's keys.
 */
function finishPostUpgrade(json: boolean, report: PostUpgradeReport, exitCode: number, failure?: OperationError): number {
  if (exitCode === 0) {
    if (json) void writeJsonDocument(JSON.stringify(report));
    return 0;
  }
  report.status = 'failed';
  if (!json) return exitCode;
  const e = failure ?? opError('migration_failed', `apply-migrations exited with status ${exitCode}.`,
    'Read stderr for the failing migration, fix it, then run `gbrain post-upgrade` again.');
  return writeCliError(e, 'post-upgrade', { json: true, stderr: false, legacy: { ...report } });
}

/**
 * Run `reference --all` against the auto-detected host workspace and print
 * a one-line-per-skill summary of any drift. Best-effort; failures are
 * swallowed so a broken sweep never blocks post-upgrade.
 *
 * Exported (with optional `opts` test seam) for unit testing the gate
 * logic + output shape. Production callers pass no args — both paths are
 * auto-detected.
 */
export async function postUpgradeReferenceSweep(
  opts: { gbrainRoot?: string; targetWorkspace?: string } = {},
): Promise<void> {
  if (process.env.GBRAIN_SKIP_REFERENCE_SWEEP) return;
  try {
    const { autoDetectSkillsDirReadOnly } = await import('../core/repo-root.ts');
    const { findGbrainRoot } = await import('../core/skillpack/bundle.ts');
    const { runReferenceAll } = await import('../core/skillpack/reference.ts');
    const path = await import('path');

    // Allow tests to inject; default to auto-detection.
    let targetWorkspace = opts.targetWorkspace;
    if (!targetWorkspace) {
      const detected = autoDetectSkillsDirReadOnly();
      if (!detected.dir) return;
      targetWorkspace = path.resolve(detected.dir, '..');
    }

    const gbrainRoot = opts.gbrainRoot ?? findGbrainRoot();
    if (!gbrainRoot) return;

    // Dev-mode guard: the detected workspace IS the gbrain repo. Sweeping
    // gbrain against itself is always identical — print nothing.
    if (path.resolve(targetWorkspace) === path.resolve(gbrainRoot)) return;

    const result = runReferenceAll({ gbrainRoot, targetWorkspace });
    // Drifted = skills the host has actually scaffolded that now differ from
    // the bundle (local edits are legitimate — this is advisory).
    const drifted = result.skills.filter(
      s =>
        s.summary.identical + s.summary.differs > 0 &&
        (s.summary.differs > 0 || s.summary.missing > 0),
    );

    // New = skills the host never scaffolded (own body absent). These used to
    // be filtered out as "noise", which meant an upgrade that shipped brand-new
    // skills said nothing about them. Surface them via the currency classifier
    // (own-files aware) so new capability is discoverable — but ONLY for a host
    // that has already scaffolded at least one skill (a skills user missing the
    // new ones). A host with zero scaffolded skills has opted out; surfacing
    // every bundled skill on every upgrade would be exactly the noise the old
    // filter avoided, so it stays silent for them.
    let newSkills: string[] = [];
    try {
      const { computeSkillCurrency } = await import('../core/skillpack/skill-currency.ts');
      const currency = computeSkillCurrency({ gbrainRoot, targetWorkspace });
      const hasScaffolded = currency.counts.current > 0 || currency.counts.drifted > 0;
      if (hasScaffolded) {
        newSkills = currency.skills.filter(s => s.status === 'new').map(s => s.slug);
      }
    } catch {
      // Best-effort; drift report still prints below.
    }

    if (drifted.length === 0 && newSkills.length === 0) return;

    console.log('');
    console.log('Skillpack sweep (post-upgrade):');
    if (newSkills.length > 0) {
      const shown = newSkills.slice(0, 10);
      console.log(
        `  ${newSkills.length} new built-in skill(s) not installed here: ${shown.join(', ')}` +
          (newSkills.length > shown.length ? `, … +${newSkills.length - shown.length} more` : ''),
      );
      console.log('  Add them all: `gbrain skillpack sync`');
    }
    for (const s of drifted) {
      console.log(
        `  ${s.slug.padEnd(40)} differs:${s.summary.differs} missing:${s.summary.missing}`,
      );
    }
    console.log('');
    console.log(
      'New skills → `gbrain skillpack sync`. Drifted skills → `gbrain skillpack reference <slug>` (local edits are yours; nothing is overwritten).\nSee `skills/_AGENT_README.md` for what your agent should do on update.\nSkip this sweep: `GBRAIN_SKIP_REFERENCE_SWEEP=1`.',
    );
  } catch {
    // Best-effort. Never block post-upgrade.
  }
}

// findMigrationsDir + extractFeaturePitch removed in v0.11.1: migration data
// now lives in the TS registry at src/commands/migrations/index.ts so
// compiled binaries don't depend on filesystem skills/migrations/*.md
// (Codex K).

function isNewerThan(version: string, baseline: string): boolean {
  const v = version.split('.').map(Number);
  const b = baseline.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (b[i] || 0)) return true;
    if ((v[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

export function detectInstallMethod(): 'bun' | 'bun-link' | 'binary' | 'clawhub' | 'unknown' {
  const execPath = process.execPath || '';

  // v0.28.5 cluster D: bun-link signal first.
  // bun link puts a symlink at ~/.bun/bin/gbrain → either the source's bin
  // entry (compiled CLI) OR src/cli.ts directly. Either way, realpath
  // resolves into a directory we can walk up from to find a .git/config
  // pointing at our repo.
  const bunLinkResult = detectBunLink();
  if (bunLinkResult) return 'bun-link';

  // Check if running from node_modules (bun/npm install). Could be canonical
  // (we publish under garrytan/gbrain) OR the squatter (npm `gbrain@1.3.x`).
  // Sub-classify and warn loudly on suspect installs (#658).
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
    const verdict = classifyBunInstall();
    if (verdict === 'suspect') {
      printSquatterRecovery();
    }
    return 'bun';
  }

  // Check if running as compiled binary
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
    return 'binary';
  }

  // Check if clawhub is available (use --version, not which, to avoid false positives)
  try {
    execSync('clawhub --version', { stdio: 'pipe', timeout: 5_000 });
    return 'clawhub';
  } catch {
    // not available
  }

  return 'unknown';
}

/**
 * Detect bun-link source-clone installs (closes #656, fixes #368).
 *
 * Walk up from argv[1] looking for a `.git/config` whose remote url
 * contains `garrytan/gbrain` (case-insensitive substring).
 *
 * v0.28.5 gated on lstatSync(argv1).isSymbolicLink(), but bun resolves
 * the entire symlink chain before setting process.argv[1], so the check
 * always returned false and short-circuited detection. Now we skip the
 * symlink check and use argv[1] directly — it is already the real path
 * inside the checkout, which is exactly what the git-config walk needs.
 *
 * Returns { repoRoot } when confident; null otherwise (caller falls
 * through to the existing detection chain).
 */
export function detectBunLink(): { repoRoot: string } | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(resolve(argv1));
    for (let i = 0; i < 6; i++) {
      const gitConfigPath = join(dir, '.git', 'config');
      if (existsSync(gitConfigPath)) {
        try {
          const cfg = readFileSync(gitConfigPath, 'utf-8');
          if (cfg.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return { repoRoot: dir };
          }
        } catch { /* unreadable config — not our case */ }
        return null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * v0.28.5 cluster D, signal 2 — bun install authenticity check (closes #658).
 *
 * When `bun add -g gbrain` (or `npm install -g gbrain`) installs from
 * npm, the package is the squatter — an unrelated `gbrain@1.3.x` that
 * silently overwrites our binary. This function reads the install
 * directory's package.json and checks two non-spoofable signals:
 *   - `repository.url` contains `garrytan/gbrain` (case-insensitive)
 *   - the install dir contains a `src/cli.ts` file (squatter ships
 *     compiled binary, not source)
 *
 * If neither matches, returns 'suspect' and the caller surfaces a loud
 * recovery message. Codex's plan-review noted these signals are spoofable
 * by a determined squatter — accepted; this is best-effort warning, not
 * an assertion. The right structural fix is publishing under a scoped
 * name like `@garrytan/gbrain` (tracked v0.29 follow-up).
 */
function classifyBunInstall(): 'canonical' | 'suspect' {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return 'suspect';

    // Walk up from argv1 looking for the package.json that owns this install.
    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          const repoUrl = (typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository?.url) ?? '';
          if (repoUrl.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return 'canonical';
          }
          // Source-marker fallback: our published-as-source install always
          // ships src/cli.ts next to package.json. The squatter ships dist/.
          if (existsSync(join(dir, 'src', 'cli.ts'))) {
            return 'canonical';
          }
          return 'suspect';
        } catch {
          return 'suspect';
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'suspect';
  } catch {
    return 'suspect';
  }
}

function printSquatterRecovery(): void {
  console.warn('');
  console.warn('  WARNING: gbrain install does not appear to be from garrytan/gbrain.');
  console.warn('  This is likely the npm-name collision tracked in issue #658:');
  console.warn('    https://www.npmjs.com/package/gbrain (an unrelated package).');
  console.warn('');
  console.warn('  Recovery options:');
  console.warn('    1. Install from source:');
  console.warn('         bun remove -g gbrain');
  console.warn('         git clone https://github.com/garrytan/gbrain.git');
  console.warn('         cd gbrain && bun install && bun link');
  console.warn('');
  console.warn('    2. Download a release binary:');
  console.warn('         https://github.com/garrytan/gbrain/releases');
  console.warn('');
  console.warn('  See docs/INSTALL_FOR_AGENTS.md for the canonical install paths.');
  console.warn('');
}

/**
 * The one-time "Enable skill publishing now? (recommended) [Y/n]" prompt
 * (#4318 residual). Default yes: an empty line (Enter), `y` or `yes`
 * accepts; anything else, EOF, the prompt timeout or a non-interactive
 * caller declines (A5: never hang on a silent stdin). Seams for tests.
 */
export async function promptEnableSkillPublishing(
  opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; probe?: InteractiveProbe; timeoutMs?: number } = {},
): Promise<boolean> {
  const { readLine } = await import('../core/interaction.ts');
  const answer = await readLine({ prompt: '[gbrain] Enable skill publishing now? (recommended) [Y/n] ', ...opts });
  if (answer.kind !== 'line') return false;
  const a = answer.text.toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}
