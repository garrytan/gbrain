/**
 * #6828 / #6718: the auto channel targeted master's VERSION (unpublished,
 * ahead of the latest-stable tag the install follows), `bun update gbrain`
 * changed nothing, the swap still reported "swapped; exiting for supervisor
 * relaunch", and the relaunched (unchanged) binary recorded the never-installed
 * version known-bad, so the release it later became was never auto-installed.
 *
 * Drives the real `attemptAutopilotSelfUpgrade` and the real `gbrain upgrade
 * --swap-only` (runUpgrade) in spawned drivers on a stock Bun global install
 * of `github:garrytan/gbrain#latest-stable`, then the relaunch's
 * `reconcileSelfUpgradeAtBoot`. Bun resolves child PATH at process start, so
 * the `bun`, `git` and `gbrain` shims sit on the driver's startup PATH (see
 * test/autopilot-bun-floor.test.ts).
 *
 * Protects: the update check reads the published release (the latest-stable
 * tag), never master's VERSION; a swap that installs nothing newer is not a
 * swap (no relaunch, no last_upgrade overwrite, no JUST_UPGRADED breadcrumb,
 * no known-bad) and is retried at most once a day; a version that WAS
 * installed and then failed is still recorded known-bad, under the version
 * actually installed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSemver } from '../src/core/semver.ts';
import { VERSION } from '../src/version.ts';

const REPO = join(import.meta.dir, '..');
const AUTOPILOT_TS = join(REPO, 'src', 'commands', 'autopilot.ts');
const UPGRADE_TS = join(REPO, 'src', 'commands', 'upgrade.ts');
const CLI_EXIT_TS = join(REPO, 'src', 'core', 'cli-force-exit.ts');
const v = parseSemver(VERSION)!;
/** Master's VERSION: stamped by the next PR, not yet tagged or released. */
const MASTER_AHEAD = `${v[0]}.${v[1]}.${v[2] + 1}.0`;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Harness { root: string; home: string; shims: string; argvLog: string; driver: string; bootDriver: string; bunInstall: string }

/**
 * A stock Bun global install following `spec`. `installed` is what `gbrain
 * --version` reports after `bun update` (VERSION = the no-op); `helpExit` is
 * the post-swap smoke's exit (non-zero = the installed release does not start).
 */
function harness(label: string, opts: { spec?: string; cache?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), `gbrain-6828-${label}-`));
  dirs.push(root);
  const home = join(root, 'home');
  const dotG = join(home, '.gbrain');
  mkdirSync(dotG, { recursive: true });
  const hour = new Date().getUTCHours();
  writeFileSync(join(dotG, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(dotG, 'brain.pglite'),
    self_upgrade: { mode: 'auto', quiet_hours: { start: hour, end: (hour + 2) % 24, tz: 'UTC' } },
  }));
  if (opts.cache) writeFileSync(join(dotG, 'last-update-check'), `${opts.cache}\n`);

  const bunInstall = join(root, 'bunhome');
  const globalRoot = join(bunInstall, 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: opts.spec ?? 'github:garrytan/gbrain#latest-stable' } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: { url: 'git+https://github.com/garrytan/gbrain.git' } }));

  const driver = join(pkgDir, 'src', 'cli.ts');
  writeFileSync(driver, [
    'const fetched: string[] = [];',
    'globalThis.fetch = (async (url: unknown) => {',
    '  const u = String(url);',
    '  fetched.push(u);',
    `  if (u.endsWith('/master/VERSION')) return new Response(${JSON.stringify(`${MASTER_AHEAD}\n`)});`,
    `  if (u.endsWith('/latest-stable/VERSION')) return new Response(${JSON.stringify(`${VERSION}\n`)});`,
    "  if (u.endsWith('/package.json')) return new Response(JSON.stringify({ version: process.env.FAKE_TARGET_VERSION, engines: { bun: '>=1.0.0' } }));",
    "  return new Response('', { status: 404 });",
    '}) as typeof fetch;',
    'const realExit = process.exit.bind(process);',
    "process.exit = ((code?: number) => { console.log('FETCHED ' + JSON.stringify(fetched)); console.log('EXIT_CALLED ' + code); realExit(code); }) as typeof process.exit;",
    `const { attemptAutopilotSelfUpgrade } = await import(${JSON.stringify(AUTOPILOT_TS)});`,
    `await attemptAutopilotSelfUpgrade({ kind: 'pglite', db: { query: async () => ({ rows: [] }) } } as never, 'pglite', ${JSON.stringify(join(root, 'autopilot.lock'))});`,
    "console.log('FETCHED ' + JSON.stringify(fetched));",
    "console.log('RETURNED');",
    '',
  ].join('\n'));
  // The supervisor's relaunch: the binary on disk boots and reconciles the breadcrumb.
  const bootDriver = join(pkgDir, 'src', 'boot.ts');
  writeFileSync(bootDriver, `const { reconcileSelfUpgradeAtBoot } = await import(${JSON.stringify(AUTOPILOT_TS)});\nreconcileSelfUpgradeAtBoot();\n`);
  // The real `gbrain upgrade` the channel shells out to, run from inside the global install.
  const upgradeDriver = join(pkgDir, 'src', 'upgrade-driver.ts');
  writeFileSync(upgradeDriver, [
    `const { runUpgrade } = await import(${JSON.stringify(UPGRADE_TS)});`,
    `const { _resetCliExitVerdictForTests, currentExitCode } = await import(${JSON.stringify(CLI_EXIT_TS)});`,
    '_resetCliExitVerdictForTests();',
    "await runUpgrade([...process.argv.slice(2), '--no-bun-floor-check']);",
    'process.exit(currentExitCode());',
    '',
  ].join('\n'));

  const shims = join(root, 'bin');
  mkdirSync(shims);
  const argvLog = join(root, 'argv.log');
  writeFileSync(argvLog, '');
  // `bun update gbrain` on a moving tag whose head is already installed: exit 0, nothing changes.
  writeFileSync(join(shims, 'bun'), [
    '#!/usr/bin/env bash',
    `if [ "$1" = "update" ]; then printf 'bun %s\\n' "$*" >> "${argvLog}"; echo 'Checked 353 installs across 360 packages (no changes) [6.60s]'; exit 0; fi`,
    `echo "${Bun.version}"`,
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(shims, 'git'), `#!/usr/bin/env bash\ncase "$1" in ls-remote) echo "aaa\trefs/tags/v${VERSION}"; exit 0;; esac\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(shims, 'gbrain'), [
    '#!/usr/bin/env bash',
    `printf 'gbrain %s\\n' "$*" >> "${argvLog}"`,
    'case "$1" in',
    '  --version) echo "gbrain ${FAKE_INSTALLED_VERSION}"; exit 0;;',
    '  --help) exit "${FAKE_HELP_EXIT:-0}";;',
    `  upgrade) shift; exec "${process.execPath}" "${upgradeDriver}" "$@";;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return { root, home, shims, argvLog, driver, bootDriver, bunInstall };
}

async function run(h: Harness, script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, script], {
    cwd: h.root,
    env: {
      PATH: `${h.shims}:/usr/bin:/bin`,
      HOME: h.root,
      GBRAIN_HOME: h.home,
      GBRAIN_AUDIT_DIR: join(h.root, 'audit'),
      BUN_INSTALL: h.bunInstall,
      FAKE_INSTALLED_VERSION: VERSION,
      FAKE_TARGET_VERSION: VERSION,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const auditDir = join(h.root, 'audit');
  const audit = existsSync(auditDir)
    ? readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    : [];
  const config = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf8'));
  const cachePath = join(h.home, '.gbrain', 'last-update-check');
  return {
    code, out, err, audit,
    su: config.self_upgrade,
    calls: readFileSync(h.argvLog, 'utf8').split('\n').filter(Boolean),
    fetched: JSON.parse(/FETCHED (.*)/.exec(out)?.[1] ?? '[]') as string[],
    cache: existsSync(cachePath) ? readFileSync(cachePath, 'utf8').trim() : null,
    upgradeState: existsSync(join(h.root, '.gbrain', 'upgrade-state.json')),
    justUpgraded: existsSync(join(h.home, '.gbrain', 'just-upgraded-from')),
  };
}

describe('#6828: auto-update while master is ahead of latest-stable', () => {
  test('the exact field sequence: no unpublished target, no false swap, the next release is not blocklisted', async () => {
    const h = harness('sequence');
    const tick = await run(h, h.driver);
    expect(tick.code, tick.err).toBe(0);
    // The check follows the published release, never master's VERSION.
    expect(tick.fetched.some((u) => u.endsWith('/latest-stable/VERSION'))).toBe(true);
    expect(tick.fetched.some((u) => u.endsWith('/master/VERSION'))).toBe(false);
    expect(tick.cache).toBe(`UP_TO_DATE ${VERSION}`);
    expect(tick.out).toContain('RETURNED');
    expect(tick.out).not.toContain('EXIT_CALLED');
    expect(tick.calls.filter((c) => c.includes('update gbrain') || c.startsWith('gbrain upgrade'))).toEqual([]);
    expect(tick.audit.some((e) => e.reason === 'swapped; exiting for supervisor relaunch')).toBe(false);

    const boot = await run(h, h.bootDriver);
    expect(boot.code, boot.err).toBe(0);
    expect(boot.su.failed_versions).toBeUndefined();
    expect(boot.su.attempting_version).toBeUndefined();
    expect(boot.audit.some((e) => e.outcome === 'failed')).toBe(false);
  }, 90_000);

  test('a swap that installs nothing newer is held: no relaunch, no known-bad, no last_upgrade, retried after a day', async () => {
    // A marker naming a version the install's channel does not have yet (a cache
    // an older binary wrote from master's VERSION, or a tag that moved after the check).
    const h = harness('noop', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(tick.code, tick.err).toBe(0);
    expect(tick.calls).toContain('bun update gbrain');
    expect(tick.out).toContain('RETURNED');
    expect(tick.out).not.toContain('EXIT_CALLED');
    expect(tick.out).not.toContain('Upgrade complete');
    expect(tick.upgradeState).toBe(false);
    expect(tick.justUpgraded).toBe(false);
    expect(tick.su.attempting_version).toBeUndefined();
    expect(tick.su.failed_versions).toBeUndefined();
    expect(typeof tick.su.last_check_ts).toBe('number');
    expect(tick.audit.some((e) => e.reason === 'swapped; exiting for supervisor relaunch')).toBe(false);
    expect(tick.audit.at(-1)).toMatchObject({ channel: 'autopilot', action: 'apply', outcome: 'skipped', latest: MASTER_AHEAD, current: VERSION });
    expect(tick.audit.at(-1).reason).toContain('nothing newer was installed');

    const again = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(again.calls.filter((c) => c === 'bun update gbrain')).toHaveLength(1);
    expect(again.su.failed_versions).toBeUndefined();

    const boot = await run(h, h.bootDriver);
    expect(boot.su.failed_versions).toBeUndefined();
  }, 90_000);

  test('an exact-tag pin in auto mode (bun update keeps the pin) is held, not known-bad', async () => {
    const h = harness('pin', { spec: `github:garrytan/gbrain#v${VERSION}`, cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(tick.out).not.toContain('EXIT_CALLED');
    expect(tick.su.failed_versions).toBeUndefined();
    expect(tick.su.attempting_version).toBeUndefined();
    expect(tick.audit.at(-1)).toMatchObject({ action: 'apply', outcome: 'skipped', latest: MASTER_AHEAD });
  }, 90_000);

  test('a release that was installed and does not start is still known-bad, under the installed version', async () => {
    const h = harness('broken', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD, FAKE_INSTALLED_VERSION: MASTER_AHEAD, FAKE_HELP_EXIT: '1' });
    expect(tick.out).not.toContain('EXIT_CALLED');
    expect(tick.su.failed_versions).toEqual([MASTER_AHEAD]);
    expect(tick.su.attempting_version).toBeUndefined();
    expect(tick.audit.at(-1)).toMatchObject({ action: 'apply', outcome: 'failed', latest: MASTER_AHEAD });
  }, 90_000);

  test('a real swap still exits for relaunch with the breadcrumb on the installed version', async () => {
    const h = harness('real', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD, FAKE_INSTALLED_VERSION: MASTER_AHEAD });
    expect(tick.out).toContain('EXIT_CALLED 0');
    expect(tick.su.attempting_version).toBe(MASTER_AHEAD);
    expect(tick.upgradeState).toBe(true);
    expect(tick.audit.at(-1)).toMatchObject({ action: 'apply', outcome: 'applied', reason: 'swapped; exiting for supervisor relaunch' });
  }, 90_000);
});

describe('#6828 review replays', () => {
  const setConfig = (h: Harness, patch: Record<string, unknown>) => {
    const p = join(h.home, '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    cfg.self_upgrade = { ...cfg.self_upgrade, ...patch };
    writeFileSync(p, JSON.stringify(cfg));
  };

  test('a swap whose receipt cannot be written is confirmed by the installed version: a no-op still holds', async () => {
    const h = harness('no-receipt', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    // A directory where the receipt goes: the swap cannot write it and the channel cannot read one.
    mkdirSync(join(h.home, '.gbrain', 'swap-receipt.json'));
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(tick.calls).toContain('bun update gbrain');
    expect(tick.out).not.toContain('EXIT_CALLED');
    expect(tick.su.attempting_version).toBeUndefined();
    expect(tick.su.failed_versions).toBeUndefined();
    expect(tick.audit.at(-1)).toMatchObject({ action: 'apply', outcome: 'skipped', latest: MASTER_AHEAD });
    const boot = await run(h, h.bootDriver);
    expect(boot.su.failed_versions).toBeUndefined();
  }, 90_000);

  test('the no-op throttle expires after 24 hours', async () => {
    const h = harness('throttle', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    setConfig(h, { last_check_ts: Date.now() - 25 * 60 * 60 * 1000 });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(tick.calls).toContain('bun update gbrain');
    setConfig(h, { last_check_ts: Date.now() - 23 * 60 * 60 * 1000 });
    const held = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD });
    expect(held.calls.filter((c) => c === 'bun update gbrain')).toHaveLength(1);
  }, 90_000);

  test('the version the install would get is checked against known-bad, not only the checked version', async () => {
    const delivered = `${v[0]}.${v[1]}.${v[2] + 2}.0`;
    const h = harness('gate-installed', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    setConfig(h, { failed_versions: [delivered] });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: delivered });
    expect(tick.calls.filter((c) => c === 'bun update gbrain')).toEqual([]);
    expect(tick.audit.at(-1)).toMatchObject({ action: 'known_bad', outcome: 'skipped', latest: MASTER_AHEAD });
    expect(tick.audit.at(-1).reason).toContain(delivered);
  }, 90_000);

  test('a failure under a different installed version throttles and drops the update cache', async () => {
    const delivered = `${v[0]}.${v[1]}.${v[2] + 2}.0`;
    const h = harness('fail-other', { cache: `UPGRADE_AVAILABLE ${VERSION} ${MASTER_AHEAD}` });
    const tick = await run(h, h.driver, { FAKE_TARGET_VERSION: MASTER_AHEAD, FAKE_INSTALLED_VERSION: delivered, FAKE_HELP_EXIT: '1' });
    expect(tick.su.failed_versions).toEqual([delivered]);
    expect(typeof tick.su.last_check_ts).toBe('number');
    expect(tick.cache).toBeNull();
  }, 90_000);
});
