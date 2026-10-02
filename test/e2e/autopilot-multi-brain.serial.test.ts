/**
 * #5195 — two brains on one host each get their own autopilot job, on every
 * install target, end to end.
 *
 * Before the fix every brain installed under one shared name
 * (`com.gbrain.autopilot`, `gbrain-autopilot.service`, `~/.gbrain/start-autopilot.sh`,
 * one unmarked crontab line), so a second brain's install replaced the first
 * brain's job, logs interleaved in `~/.gbrain/autopilot.log`, and either
 * brain's uninstall removed the shared job.
 *
 * Hermetic like test/e2e/autopilot-linux-lifecycle.serial.test.ts: `crontab`,
 * `systemctl` and `launchctl` are PATH shims in a tempdir (crontab round-trips
 * a state file; the others record argv), HOME is a temp root, and each brain
 * is a GBRAIN_HOME under it with a hand-seeded keyless PGLite config. The CLI
 * is SPAWNED (Bun's execSync snapshots env at startup, #2747). The macos
 * target is forced with `--target macos`, so its plist arm runs on Linux too.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let root: string;
let home: string;
let repoDir: string;
let shimDir: string;
let cronState: string;
let sysctlLog: string;
let launchctlLog: string;
let baseEnv: Record<string, string>;

const FOREIGN = "*/10 * * * *  /usr/local/bin/backup.sh --label 'nightly  backup' # keep me\n";

function shim(name: string, body: string): void {
  writeFileSync(join(shimDir, name), body);
  chmodSync(join(shimDir, name), 0o755);
}

function seedBrain(gbrainHome: string): void {
  const dir = join(gbrainHome, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(dir, 'brain.pglite'),
    embedding_disabled: true,
  }) + '\n');
}

function run(gbrainHome: string | null, args: string[]): { status: number | null; out: string } {
  const env = { ...baseEnv };
  if (gbrainHome) env.GBRAIN_HOME = gbrainHome;
  const r = spawnSync(process.execPath, ['run', CLI, 'autopilot', ...args], {
    cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 120_000, killSignal: 'SIGKILL',
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function install(gbrainHome: string | null, target: string): { status: number | null; out: string } {
  return run(gbrainHome, ['--install', '--force', '--target', target, '--repo', repoDir]);
}

function status(gbrainHome: string | null): Record<string, any> {
  const r = run(gbrainHome, ['--status', '--json']);
  const line = r.out.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop();
  if (!line) throw new Error(`no status JSON:\n${r.out}`);
  return JSON.parse(line);
}

function suffixOf(gbrainHome: string): string {
  return JSON.parse(readFileSync(join(gbrainHome, '.gbrain', 'autopilot-install-id'), 'utf-8')).id.slice(0, 8);
}

const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean) : []);
const unitDir = () => join(home, '.config', 'systemd', 'user');
const agentsDir = () => join(home, 'Library', 'LaunchAgents');

let brainA: string;
let brainB: string;
let brainC: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5195-e2e-')));
  home = join(root, 'home');
  repoDir = join(root, 'repo');
  shimDir = join(root, 'shims');
  cronState = join(root, 'cron-state.txt');
  sysctlLog = join(root, 'systemctl.log');
  launchctlLog = join(root, 'launchctl.log');
  for (const d of [home, repoDir, shimDir]) mkdirSync(d, { recursive: true });
  shim('crontab', `#!/bin/sh
if [ "$1" = "-l" ]; then if [ -f '${cronState}' ]; then cat '${cronState}'; exit 0; else exit 1; fi; fi
cat "$1" > '${cronState}'
`);
  shim('systemctl', `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sysctlLog}'\nexit 0\n`);
  shim('launchctl', `#!/bin/sh\nprintf '%s\\n' "$*" >> '${launchctlLog}'\nexit 0\n`);
  shim('gbrain', '#!/bin/sh\nexit 0\n');
  writeFileSync(cronState, FOREIGN);
  baseEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) baseEnv[k] = v;
  Object.assign(baseEnv, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
  });
  for (const k of ['GBRAIN_HOME', 'GBRAIN_AUTOPILOT_LABEL', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'OPENCLAW_HOME',
    'VOYAGE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME']) {
    delete baseEnv[k];
  }
  brainA = join(root, 'brain-a');
  brainB = join(root, 'brain-b');
  brainC = join(root, 'brain-c');
  for (const b of [brainA, brainB, brainC]) seedBrain(b);
  seedBrain(home);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('#5195 two brains on one host keep separate autopilot jobs', () => {
  test('linux-cron: two marked lines, per-brain logs; uninstall removes only its own line', () => {
    expect(install(brainA, 'linux-cron').status).toBe(0);
    expect(install(brainB, 'linux-cron').status).toBe(0);
    const sa = suffixOf(brainA);
    const sb = suffixOf(brainB);
    expect(sa).not.toBe(sb);
    const table = readFileSync(cronState, 'utf-8');
    expect(table.startsWith(FOREIGN)).toBe(true);
    expect(table).toContain(`*/5 * * * * '${brainA}/.gbrain/autopilot-run.sh' >> '${brainA}/.gbrain/autopilot.log' 2>&1 # gbrain-autopilot:${sa}`);
    expect(table).toContain(`*/5 * * * * '${brainB}/.gbrain/autopilot-run.sh' >> '${brainB}/.gbrain/autopilot.log' 2>&1 # gbrain-autopilot:${sb}`);

    // A reinstall of A keeps one line for A (the existence check is per brain).
    const again = install(brainA, 'linux-cron');
    expect(again.out).toContain('Crontab entry already exists');
    expect(readFileSync(cronState, 'utf-8')).toBe(table);

    const sA = status(brainA);
    expect(sA.installed).toBe(true);
    expect(sA.install_target).toBe('linux-cron');
    expect(sA.job.suffix).toBe(sa);
    expect(sA.job.cron_marker).toBe(`# gbrain-autopilot:${sa}`);
    expect(sA.job.install_id_path).toBe(join(brainA, '.gbrain', 'autopilot-install-id'));
    expect(sA.job.log_path).toBe(join(brainA, '.gbrain', 'autopilot.log'));
    expect(sA.job.wrapper_path).toBe(join(brainA, '.gbrain', 'autopilot-run.sh'));

    expect(run(brainA, ['--uninstall']).status).toBe(0);
    const after = readFileSync(cronState, 'utf-8');
    expect(after).not.toContain(`gbrain-autopilot:${sa}`);
    expect(after).toContain(`gbrain-autopilot:${sb}`);
    expect(after.startsWith(FOREIGN)).toBe(true);
    expect(status(brainA).installed).toBe(false);
    expect(status(brainB).installed).toBe(true);
    expect(run(brainB, ['--uninstall']).status).toBe(0);
    expect(readFileSync(cronState, 'utf-8').trim()).toBe(FOREIGN.trim());
  }, 240_000);

  test('linux-systemd: two units, each logs under its own brain; uninstall disables only its unit', () => {
    rmSync(sysctlLog, { force: true });
    expect(install(brainA, 'linux-systemd').status).toBe(0);
    expect(install(brainB, 'linux-systemd').status).toBe(0);
    const ua = `gbrain-autopilot-${suffixOf(brainA)}.service`;
    const ub = `gbrain-autopilot-${suffixOf(brainB)}.service`;
    expect(readdirSync(unitDir()).sort()).toEqual([ua, ub].sort());
    const unitA = readFileSync(join(unitDir(), ua), 'utf-8');
    expect(unitA).toContain(`ExecStart=${brainA}/.gbrain/autopilot-run.sh`);
    expect(unitA).toContain(`StandardOutput=append:${brainA}/.gbrain/autopilot.log`);
    expect(lines(sysctlLog)).toContain(`--user enable --now ${ua}`);
    expect(lines(sysctlLog)).toContain(`--user enable --now ${ub}`);
    expect(readFileSync(join(brainA, '.gbrain', 'autopilot-run.sh'), 'utf-8')).toContain(`systemctl --user disable --now ${ua}`);

    const sB = status(brainB);
    expect(sB.install_target).toBe('linux-systemd');
    expect(sB.job.systemd_unit).toBe(ub);

    rmSync(sysctlLog, { force: true });
    expect(run(brainA, ['--uninstall']).status).toBe(0);
    expect(existsSync(join(unitDir(), ua))).toBe(false);
    expect(existsSync(join(unitDir(), ub))).toBe(true);
    expect(lines(sysctlLog)).toEqual([`--user disable --now ${ua}`, '--user daemon-reload']);
    expect(run(brainB, ['--uninstall']).status).toBe(0);
  }, 240_000);

  test('ephemeral-container: one start script per brain, inside that brain', () => {
    expect(install(brainA, 'ephemeral-container').status).toBe(0);
    expect(install(brainB, 'ephemeral-container').status).toBe(0);
    const scriptA = join(brainA, '.gbrain', `start-autopilot-${suffixOf(brainA)}.sh`);
    const scriptB = join(brainB, '.gbrain', `start-autopilot-${suffixOf(brainB)}.sh`);
    expect(readFileSync(scriptA, 'utf-8')).toContain(`nohup '${brainA}/.gbrain/autopilot-run.sh' > '${brainA}/.gbrain/autopilot.log' 2>&1 &`);
    expect(readFileSync(scriptB, 'utf-8')).toContain(`> '${brainB}/.gbrain/autopilot.log'`);
    expect(existsSync(join(home, '.gbrain', 'start-autopilot.sh'))).toBe(false);
    expect(status(brainA).install_target).toBe('ephemeral-container');
    expect(run(brainA, ['--uninstall']).status).toBe(0);
    expect(existsSync(scriptA)).toBe(false);
    expect(existsSync(scriptB)).toBe(true);
    expect(run(brainB, ['--uninstall']).status).toBe(0);
  }, 240_000);

  test('macos (launchd): one plist per brain label; uninstall unloads only its own', () => {
    rmSync(launchctlLog, { force: true });
    expect(install(brainA, 'macos').status).toBe(0);
    expect(install(brainB, 'macos').status).toBe(0);
    const la = `com.gbrain.autopilot.${suffixOf(brainA)}`;
    const lb = `com.gbrain.autopilot.${suffixOf(brainB)}`;
    expect(readdirSync(agentsDir()).sort()).toEqual([`${la}.plist`, `${lb}.plist`].sort());
    const plistA = readFileSync(join(agentsDir(), `${la}.plist`), 'utf-8');
    expect(plistA).toContain(`<key>Label</key><string>${la}</string>`);
    expect(plistA).toContain(`<key>StandardOutPath</key><string>${brainA}/.gbrain/autopilot.log</string>`);
    expect(lines(launchctlLog)).toContain(`load ${join(agentsDir(), `${lb}.plist`)}`);
    expect(readFileSync(join(brainA, '.gbrain', 'autopilot-run.sh'), 'utf-8')).toContain(`gui/$(id -u)/${la}`);

    expect(run(brainA, ['--uninstall']).status).toBe(0);
    expect(existsSync(join(agentsDir(), `${la}.plist`))).toBe(false);
    expect(existsSync(join(agentsDir(), `${lb}.plist`))).toBe(true);
    expect(run(brainB, ['--uninstall']).status).toBe(0);
  }, 240_000);
});

describe('#5195 legacy shared-name jobs and moved brains', () => {
  test('status flags a legacy shared unit that runs this brain; install replaces it and says so', () => {
    mkdirSync(unitDir(), { recursive: true });
    mkdirSync(join(brainC, '.gbrain'), { recursive: true });
    writeFileSync(join(brainC, '.gbrain', 'autopilot-run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(unitDir(), 'gbrain-autopilot.service'), `[Unit]\nDescription=GBrain Autopilot\n[Service]\nExecStart=${brainC}/.gbrain/autopilot-run.sh\n`);

    const before = status(brainC);
    expect(before.installed).toBe(true);
    expect(before.job.needs_reinstall).toBe('legacy_shared_job');
    expect(before.job.installed_definition.legacy_shared_name).toBe(true);
    // The default brain does not claim a shared job that runs another live brain.
    const defaultView = status(null);
    expect(defaultView.installed).toBe(false);
    expect(defaultView.job.shared_job_of_other_brain.home).toBe(join(brainC, '.gbrain'));
    // ...and its uninstall leaves that job alone, naming the right command.
    const defaultUninstall = run(null, ['--uninstall']);
    expect(defaultUninstall.out).toContain(`GBRAIN_HOME='${brainC}' gbrain autopilot --uninstall`);
    expect(existsSync(join(unitDir(), 'gbrain-autopilot.service'))).toBe(true);
    // ...and its install refuses rather than taking that brain's job over.
    const refused = install(null, 'linux-systemd');
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('autopilot job gbrain-autopilot.service runs the brain at');
    expect(refused.out).toContain(`GBRAIN_HOME='${brainC}' gbrain autopilot --install`);

    const r = install(brainC, 'linux-systemd');
    expect(r.status).toBe(0);
    expect(r.out).toContain('Replaced the shared systemd unit gbrain-autopilot.service, which ran this brain');
    expect(existsSync(join(unitDir(), 'gbrain-autopilot.service'))).toBe(false);
    expect(existsSync(join(unitDir(), `gbrain-autopilot-${suffixOf(brainC)}.service`))).toBe(true);
    expect(status(brainC).job.needs_reinstall).toBeNull();
    expect(run(brainC, ['--uninstall']).status).toBe(0);
  }, 240_000);

  test('a pre-upgrade brain with no install id still sees and removes its legacy shared launchd job', () => {
    const brainD = join(root, 'brain-d');
    seedBrain(brainD);
    writeFileSync(join(brainD, '.gbrain', 'autopilot-run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(agentsDir(), { recursive: true });
    const plist = join(agentsDir(), 'com.gbrain.autopilot.plist');
    writeFileSync(plist, `<plist><dict><key>Label</key><string>com.gbrain.autopilot</string><key>ProgramArguments</key><array>\n    <string>${brainD}/.gbrain/autopilot-run.sh</string>\n  </array></dict></plist>`);
    expect(existsSync(join(brainD, '.gbrain', 'autopilot-install-id'))).toBe(false);
    rmSync(launchctlLog, { force: true });
    const r = run(brainD, ['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Removed launchd service: com.gbrain.autopilot');
    expect(existsSync(plist)).toBe(false);
    expect(lines(launchctlLog)).toContain(`unload ${plist}`);
  }, 120_000);

  test('an unmarked legacy crontab line naming this brain is replaced by its marked line', () => {
    const legacy = `*/5 * * * * '${brainC}/.gbrain/autopilot-run.sh' >> '${home}/.gbrain/autopilot.log' 2>&1`;
    writeFileSync(cronState, FOREIGN + legacy + '\n');
    expect(status(brainC).job.needs_reinstall).toBe('legacy_shared_job');
    const r = install(brainC, 'linux-cron');
    expect(r.status).toBe(0);
    const table = readFileSync(cronState, 'utf-8');
    expect(table).not.toContain(legacy);
    expect(table).toContain(`# gbrain-autopilot:${suffixOf(brainC)}`);
    expect(table.split('\n').filter(l => l.includes('autopilot-run.sh'))).toHaveLength(1);
    expect(run(brainC, ['--uninstall']).status).toBe(0);
    expect(readFileSync(cronState, 'utf-8').trim()).toBe(FOREIGN.trim());
  }, 240_000);

  test('mv keeps one job: status flags the missing wrapper, reinstall repoints the same job', () => {
    expect(install(brainB, 'linux-cron').status).toBe(0);
    const sb = suffixOf(brainB);
    const moved = join(root, 'brain-b-moved');
    renameSync(brainB, moved);
    // The seeded config names its PGLite file by absolute path; repoint it, or
    // the install's engine connect would recreate the old directory (which
    // would then read as a copy, correctly, and mint a new id).
    seedBrain(moved);
    const s = status(moved);
    expect(s.installed).toBe(true);
    expect(s.job.suffix).toBe(sb);
    expect(s.job.needs_reinstall).toBe('wrapper_missing');
    expect(s.job.installed_definition.wrapper_exists).toBe(false);

    expect(install(moved, 'linux-cron').status).toBe(0);
    expect(suffixOf(moved)).toBe(sb);
    const table = readFileSync(cronState, 'utf-8');
    const own = table.split('\n').filter(l => l.includes(`gbrain-autopilot:${sb}`));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain(`'${moved}/.gbrain/autopilot-run.sh'`);
    expect(status(moved).job.needs_reinstall).toBeNull();
    expect(run(moved, ['--uninstall']).status).toBe(0);
  }, 240_000);

  test('cp -r gives the copy its own job; the original keeps its own', () => {
    expect(install(brainA, 'linux-cron').status).toBe(0);
    const copy = join(root, 'brain-a-copy');
    spawnSync('cp', ['-r', brainA, copy]);
    expect(status(copy).installed).toBe(false);
    expect(install(copy, 'linux-cron').status).toBe(0);
    expect(suffixOf(copy)).not.toBe(suffixOf(brainA));
    const autopilotLines = readFileSync(cronState, 'utf-8').split('\n').filter(l => l.includes('autopilot-run.sh'));
    expect(autopilotLines).toHaveLength(2);
    expect(run(copy, ['--uninstall']).status).toBe(0);
    expect(status(brainA).installed).toBe(true);
    expect(run(brainA, ['--uninstall']).status).toBe(0);
  }, 240_000);
});
