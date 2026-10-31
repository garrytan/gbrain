/**
 * E2E: the self-upgrade marker actually fires on a real `gbrain` invocation.
 *
 * This is the load-bearing proof of the "rides invocation frequency" mechanism:
 * spawn a real `bun src/cli.ts <cmd>` with a warm "upgrade available" cache and
 * assert the startup hook prints `UPGRADE_AVAILABLE` on stderr — which is what an
 * agent (Claude Code / Codex / OpenClaw) keys off to run the gbrain-upgrade skill.
 *
 * Carrier command: `config get self_upgrade.mode` — runs the startup hook, needs
 * no DB and no network, exits fast. Every case that reaches the cache check
 * pre-writes a fresh cache, so the hook emits from cache and never spawns the
 * detached `check-update --refresh-cache` network refresh (hermetic). A case
 * without a cache leaks that refresh into the runner's HOME (scripts/run-e2e.sh
 * then cannot remove the file's home).
 *
 * The child is spawned with NODE_ENV unset (the production code gates the hook
 * off under NODE_ENV=test to keep the unit suite from spawning refreshers).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../../src/version.ts';
import { writeChannelCache } from '../helpers/update-cache.ts';

let home: string;
let gbrainDir: string;
const repoRoot = process.cwd();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-marker-'));
  gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCache(line: string): void {
  writeChannelCache(gbrainDir, line, { channel: 'stable' }); // checked_at = now → fresh; stable is the default channel
}

function runGbrain(mode: string | undefined): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.NODE_ENV; // un-gate the startup hook (production code skips it under test)
  delete env.GBRAIN_SKIP_STARTUP_HOOKS;
  env.GBRAIN_HOME = home;
  if (mode === undefined) delete env.GBRAIN_SELF_UPGRADE_MODE;
  else env.GBRAIN_SELF_UPGRADE_MODE = mode;
  const r = Bun.spawnSync(['bun', 'src/cli.ts', 'config', 'get', 'self_upgrade.mode'], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    code: r.exitCode ?? -1,
  };
}

describe('self-upgrade marker on a real invocation', () => {
  test('notify mode + fresh upgrade_available cache → emits UPGRADE_AVAILABLE on stderr', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    const { stderr } = runGbrain('notify');
    expect(stderr).toContain(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    expect(stderr).not.toContain('Run: gbrain self-upgrade');
  });

  test('#7147: one banner per window across calls; a newer latest prints again at once', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    const banners = (stderr: string) => stderr.split('\n').filter(line => line.startsWith('UPGRADE_AVAILABLE') || line.includes('available. Run: gbrain self-upgrade'));
    expect(banners(runGbrain('notify').stderr)).toEqual([`UPGRADE_AVAILABLE ${VERSION} 0.99.0`]);
    expect(banners(runGbrain('notify').stderr)).toEqual([]);
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.1`);
    expect(banners(runGbrain('notify').stderr)).toEqual([`UPGRADE_AVAILABLE ${VERSION} 0.99.1`]);
  });

  test('off mode → no marker (update checks disabled)', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    const { stderr } = runGbrain('off');
    expect(stderr).not.toContain('UPGRADE_AVAILABLE');
  });

  test('up_to_date cache → no marker', () => {
    writeCache(`UP_TO_DATE ${VERSION}`);
    const { stderr } = runGbrain('notify');
    expect(stderr).not.toContain('UPGRADE_AVAILABLE');
  });

  test('cache latest == running version → suppressed (no marker, no human sentence)', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} ${VERSION}`);
    const { stderr } = runGbrain('notify');
    expect(stderr).not.toContain('UPGRADE_AVAILABLE');
    expect(stderr).not.toContain('Run: gbrain self-upgrade');
  });

  test('foreign-writer cache → marker prints the RUNNING version, not the writer\'s', () => {
    // An older gbrain on PATH wrote the cache: marker.current is 0.0.1, not us.
    writeCache('UPGRADE_AVAILABLE 0.0.1 0.99.0');
    const { stderr } = runGbrain('notify');
    expect(stderr).toContain(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    expect(stderr).not.toContain('UPGRADE_AVAILABLE 0.0.1');
  });

  test('active snooze for the version → no marker (notify mode honors snooze)', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    const now = Date.now();
    writeFileSync(join(gbrainDir, 'update-snoozed.stable.json'), JSON.stringify({ version: '0.99.0', level: 1, ts: now, until: now + 86_400_000 }) + '\n');
    const { stderr } = runGbrain('notify');
    expect(stderr).not.toContain('UPGRADE_AVAILABLE');
  });

  test('GBRA-224: a legacy unpartitioned cache is never read, and the one-time channel notice prints once', () => {
    writeFileSync(join(gbrainDir, 'last-update-check'), `UPGRADE_AVAILABLE ${VERSION} 0.99.0\n`);
    writeChannelCache(gbrainDir, `UP_TO_DATE ${VERSION}`, { channel: 'stable' });
    const first = runGbrain('notify').stderr;
    expect(first).not.toContain('UPGRADE_AVAILABLE');
    expect(first.split('\n').filter(l => l.startsWith('[gbrain notice release_channel]'))).toHaveLength(1);
    expect(first).toContain('gbrain config set self_upgrade.channel alpha');
    expect(runGbrain('notify').stderr).not.toContain('[gbrain notice release_channel]');
  });

  test('JUST_UPGRADED breadcrumb → one-time confirmation on stderr, then cleared', () => {
    writeCache(`UP_TO_DATE ${VERSION}`);
    const breadcrumb = join(gbrainDir, 'just-upgraded-from');
    writeFileSync(breadcrumb, '0.42.0\n');
    const { stderr } = runGbrain('notify');
    expect(stderr).toContain(`JUST_UPGRADED 0.42.0 ${VERSION}`);
    expect(existsSync(breadcrumb)).toBe(false); // consumed
  });

  test('--quiet suppresses the marker', () => {
    writeCache(`UPGRADE_AVAILABLE ${VERSION} 0.99.0`);
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.NODE_ENV;
    env.GBRAIN_HOME = home;
    env.GBRAIN_SELF_UPGRADE_MODE = 'notify';
    const r = Bun.spawnSync(['bun', 'src/cli.ts', '--quiet', 'config', 'get', 'self_upgrade.mode'], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(r.stderr.toString()).not.toContain('UPGRADE_AVAILABLE');
  });
});
