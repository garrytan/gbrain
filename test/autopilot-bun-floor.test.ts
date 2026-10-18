/**
 * #5855: the autopilot self-upgrade channel never swaps in a release the
 * host's Bun cannot start. Drives the real `attemptAutopilotSelfUpgrade` in a
 * spawned driver (Bun resolves child PATH at process start, so the `bun` and
 * `gbrain` shims must be on the driver's startup PATH; see
 * test/upgrade-bun-link-arc.serial.test.ts).
 *
 * Protects: a quiet-hours `apply` on a bun-link clone or a global package is
 * held as `unsupported_runtime` (audited, breadcrumb not written, not
 * known-bad) when the target's floor is above the host Bun or unreadable;
 * a met floor still swaps; a swap that `gbrain upgrade` itself refuses for
 * the floor (exit 78) is a hold, while any other swap failure stays known-bad.
 * Regression: the channel deciding without reading the target's floor (the
 * #5855 crash loop), or recording a floor refusal as a failed version.
 * Existing coverage: test/autopilot-self-upgrade.test.ts reads source text
 * only; this replaces PR #5860's source-regex check with behavior.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.ts';

const AUTOPILOT_TS = join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts');
const TARGET = '99.0.0.0';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const IDENTITY = ['-c', 'user.name=gbrain-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

interface Harness { root: string; home: string; shims: string; argvLog: string }

function harness(label: string): Harness {
  const root = mkdtempSync(join(tmpdir(), `gbrain-ap-floor-${label}-`));
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
  writeFileSync(join(dotG, 'last-update-check'), `UPGRADE_AVAILABLE ${VERSION} ${TARGET}\n`);
  const shims = join(root, 'bin');
  mkdirSync(shims);
  const argvLog = join(root, 'argv.log');
  writeFileSync(argvLog, '');
  writeFileSync(join(shims, 'bun'), '#!/usr/bin/env bash\necho "$FAKE_BUN_VERSION"\n', { mode: 0o755 });
  // #6828: a swap is confirmed by the version it left on disk, so `--version` reports the target (a real swap) and is not logged as a swap call.
  writeFileSync(join(shims, 'gbrain'), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then [ "\${FAKE_GBRAIN_EXIT:-0}" = 0 ] && echo "gbrain ${TARGET}"; exit "\${FAKE_GBRAIN_EXIT:-0}"; fi\nprintf 'gbrain %s\\n' "$*" >> "${argvLog}"\nexit "\${FAKE_GBRAIN_EXIT:-0}"\n`, { mode: 0o755 });
  return { root, home, shims, argvLog };
}

function writeDriver(path: string, h: Harness): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    'const fetched: string[] = [];',
    'globalThis.fetch = (async (url: unknown) => {',
    '  fetched.push(String(url));',
    "  const body = process.env.FAKE_PACKAGE_BODY;",
    "  return body ? new Response(body) : new Response('Not Found', { status: 404 });",
    '}) as typeof fetch;',
    'const realExit = process.exit.bind(process);',
    "process.exit = ((code?: number) => { console.log('FETCHED ' + JSON.stringify(fetched)); console.log('EXIT_CALLED ' + code); realExit(code); }) as typeof process.exit;",
    `const { attemptAutopilotSelfUpgrade } = await import(${JSON.stringify(AUTOPILOT_TS)});`,
    `await attemptAutopilotSelfUpgrade({ kind: 'pglite', db: { query: async () => ({ rows: [] }) } } as never, 'pglite', ${JSON.stringify(join(h.root, 'autopilot.lock'))});`,
    "console.log('FETCHED ' + JSON.stringify(fetched));",
    "console.log('RETURNED');",
    '',
  ].join('\n'));
}

/** A bun-link clone one commit behind an origin whose head pins `floor`. */
function bunLinkInstall(h: Harness, floor: string): string {
  const origin = join(h.root, 'remotes', 'garrytan', 'gbrain');
  mkdirSync(origin, { recursive: true });
  git(['init', '-q', '-b', 'master'], origin);
  writeFileSync(join(origin, 'package.json'), JSON.stringify({ version: '0.0.1.0', engines: { bun: '>=1.4.0' } }));
  git(['add', '-A'], origin);
  git([...IDENTITY, 'commit', '-q', '-m', 'old'], origin);
  const clone = join(h.root, 'clone');
  git(['clone', '-q', origin, clone]);
  writeFileSync(join(origin, 'package.json'), JSON.stringify({ version: TARGET, engines: { bun: floor } }));
  git(['add', '-A'], origin);
  git([...IDENTITY, 'commit', '-q', '-m', 'new'], origin);
  const driver = join(clone, 'src', 'cli.ts');
  writeDriver(driver, h);
  return driver;
}

/** A Bun global install of `github:garrytan/gbrain` with the driver inside node_modules. */
function packageInstall(h: Harness): { driver: string; bunInstall: string } {
  const bunInstall = join(h.root, 'bunhome');
  const globalRoot = join(bunInstall, 'install', 'global');
  mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: 'github:garrytan/gbrain' } }));
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: { url: 'git+https://github.com/garrytan/gbrain.git' } }));
  const driver = join(pkgDir, 'src', 'cli.ts');
  writeDriver(driver, h);
  return { driver, bunInstall };
}

async function tick(h: Harness, driver: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, driver], {
    cwd: h.root,
    env: {
      PATH: `${h.shims}:/usr/bin:/bin`,
      HOME: h.root,
      GBRAIN_HOME: h.home,
      GBRAIN_AUDIT_DIR: join(h.root, 'audit'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const audit = existsSync(join(h.root, 'audit'))
    ? readdirSync(join(h.root, 'audit')).flatMap((f) => readFileSync(join(h.root, 'audit', f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    : [];
  const config = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf8'));
  const fetched = JSON.parse(/FETCHED (.*)/.exec(out)?.[1] ?? '[]') as string[];
  return { code, out, err, audit, su: config.self_upgrade, swaps: readFileSync(h.argvLog, 'utf8').split('\n').filter(Boolean), fetched };
}

function expectHeld(r: Awaited<ReturnType<typeof tick>>, reason: string): void {
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain('RETURNED');
  expect(r.out).not.toContain('EXIT_CALLED');
  expect(r.swaps).toEqual([]);
  expect(r.su.attempting_version).toBeUndefined();
  expect(r.su.failed_versions).toBeUndefined();
  const last = r.audit.at(-1);
  expect(last).toMatchObject({ channel: 'autopilot', action: 'unsupported_runtime', latest: TARGET, outcome: 'skipped' });
  expect(last.reason).toContain(reason);
}

describe('autopilot self-upgrade Bun floor gate (#5855)', () => {
  test('bun-link: the fetched upstream floor above the PATH bun holds the upgrade', async () => {
    const h = harness('link-unmet');
    const r = await tick(h, bunLinkInstall(h, '>=1.4.0'), { FAKE_BUN_VERSION: '1.3.14' });
    expectHeld(r, `gbrain ${TARGET} requires Bun >=1.4.0; bun on PATH is 1.3.14. Fix: bun upgrade, then gbrain upgrade.`);
  }, 60_000);

  test('bun-link: a met floor swaps and exits for relaunch', async () => {
    const h = harness('link-met');
    const r = await tick(h, bunLinkInstall(h, '>=1.4.0'), { FAKE_BUN_VERSION: Bun.version });
    expect(r.out).toContain('EXIT_CALLED 0');
    expect(r.swaps).toEqual(['gbrain upgrade --swap-only']);
    expect(r.su.attempting_version).toBe(TARGET);
  }, 60_000);

  test('package: the floor at the spec ref above the host Bun holds; an unreadable floor holds', async () => {
    const h = harness('pkg');
    const { driver, bunInstall } = packageInstall(h);
    const unmet = await tick(h, driver, { FAKE_BUN_VERSION: Bun.version, BUN_INSTALL: bunInstall, FAKE_PACKAGE_BODY: JSON.stringify({ version: TARGET, engines: { bun: '>=9.9.9' } }) });
    expectHeld(unmet, `gbrain ${TARGET} requires Bun >=9.9.9;`);
    expect(unmet.fetched).toContain('https://raw.githubusercontent.com/garrytan/gbrain/HEAD/package.json');

    const unreadable = await tick(h, driver, { FAKE_BUN_VERSION: Bun.version, BUN_INSTALL: bunInstall, FAKE_PACKAGE_BODY: JSON.stringify({ version: TARGET, engines: { bun: '^1.4.0' } }) });
    expectHeld(unreadable, `Could not read the Bun floor of gbrain ${TARGET}`);
    expect(unreadable.audit.at(-1).reason).toContain('The next quiet-hours tick retries.');
  }, 60_000);

  test('a swap refused by `gbrain upgrade` for the floor is a hold; another swap failure is known-bad', async () => {
    const h = harness('swap-exit');
    const { driver, bunInstall } = packageInstall(h);
    const env = { FAKE_BUN_VERSION: Bun.version, BUN_INSTALL: bunInstall, FAKE_PACKAGE_BODY: JSON.stringify({ version: TARGET, engines: { bun: '>=1.4.0' } }) };
    const held = await tick(h, driver, { ...env, FAKE_GBRAIN_EXIT: '78' });
    expect(held.swaps).toEqual(['gbrain upgrade --swap-only']);
    expect(held.su.attempting_version).toBeUndefined();
    expect(held.su.failed_versions ?? []).toEqual([]);
    expect(held.audit.at(-1)).toMatchObject({ action: 'unsupported_runtime', outcome: 'skipped', latest: TARGET });

    const failed = await tick(h, driver, { ...env, FAKE_GBRAIN_EXIT: '1' });
    expect(failed.su.failed_versions).toEqual([TARGET]);
    expect(failed.audit.at(-1)).toMatchObject({ action: 'apply', outcome: 'failed', latest: TARGET });
  }, 60_000);
});
